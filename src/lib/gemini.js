import { supabase } from './supabaseClient'
const GROQ_API_KEY = import.meta.env.VITE_GROQ_API_KEY

// Phrases that show up when the model leaks its own instructions/reasoning
// instead of answering (common with reasoning models like gpt-oss-20b when
// `message.content` comes back empty and we'd otherwise fall back to
// `message.reasoning`, which is the model "thinking out loud" about the
// prompt rather than the actual remark).
const LEAK_PATTERNS = [
  /\binstructions?\b/i,
  /\bmust be\b/i,
  /\bmaximum of\b/i,
  /\bwords? in total\b/i,
  /\bone sentence\b/i,
  /\bin order to\b/i,
  /\bstudent name\s*:/i,
  /\bcurrent performance\s*:/i,
  /\bprevious performance\s*:/i,
  /\bsubjects? and scores?\s*:/i,
  /\boutput only\b/i,
  /\braw (remark|sentence|text)\b/i,
  /\bdo not use\b/i,
  /\bno quotes?\b/i,
  /\bno markdown\b/i,
  /\bneed to generate\b/i,
  /\blet me\b/i,
  /\bi need to\b/i,
  /\bi should\b/i,
]

function cleanText(raw) {
  return (raw || '').trim().replace(/^["'`]|["'`]$/g, '').trim()
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length
}

// A remark is treated as "leaked" (the model echoing its own instructions or
// reasoning instead of answering) if it contains any of the telltale phrases
// above, or if it's implausibly long for the word limit we asked for.
function looksLeaked(text, maxWords) {
  if (!text) return true
  if (LEAK_PATTERNS.some((re) => re.test(text))) return true
  if (countWords(text) > maxWords * 3) return true
  return false
}

// Calls Groq's chat completions endpoint once and returns the cleaned text,
// preferring `message.content` and only falling back to `message.reasoning`
// (gpt-oss-20b sometimes puts the whole answer there) as a last resort.
async function callGroqOnce(promptText, { temperature, maxTokens }) {
  const url = 'https://api.groq.com/openai/v1/chat/completions'
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-20b',
      messages: [{ role: 'user', content: promptText }],
      temperature,
      max_tokens: maxTokens,
    }),
  })
  if (!response.ok) {
    const errData = await response.json().catch(() => ({}))
    if (response.status === 429) {
      throw new Error('Groq rate limit reached. Wait a moment and try again.')
    }
    throw new Error(errData.error?.message || `Generation failed with status ${response.status}`)
  }
  const result = await response.json()
  const message = result?.choices?.[0]?.message || {}
  return cleanText(message.content) || cleanText(message.reasoning)
}

// Calls Groq and retries (a few times, with a slightly higher temperature
// each pass to break out of a repeating bad pattern) until we get text that
// doesn't look like leaked instructions/reasoning, or gives up with a clear
// error instead of silently returning garbage.
async function generateValidatedText(promptText, { maxWords, temperature = 0.3, maxTokens = 300, maxAttempts = 3 }) {
  let lastAttempt = ''
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const text = await callGroqOnce(promptText, {
      temperature: Math.min(temperature + attempt * 0.15, 0.9),
      maxTokens,
    })
    lastAttempt = text
    if (text && !looksLeaked(text, maxWords)) {
      return text
    }
  }
  throw new Error("Couldn't get a clean remark after a few tries — please try again.")
}

/**
 * Checks if the automated remarks feature is enabled by Admin globally.
 * @returns {Promise<boolean>}
 */
export async function isAutomatedRemarksEnabled() {
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'enable_automated_remarks')
    .maybeSingle()
  if (error || !data) return true
  try {
    return typeof data.value === 'boolean' ? data.value : JSON.parse(data.value)
  } catch {
    return true
  }
}
/**
 * Toggles the automated remarks setting (Admin only).
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
export async function setAutomatedRemarksEnabled(enabled) {
  const { data: { user } } = await supabase.auth.getUser()
  await supabase
    .from('system_settings')
    .upsert({
      key: 'enable_automated_remarks',
      value: enabled,
      updated_at: new Date().toISOString(),
      updated_by: user?.id || null,
    })
}
/**
 * Retrieves total count of automated remarks generated globally.
 * @returns {Promise<number>}
 */
export async function getAutomatedRemarksCount() {
  const { count, error } = await supabase
    .from('remarks_audit_log')
    .select('*', { count: 'exact', head: true })
  return error ? 0 : (count ?? 0)
}
/**
 * Calls Groq's Llama 3.1 8B Instant model to generate a white-labeled
 * student remark. Groq's API is OpenAI-compatible, so this uses the
 * standard /chat/completions shape rather than Gemini's format.
 *
 * @param {Object} student - Student metadata object
 * @param {Array} currentGrades - Current exam subject scores
 * @param {Array} previousGrades - Previous exam subject scores (optional)
 * @returns {Promise<string>}
 */
