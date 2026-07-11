// Scheduled function: runs every 15 minutes and triggers one waitlist drip pass
// (processing/position texts, then throttled acceptances). All the logic lives in
// waitlist.mjs under ?action=drip so there is one source of truth.

export const config = { schedule: '*/15 * * * *' }

export default async () => {
  const base = process.env.URL || 'https://closer-gcu.netlify.app'
  const key = process.env.WAITLIST_ADMIN_KEY || 'set-a-key'
  try {
    const r = await fetch(`${base}/.netlify/functions/waitlist?action=drip&key=${encodeURIComponent(key)}`, { method: 'POST' })
    const body = await r.text()
    return new Response('drip ' + r.status + ' ' + body)
  } catch (e) {
    return new Response('drip-error: ' + (e && e.message), { status: 500 })
  }
}
