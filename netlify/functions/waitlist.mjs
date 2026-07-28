import { getStore } from '@netlify/blobs'

// Hot Spots waitlist backend.
// POST ?action=submit  { email, phone, cta_location, hp }  -> stores the lead. If a texting
//   provider (Twilio) is configured, texts a 6-digit code and asks the client to verify.
// POST ?action=verify  { phone, code }                     -> confirms the code, marks verified.
// GET  ?action=list&key=... (admin)                        -> returns all captured leads as JSON.
// GET  ?action=export&key=... (admin)                      -> returns all leads as CSV.

import { timingSafeEqual } from 'node:crypto'

// Public actions (submit/verify) can be called cross-origin from the onboarding flow,
// so they carry CORS. Admin actions use ajson (no CORS) so a malicious page can never
// read the lead roster cross-origin, even with a key.
const PUBLIC_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-admin-key',
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...PUBLIC_CORS } })
const ajson = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

// Admin auth: fail CLOSED if no key is configured, accept the key from a header or the
// query string, and compare in constant time so it can't be recovered by timing.
function adminOk(url, req) {
  const secret = process.env.WAITLIST_ADMIN_KEY
  if (!secret) return false
  const given = req.headers.get('x-admin-key') || url.searchParams.get('key') || ''
  const a = Buffer.from(String(given))
  const b = Buffer.from(String(secret))
  return a.length === b.length && timingSafeEqual(a, b)
}

// Prefix cells Excel/Sheets would execute as a formula, so an injected =HYPERLINK/cmd
// payload in a stored field can't run when the exported CSV is opened.
const csvCell = (c) => {
  let s = String(c == null ? '' : c)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return `"${s.replace(/"/g, '""')}"`
}

const isGcu = (e) => /@(my\.)?gcu\.edu$/i.test(String(e || '').trim())
// Every accredited US university email domain (2,393), for campus-by-campus expansion.
import UNI from './uni-domains.json' with { type: 'json' }
function schoolFor(email) {
  const dom = String(email || '').toLowerCase().split('@')[1] || ''
  if (/(^|\.)gcu\.edu$/.test(dom)) return { slug: 'gcu', name: 'Grand Canyon University' }
  // match the domain or any registered parent (students often use sub-domains like my.asu.edu)
  const parts = dom.split('.')
  for (let i = 0; i < parts.length - 1; i++) {
    const cand = parts.slice(i).join('.')
    if (UNI[cand]) return { slug: cand.replace(/\.edu$/, '').replace(/\W+/g, '-'), name: UNI[cand] }
  }
  return null
}
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(e || '').trim())
const digits = (p) => String(p || '').replace(/\D/g, '')
const e164 = (p) => {
  const d = digits(p)
  if (String(p).trim().startsWith('+')) return '+' + d
  return d.length === 10 ? '+1' + d : '+' + d
}
const code6 = () => String(Math.floor(100000 + Math.random() * 900000))

function twilioReady() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM)
}
async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const tok = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_FROM
  if (!sid || !tok || !from) return { sent: false }
  const params = new URLSearchParams({ To: to, From: from, Body: body })
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })
  return { sent: r.ok, status: r.status }
}

// Emails each new signup to the DartyForLife inbox, tagged "Hot Spots CVC" in the subject
// so a Gmail filter can auto-label it. Dormant until RESEND_API_KEY is set.
async function notify(rec) {
  const key = process.env.RESEND_API_KEY
  if (!key) return
  const to = process.env.NOTIFY_EMAIL || 'dartyforlife@gmail.com'
  const from = process.env.RESEND_FROM || 'Hot Spots Waitlist <onboarding@resend.dev>'
  const subject = `Hot Spots CVC | new signup: ${rec.email}`
  const html =
    '<h2 style="font-family:sans-serif">New Hot Spots waitlist signup</h2>' +
    '<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">' +
    `<tr><td style="padding:2px 10px 2px 0"><b>Email</b></td><td>${rec.email}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0"><b>Phone</b></td><td>${rec.phone}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0"><b>GCU</b></td><td>${rec.school === 'gcu' ? 'Yes, founding member' : 'No, general list'}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0"><b>Phone verified</b></td><td>${rec.verified ? 'Yes' : 'Not yet'}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0"><b>Source</b></td><td>${rec.cta || 'n/a'}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0"><b>When</b></td><td>${rec.ts}</td></tr>` +
    '</table><p style="color:#888;font-family:sans-serif;font-size:12px">Category: Hot Spots CVC</p>'
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    })
  } catch (e) {}
}

function welcomeMsg(rec) {
  return rec.school === 'gcu'
    ? "You're on the Hot Spots waitlist and locked in as a founding member. We'll text you the moment your invite is ready. See where everyone's at."
    : "You're on the Hot Spots general list. GCU students get in first, and we'll text you when your campus unlocks."
}