export async function generateStudentRemark(student, currentGrades = [], previousGrades = []) {
  if (!GROQ_API_KEY) {
    throw new Error('Groq API key is missing. Please set VITE_GROQ_API_KEY in your .env file.')
  }
  const enabled = await isAutomatedRemarksEnabled()
  if (!enabled) {
    throw new Error('Automated remarks generation is currently disabled globally in Admin Settings.')
  }
  const currentSummary = currentGrades.length > 0
    ? currentGrades.map((g) => `${g.name}: ${g.score}`).join(', ')
    : 'No current exam grades recorded'
  const previousSummary = previousGrades.length > 0
    ? previousGrades.map((g) => `${g.name}: ${g.score}`).join(', ')
    : 'No previous exam grades recorded'
  const promptText = `
Student Name: ${student.full_name || 'Student'}
Current Performance: ${currentSummary}
Previous Performance: ${previousSummary}
Instructions:
1. Provide a brief professional performance remark for this student based on their current and previous grades.
2. The remark MUST be EXACTLY ONE SENTENCE.
3. The remark MUST be a MAXIMUM OF 6 WORDS in total (e.g., "Excellent progress; maintain consistent study habits.").
4. Do NOT use words or phrases like "AI", "As an AI", "AI analysis", "system", or "computer".
5. Output ONLY the raw remark text without quotes, headers, or surrounding markdown.
`
  const cleanRemark = await generateValidatedText(promptText, { maxWords: 6, temperature: 0.3 })
  // Log generation in audit log
  try {
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('remarks_audit_log').insert({
      student_id: student.id,
      generated_by: user?.id || null,
      remark_text: cleanRemark,
    })
  } catch (err) {
    console.warn('Could not record audit log:', err)
  }
  return cleanRemark
}
/**
 * Generates an overall report-card comment (Principal's or Class Teacher's),
 * distinct from the short per-subject remarks — this looks at the student's
 * full exam performance rather than a single subject.
 *
 * @param {Object} student - Student metadata object
 * @param {Array} subjectRows - This exam's subject rows (name, score)
 * @param {Object} aggregate - { total, maxTotal }
 * @param {number|null} position - Class position for this exam
 * @param {number|null} outOf - Total students ranked
 * @param {'principal'|'teacher'} commentType
 * @returns {Promise<string>}
 */
export async function generateReportComment(student, subjectRows, aggregate, position, outOf, commentType) {
  if (!GROQ_API_KEY) {
    throw new Error('Groq API key is missing. Please set VITE_GROQ_API_KEY in your .env file.')
  }
  const enabled = await isAutomatedRemarksEnabled()
  if (!enabled) {
    throw new Error('Automated remarks generation is currently disabled globally in Admin Settings.')
  }
  const gradesSummary = (subjectRows || [])
    .filter((r) => r.score !== null && r.score !== undefined)
    .map((r) => `${r.name}: ${r.score}`)
    .join(', ') || 'No scores recorded'
  const percentText = aggregate?.maxTotal
    ? `${Math.round((aggregate.total / aggregate.maxTotal) * 100)}%`
    : 'not available'
  const positionText = position && outOf ? `Position ${position} of ${outOf}` : 'position not available'
  const voice = commentType === 'principal'
    ? "You are the School Principal writing a brief comment on a student's report card."
    : "You are the student's Class Teacher writing a brief, warmer, more personal comment on a student's report card."
  const promptText = `
${voice}
Student Name: ${student.full_name || 'Student'}
Subjects and Scores: ${gradesSummary}
Overall: ${percentText} (${positionText})
Instructions:
1. Write ONE encouraging, professional sentence.
2. Maximum 15 words.
3. Do NOT use words or phrases like "AI", "As an AI", "system", or "computer".
4. Output ONLY the raw sentence, no quotes, headers, or markdown.
`
  const cleanRemark = await generateValidatedText(promptText, { maxWords: 15, temperature: 0.4 })
  try {
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('remarks_audit_log').insert({
      student_id: student.id,
      generated_by: user?.id || null,
      remark_text: `[${commentType === 'principal' ? 'Principal' : 'Class Teacher'}] ${cleanRemark}`,
    })
  } catch (err) {
    console.warn('Could not record audit log:', err)
  }
  return cleanRemark
}