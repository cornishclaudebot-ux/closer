import { getStore } from '@netlify/blobs'

// Closer waitlist backend.
// POST ?action=submit  { email, phone, cta_location, hp }  -> stores the lead. If a texting
//   provider (Twilio) is configured, texts a 6-digit code and asks the client to verify.
// POST ?action=verify  { phone, code }                     -> confirms the code, marks verified.
// GET  ?action=list&key=... (admin)                        -> returns all captured leads as JSON.
// GET  ?action=export&key=... (admin)                      -> returns all leads as CSV.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

const isGcu = (e) => /@(my\.)?gcu\.edu$/i.test(String(e || '').trim())
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

// Emails each new signup to the DartyForLife inbox, tagged "Closer CVC" in the subject
// so a Gmail filter can auto-label it. Dormant until RESEND_API_KEY is set.
async function notify(rec) {
  const key = process.env.RESEND_API_KEY
  if (!key) return
  const to = process.env.NOTIFY_EMAIL || 'dartyforlife@gmail.com'
  const from = process.env.RESEND_FROM || 'Closer Waitlist <onboarding@resend.dev>'
  const subject = `Closer CVC | new signup: ${rec.email}`
  const html =
    '<h2 style="font-family:sans-serif">New Closer waitlist signup</h2>' +
    '<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">' +
    `<tr><td style="padding:2px 10px 2px 0"><b>Email</b></td><td>${rec.email}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0"><b>Phone</b></td><td>${rec.phone}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0"><b>GCU</b></td><td>${rec.school === 'gcu' ? 'Yes, founding member' : 'No, general list'}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0"><b>Phone verified</b></td><td>${rec.verified ? 'Yes' : 'Not yet'}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0"><b>Source</b></td><td>${rec.cta || 'n/a'}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0"><b>When</b></td><td>${rec.ts}</td></tr>` +
    '</table><p style="color:#888;font-family:sans-serif;font-size:12px">Category: Closer CVC</p>'
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    })
  } catch (e) {}
}

async function readBody(req) {
  const ct = req.headers.get('content-type') || ''
  if (ct.includes('application/json')) return await req.json().catch(() => ({}))
  const t = await req.text()
  return Object.fromEntries(new URLSearchParams(t))
}

export default async (req) => {
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
    const email = String(d.email || '').trim()
    const phone = String(d.phone || '').trim()
    if (!validEmail(email)) return json({ ok: false, error: 'bad-email' }, 400)
    if (digits(phone).length < 10) return json({ ok: false, error: 'bad-phone' }, 400)

    const gcu = isGcu(email)
    const rec = {
      email,
      phone: e164(phone),
      school: gcu ? 'gcu' : 'other',
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
      const sms = await sendSms(e164(phone), `Your Closer verification code is ${code}. It expires in 10 minutes.`)
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
    return json({ ok: true, verified: true })
  }

  // ADMIN: list / export
  if (req.method === 'GET' && (action === 'list' || action === 'export')) {
    const key = url.searchParams.get('key')
    if (key !== (process.env.WAITLIST_ADMIN_KEY || 'set-a-key')) return json({ ok: false }, 401)
    const { blobs } = await store.list({ prefix: 'lead:' })
    const leads = []
    for (const b of blobs) {
      const v = await store.get(b.key, { type: 'json' })
      if (v) leads.push(v)
    }
    leads.sort((a, b) => (a.ts < b.ts ? 1 : -1))
    if (action === 'export') {
      const rows = [['email', 'phone', 'school', 'verified', 'cta', 'ts']]
      leads.forEach((l) => rows.push([l.email, l.phone, l.school, l.verified, l.cta, l.ts]))
      const csv = rows.map((r) => r.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\n')
      return new Response(csv, { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=closer-waitlist.csv' } })
    }
    return json({ ok: true, count: leads.length, provider: twilioReady() ? 'sms-on' : 'capture-only', leads })
  }

  // ADMIN: clear all leads (reset)
  if (req.method === 'POST' && action === 'clear') {
    const key = url.searchParams.get('key')
    if (key !== (process.env.WAITLIST_ADMIN_KEY || 'set-a-key')) return json({ ok: false }, 401)
    let n = 0
    const leads = await store.list({ prefix: 'lead:' })
    for (const b of leads.blobs) { await store.delete(b.key); n++ }
    const pend = await store.list({ prefix: 'pending:' })
    for (const b of pend.blobs) { await store.delete(b.key); n++ }
    return json({ ok: true, cleared: n })
  }

  return json({ ok: false, error: 'unknown-action' }, 400)
}
