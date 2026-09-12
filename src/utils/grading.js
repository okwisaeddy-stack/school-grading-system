// ============================================================================
// GRADING LOGIC (mirrors the SQL functions — kept in sync manually)
// Extracted from App.jsx
// ============================================================================

// Default KNEC scale — used until/unless an admin saves a custom one in Supabase (grade_scale table)
export const DEFAULT_KNEC_SCALE = [
  { label: 'A', min_score: 80, points: 12 },
  { label: 'A-', min_score: 75, points: 11 },
  { label: 'B+', min_score: 70, points: 10 },
  { label: 'B', min_score: 65, points: 9 },
  { label: 'B-', min_score: 60, points: 8 },
  { label: 'C+', min_score: 55, points: 7 },
  { label: 'C', min_score: 50, points: 6 },
  { label: 'C-', min_score: 45, points: 5 },
  { label: 'D+', min_score: 40, points: 4 },
  { label: 'D', min_score: 35, points: 3 },
  { label: 'D-', min_score: 30, points: 2 },
  { label: 'E', min_score: 0, points: 1 },
]

// scale must be sorted descending by min_score (GradeScaleProvider guarantees this)
export function kcseGrade(score, scale = DEFAULT_KNEC_SCALE) {
  for (const row of scale) {
    if (score >= row.min_score) return row.label
  }
  return scale[scale.length - 1]?.label ?? 'E'
}

export function pointsForGrade(label, scale = DEFAULT_KNEC_SCALE) {
  return scale.find((r) => r.label === label)?.points ?? 0
}

// Default CBC scale — used until/unless an admin/dean saves a custom one in Supabase (cbc_scale table)
export const DEFAULT_CBC_SCALE = [
  { label: 'EE1', min_score: 90, points: 8 },
  { label: 'EE2', min_score: 75, points: 7 },
  { label: 'ME1', min_score: 58, points: 6 },
  { label: 'ME2', min_score: 41, points: 5 },
  { label: 'AE1', min_score: 31, points: 4 },
  { label: 'AE2', min_score: 21, points: 3 },
  { label: 'BE1', min_score: 11, points: 2 },
  { label: 'BE2', min_score: 0, points: 1 },
]

// scale must be sorted descending by min_score (CbcScaleProvider guarantees this)
export function cbcLevel(score, scale = DEFAULT_CBC_SCALE) {
  for (const row of scale) {
    if (score >= row.min_score) return row.label
  }
  return scale[scale.length - 1]?.label ?? 'BE2'
}

// Kept for any code still importing the old fixed lookup — derived from the default scale
export const CBC_POINTS = Object.fromEntries(DEFAULT_CBC_SCALE.map((r) => [r.label, r.points]))

// Best-7 aggregate for KCSE: compulsory always count, best electives fill the rest
export function computeKcseAggregate(subjectScores, scale = DEFAULT_KNEC_SCALE) {
  const maxPoints = Math.max(...scale.map((r) => r.points))
  const withScores = subjectScores.filter((s) => s.score !== null && s.score !== undefined)
  const compulsory = withScores.filter((s) => s.is_compulsory)
  const electives = withScores
    .filter((s) => !s.is_compulsory)
    .sort((a, b) => pointsForGrade(kcseGrade(b.score, scale), scale) - pointsForGrade(kcseGrade(a.score, scale), scale))
  const slotsLeft = Math.max(7 - compulsory.length, 0)
  const counted = [...compulsory, ...electives.slice(0, slotsLeft)]
  const total = counted.reduce((sum, s) => sum + pointsForGrade(kcseGrade(s.score, scale), scale), 0)
  const maxTotal = counted.length * maxPoints
  return { total, maxTotal, subjectCount: counted.length }
}

export function computeCbcTotal(subjectScores, scale = DEFAULT_CBC_SCALE) {
  const maxPoints = Math.max(...scale.map((r) => r.points))
  const withScores = subjectScores.filter((s) => s.score !== null && s.score !== undefined)
  const total = withScores.reduce((sum, s) => sum + pointsForGrade(cbcLevel(s.score, scale), scale), 0)
  const maxTotal = withScores.length * maxPoints
  return { total, maxTotal, subjectCount: withScores.length }
}

// ============================================================================
// MEAN GRADES (subject means, class means, teacher's class-average trend)
// A "mean" over a set of scores is NOT the average of the raw percentage
// scores. Each score is converted to its grade points first, those points
// are summed and divided by the count to get a mean points value, and THAT
// value is looked up against the scale to get the mean grade — the same way
// KNEC computes a subject/class mean grade.
// ============================================================================

// A single score's grade points on the given scale.
export function pointsForScore(score, scale, isCbc = false) {
  const label = isCbc ? cbcLevel(score, scale) : kcseGrade(score, scale)
  return pointsForGrade(label, scale)
}

// Mean points for a list of raw scores: sum each score's points, divide by
// count. Returns null if there are no valid scores.
export function meanPoints(scores, scale, isCbc = false) {
  const valid = (scores || []).filter((s) => s !== null && s !== undefined)
  if (valid.length === 0) return null
  const total = valid.reduce((sum, s) => sum + pointsForScore(s, scale, isCbc), 0)
  return total / valid.length
}

// Grade label for a mean points value. Mirrors kcseGrade/cbcLevel's
// threshold logic (scale sorted descending by min_score, which is also
// descending by points) but keys off points instead of raw score.
export function gradeForMeanPoints(points, scale) {
  if (points === null || points === undefined) return null
  for (const row of scale) {
    if (points >= row.points) return row.label
  }
  return scale[scale.length - 1]?.label ?? null
}