// Supabase Edge Function: send-results-sms
// Sends personalised results SMS to parents via Africa's Talking.
//
// Secrets (supabase secrets set ...):
//   AT_USERNAME   Africa's Talking username ("sandbox" for testing)
//   AT_API_KEY    Africa's Talking API key
//   AT_SENDER_ID  (optional) approved sender ID / shortcode
//   AT_SANDBOX    (optional) "true" to use the sandbox endpoint
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const MAX_MESSAGES = 200
const MAX_LENGTH = 640 // about 4 SMS segments (153 chars each when concatenated)
const CONCURRENCY = 5
const SUCCESS_CODES = [100, 101, 102] // Processed / Sent / Queued

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  // 1. Only approved admins may send.
  const authHeader = req.headers.get('Authorization') ?? ''
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userData, error: userErr } = await userClient.auth.getUser()
  if (userErr || !userData?.user) return json({ error: 'Not signed in' }, 401)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: profile } = await admin
    .from('profiles').select('role, status').eq('id', userData.user.id).single()
  if (!profile || profile.role !== 'admin' || profile.status !== 'approved') {
    return json({ error: 'Only approved admins can send SMS' }, 403)
  }

  // 2. Validate input.
  let payload: { messages?: { id: string; to: string; message: string }[] }
  try { payload = await req.json() } catch { return json({ error: 'Invalid JSON' }, 400) }
  const messages = payload.messages ?? []
  if (!Array.isArray(messages) || messages.length === 0) return json({ error: 'No messages' }, 400)
  if (messages.length > MAX_MESSAGES) return json({ error: `Max ${MAX_MESSAGES} messages per request` }, 400)

  const username = Deno.env.get('AT_USERNAME')
  const apiKey = Deno.env.get('AT_API_KEY')
  if (!username || !apiKey) return json({ error: 'SMS provider is not configured' }, 500)
  const senderId = Deno.env.get('AT_SENDER_ID')
  const url = Deno.env.get('AT_SANDBOX') === 'true'
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging'

  // 3. Send one request per recipient (each message is personalised).
  async function sendOne(m: { id: string; to: string; message: string }) {
    if (!/^\+254[17]\d{8}$/.test(m.to) || !m.message || m.message.length > MAX_LENGTH) {
      return { id: m.id, ok: false, error: 'Invalid number or message' }
    }
    try {
      const body = new URLSearchParams({ username, to: m.to, message: m.message })
      if (senderId) body.set('from', senderId)
      const res = await fetch(url, {
        method: 'POST',
        headers: { apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      const raw = await res.text()
      let data: any = null
      try { data = JSON.parse(raw) } catch { /* not JSON, e.g. an auth error */ }
      const r = data?.SMSMessageData?.Recipients?.[0]
      const ok = !!r && SUCCESS_CODES.includes(Number(r.statusCode))
      if (ok) return { id: m.id, ok: true }
      const reason = r?.status ?? data?.SMSMessageData?.Message ?? `HTTP ${res.status}: ${raw.slice(0, 160)}`
      console.error('SMS failed', { studentId: m.id, httpStatus: res.status, statusCode: r?.statusCode, reason })
      return { id: m.id, ok: false, error: String(reason) }
    } catch (e) {
      return { id: m.id, ok: false, error: String(e) }
    }
  }

  const results: { id: string; ok: boolean; error?: string }[] = []
  let next = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < messages.length) {
      const m = messages[next++]
      results.push(await sendOne(m))
    }
  }))

  return json({ results })
})
