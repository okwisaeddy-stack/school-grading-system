import { supabase } from './supabaseClient'

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY

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
 * Calls Gemini 3.6 Flash API to generate a white-labeled student remark.
 * 
 * @param {Object} student - Student metadata object
 * @param {Array} currentGrades - Current exam subject scores
 * @param {Array} previousGrades - Previous exam subject scores (optional)
 * @returns {Promise<string>}
 */
export async function generateStudentRemark(student, currentGrades = [], previousGrades = []) {
  if (!GEMINI_API_KEY) {
    throw new Error('Google Gemini API key is missing. Please set VITE_GEMINI_API_KEY in your .env file.')
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: promptText }]
      }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 30
      }
    })
  })

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}))
    throw new Error(errData.error?.message || `Generation failed with status ${response.status}`)
  }

  const result = await response.json()
  const rawRemark = result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''

  // Clean quotes or markdown wrappers
  const cleanRemark = rawRemark.replace(/^["'`]|["'`]$/g, '').trim()

  // Log generation in audit log
  try {
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('remarks_audit_log').insert({
      student_id: student.id,
      generated_by: user?.id || null,
      remark_text: cleanRemark
    })
  } catch (err) {
    console.warn('Could not record audit log:', err)
  }

  return cleanRemark
}
