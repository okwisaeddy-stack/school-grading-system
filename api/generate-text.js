// Vercel serverless function — runs on the server, never in the browser.
// The Groq key here has NO "VITE_" prefix, so Vite will never bundle it
// into client-side JS. Only this function ever sees it.
//
// Deploy note: this file must live at  /api/generate-text.js  in your repo
// root (same level as package.json), NOT inside /src. Vercel auto-detects
// anything under /api as a serverless function.
//
// In Vercel → Project Settings → Environment Variables, add:
//   GROQ_API_KEY = gsk_...   (no VITE_ prefix)
// And remove the old VITE_GROQ_API_KEY variable — it's no longer needed
// and would still leak into the browser bundle if left in place.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing GROQ_API_KEY. Set it in Vercel → Project Settings → Environment Variables.' })
  }

  const { promptText, temperature, maxTokens } = req.body || {}
  if (!promptText) {
    return res.status(400).json({ error: 'Missing promptText in request body.' })
  }

  try {
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: promptText }],
        temperature: temperature ?? 0.3,
        max_tokens: maxTokens ?? 300,
      }),
    })

    const data = await groqResponse.json()

    if (!groqResponse.ok) {
      const message = groqResponse.status === 429
        ? 'Groq rate limit reached. Wait a moment and try again.'
        : (data.error?.message || `Generation failed with status ${groqResponse.status}`)
      return res.status(groqResponse.status).json({ error: message })
    }

    return res.status(200).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error calling Groq.' })
  }
}