async function readBody(req) {
  const ct = req.headers.get('content-type') || ''
  if (ct.includes('application/json')) return await req.json().catch(() => ({}))
  const t = await req.text()
  return Object.fromEntries(new URLSearchParams(t))
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: PUBLIC_CORS })
  const url = new URL(req.url)
  const action = url.searchParams.get('action')

  let store
  try {
    store = getStore('waitlist')
  } catch (e) {
    return json({ ok: false, error: 'store-unavailable' }, 500)
  }

  // SUBMIT
  if (req.method === 'POST' && action === 'submit') {
    const d = await readBody(req)
    if (d.hp) return json({ ok: true }) // honeypot filled, silently drop the bot
    // Per-IP throttle so the endpoint can't be scripted to mass-inject leads or burn SMS
    const ip = req.headers.get('x-nf-client-connection-ip')
      || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown'
    const rlKey = `rl:${ip}:${new Date().toISOString().slice(0, 13)}` // per hour
    const rl = (await store.get(rlKey, { type: 'json' })) || { n: 0 }
    if (rl.n >= 20) return json({ ok: false, error: 'rate-limited' }, 429)
    await store.setJSON(rlKey, { n: rl.n + 1 })
    const email = String(d.email || '').trim()
    const phone = String(d.phone || '').trim()
    if (!validEmail(email)) return json({ ok: false, error: 'bad-email' }, 400)
    if (digits(phone).length < 10) return json({ ok: false, error: 'bad-phone' }, 400)

    const uni = schoolFor(email)
    if (!uni) return json({ ok: false, error: 'not-university' }, 400) // real school emails only
    const rec = {
      email,
      phone: e164(phone),
      school: uni.slug,
      schoolName: uni.name,
      cta: String(d.cta_location || ''),
      ts: new Date().toISOString(),
    }

    if (twilioReady()) {
      const code = code6()
      await store.setJSON(`pending:${e164(phone)}`, {
        ...rec,
        code,
        expires: Date.now() + 10 * 60 * 1000,
        attempts: 0,
      })
      const sms = await sendSms(e164(phone), `Your Hot Spots verification code is ${code}. It expires in 10 minutes.`)
      return json({ ok: true, needCode: true, sent: sms.sent })
    }

    // No texting provider yet: capture now as phone-unverified so no contact is lost.
    const lead = { ...rec, verified: false }
    await store.setJSON(`lead:${Date.now()}:${e164(phone)}`, lead)
    await notify(lead)
    return json({ ok: true, needCode: false, captured: true })
  }

  // VERIFY
  if (req.method === 'POST' && action === 'verify') {
    const d = await readBody(req)
    const phone = e164(String(d.phone || ''))
    const code = String(d.code || '').trim()
    const pend = await store.get(`pending:${phone}`, { type: 'json' })
    if (!pend) return json({ ok: false, error: 'no-pending' }, 400)
    if (Date.now() > pend.expires) {
      await store.delete(`pending:${phone}`)
      return json({ ok: false, error: 'expired' }, 400)
    }
    if ((pend.attempts || 0) >= 5) {
      await store.delete(`pending:${phone}`)
      return json({ ok: false, error: 'too-many' }, 429)
    }
    if (String(pend.code) !== code) {
      await store.setJSON(`pending:${phone}`, { ...pend, attempts: (pend.attempts || 0) + 1 })
      return json({ ok: false, error: 'bad-code' }, 400)
    }
    const vlead = { email: pend.email, phone, school: pend.school, cta: pend.cta, ts: pend.ts, verified: true }
    await store.setJSON(`lead:${Date.now()}:${phone}`, vlead)
    await store.delete(`pending:${phone}`)
    await notify(vlead)
    // No immediate welcome text: the drip sends the processing/position and acceptance texts on a delay.
    return json({ ok: true, verified: true })
  }

  // ADMIN: list / export
  if (req.method === 'GET' && (action === 'list' || action === 'export')) {
    if (!adminOk(url, req)) return ajson({ ok: false }, 401)
    const { blobs } = await store.list({ prefix: 'lead:' })
    const leads = []
    for (const b of blobs) {
      const v = await store.get(b.key, { type: 'json' })
      if (v) leads.push(v)
    }
    leads.sort((a, b) => (a.ts < b.ts ? 1 : -1))
    if (action === 'export') {
      const rows = [['email', 'phone', 'school', 'verified', 'accepted', 'cta', 'ts']]
      leads.forEach((l) => rows.push([l.email, l.phone, l.school, l.verified, l.accepted || false, l.cta, l.ts]))
      const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n')
      return new Response(csv, { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=hotspots-waitlist.csv' } })
    }
    return ajson({ ok: true, count: leads.length, provider: twilioReady() ? 'sms-on' : 'capture-only', leads })
  }

  // ADMIN: clear all leads (reset)
  if (req.method === 'POST' && action === 'clear') {
    if (!adminOk(url, req)) return ajson({ ok: false }, 401)
    let n = 0
    const leads = await store.list({ prefix: 'lead:' })
    for (const b of leads.blobs) { await store.delete(b.key); n++ }
    const pend = await store.list({ prefix: 'pending:' })
    for (const b of pend.blobs) { await store.delete(b.key); n++ }
    const cnt = await store.list({ prefix: 'accepted_count:' })
    for (const b of cnt.blobs) { await store.delete(b.key) }
    return ajson({ ok: true, cleared: n })
  }

  // ADMIN: accept people and text them "you're in". POST {phone} for one, or {all:true} for everyone not yet accepted.
  if (req.method === 'POST' && action === 'accept') {
    if (!adminOk(url, req)) return ajson({ ok: false }, 401)
    const d = await readBody(req)
    const target = d.phone ? e164(String(d.phone)) : null
    const all = !!d.all
    if (!target && !all) return json({ ok: false, error: 'need-phone-or-all' }, 400)
    const { blobs } = await store.list({ prefix: 'lead:' })
    let accepted = 0
    let texted = 0
    for (const b of blobs) {
      const v = await store.get(b.key, { type: 'json' })
      if (!v) continue
      const match = all ? !v.accepted : v.phone === target
      if (!match) continue
      v.accepted = true
      v.acceptedAt = new Date().toISOString()
      await store.setJSON(b.key, v)
      accepted++
      const sms = await sendSms(
        v.phone,
        "You're in. Hot Spots just accepted you at GCU. Open the app and start crossing paths: https://closer-gcu.netlify.app"
      )
      if (sms.sent) texted++
    }
    return ajson({ ok: true, accepted, texted, sms: twilioReady() ? 'on' : 'off, add Twilio to text them' })
  }

  // CRON + ADMIN: one drip pass. Texts a processing/position update at PROCESSING_DELAY_MIN,
  // then accepts eligible leads (oldest first) at ACCEPT_DELAY_MIN, capped at DAILY_ACCEPT_CAP per day.
  if (action === 'drip') {
    if (!adminOk(url, req)) return ajson({ ok: false }, 401)
    const fast = url.searchParams.get('fast') // test override: treat delays as 0
    const PROC_MIN = fast ? 0 : Number(process.env.PROCESSING_DELAY_MIN || 60)
    const ACC_MIN = fast ? 0 : Number(process.env.ACCEPT_DELAY_MIN || 120)
    const CAP = Number(url.searchParams.get('cap') || process.env.DAILY_ACCEPT_CAP || 100)
    const now = Date.now()
    const today = new Date().toISOString().slice(0, 10)
    const countKey = `accepted_count:${today}`
    const cObj = await store.get(countKey, { type: 'json', consistency: 'strong' })
    let acceptedToday = (cObj && cObj.n) || 0

    const { blobs } = await store.list({ prefix: 'lead:' })
    const leads = []
    for (const b of blobs) {
      const v = await store.get(b.key, { type: 'json' })
      if (v) leads.push({ k: b.key, d: v })
    }
    leads.sort((a, b) => (a.d.ts < b.d.ts ? -1 : 1)) // FIFO, oldest signup first
    const pending = leads.filter((x) => !x.d.accepted)

    let processed = 0
    for (let i = 0; i < pending.length; i++) {
      const { k, d } = pending[i]
      const ageMin = (now - Date.parse(d.ts)) / 60000
      if (!d.procTexted && ageMin >= PROC_MIN) {
        d.procTexted = true
        await store.setJSON(k, d)
        await sendSms(d.phone, `Hot Spots is reviewing your account. You are about number ${i + 1} in line at GCU. We'll text you the moment you're in.`)
        processed++
      }
    }

    let accepted = 0
    for (const { k, d } of pending) {
      if (acceptedToday >= CAP) break
      if (d.accepted) continue
      const ageMin = (now - Date.parse(d.ts)) / 60000
      if (ageMin >= ACC_MIN) {
        d.accepted = true
        d.acceptedAt = new Date().toISOString()
        await store.setJSON(k, d)
        await sendSms(d.phone, "You're in. Hot Spots just accepted you at GCU. Open the app and start crossing paths: https://closer-gcu.netlify.app")
        acceptedToday++
        accepted++
      }
    }
    await store.setJSON(countKey, { n: acceptedToday })
    return ajson({ ok: true, processed, accepted, acceptedToday, cap: CAP, sms: twilioReady() ? 'on' : 'off' })
  }

  return json({ ok: false, error: 'unknown-action' }, 400)
}
