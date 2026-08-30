import { useState, useEffect, createContext, useContext, useCallback } from 'react'
import Papa from 'papaparse'
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import JSZip from 'jszip'
import { supabase } from './lib/supabaseClient'
import {
  generateStudentRemark,
  generateReportComment,
  isAutomatedRemarksEnabled,
  setAutomatedRemarksEnabled,
  getAutomatedRemarksCount,
} from './lib/gemini'
import {
  COLORS, wrap, card, input, btn, secondaryBtn, errorText, link, pageWrap,
  th, td, modalOverlay, modalCard, fieldLabel, sectionLabel, pillStatic, pillBtn,
} from './theme'
import {
  DEFAULT_KNEC_SCALE, kcseGrade, pointsForGrade, cbcLevel, CBC_POINTS,
  computeKcseAggregate, computeCbcTotal, DEFAULT_CBC_SCALE,
} from './utils/grading'

// ============================================================================
// Helpers
// ============================================================================
function usernameToEmail(username) {
  return `${username.trim().toLowerCase().replace(/\s+/g, '.')}@internal-users.pwahighschool.com`
}

const COMPULSORY_84 = ['Mathematics', 'English', 'Kiswahili', 'Chemistry']
const ONE_OF_GROUP = ['Computer Studies', 'Business Studies', 'Agriculture']
const EXCLUSION_PAIRS = [['Physics', 'Biology'], ['Geography', 'History']]

function isExcludedTogether(selected, candidate) {
  return EXCLUSION_PAIRS.some(
    ([a, b]) => (candidate === a && selected.includes(b)) || (candidate === b && selected.includes(a))
  )
}

// ============================================================================
// Styles — extracted to src/theme/index.js (imported above)
// ============================================================================

// ============================================================================
// NOTIFICATIONS — app-themed toasts & confirm modal, replacing window.alert/confirm
// ============================================================================
const NotificationContext = createContext(null)

function useNotify() {
  const ctx = useContext(NotificationContext)
  if (!ctx) {
    // Fallback so this never hard-crashes if a component renders outside the provider
    return { notify: () => {}, confirmAction: () => Promise.resolve(true) }
  }
  return ctx
}

function NotificationProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const [confirmState, setConfirmState] = useState(null) // { message, resolve }

  const notify = useCallback((message, type = 'success') => {
    const id = `${Date.now()}-${Math.random()}`
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 4200)
  }, [])

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const confirmAction = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      setConfirmState({ message, resolve, ...opts })
    })
  }, [])

  function resolveConfirm(result) {
    confirmState?.resolve(result)
    setConfirmState(null)
  }

  return (
    <NotificationContext.Provider value={{ notify, confirmAction }}>
      {children}
      <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 300, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 'min(360px, 90vw)' }}>
        {toasts.map((t) => {
          const isError = t.type === 'error'
          return (
            <div
              key={t.id}
              onClick={() => dismissToast(t.id)}
              style={{
                padding: '12px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                background: isError ? COLORS.warnSoft : COLORS.goodSoft,
                color: isError ? COLORS.warn : COLORS.good,
                border: `1px solid ${isError ? COLORS.warn : COLORS.good}`,
                boxShadow: '0 6px 18px rgba(30,42,36,0.16)',
              }}
            >
              {t.message}
            </div>
          )
        })}
      </div>
      {confirmState && (
        <div style={modalOverlay}>
          <div style={{ ...modalCard, maxWidth: 380 }}>
            <p style={{ fontSize: 14, color: COLORS.ink, lineHeight: 1.5, marginBottom: 22 }}>{confirmState.message}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => resolveConfirm(false)} style={secondaryBtn}>{confirmState.cancelLabel || 'Cancel'}</button>
              <button
                onClick={() => resolveConfirm(true)}
                style={confirmState.danger ? { ...btn, background: COLORS.warn } : btn}
              >
                {confirmState.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </NotificationContext.Provider>
  )
}

// ============================================================================
// CONCURRENT TIMETABLE GROUPS — Dean-defined subjects that must be
// scheduled at the same day+period (e.g. Physics/Biology, or a CBC pathway
// elective block). Stored per curriculum ('844' or 'cbc') so both grading
// systems can have their own set, and surfaced on the Dean's Timetable
// screen for visibility.
// ============================================================================
const ConcurrentGroupsContext = createContext(null)

function useConcurrentGroups() {
  const ctx = useContext(ConcurrentGroupsContext)
  return ctx || { groupsByCurriculum: { '844': [], cbc: [] }, loading: false, reload: () => {} }
}

function ConcurrentGroupsProvider({ children }) {
  const [groupsByCurriculum, setGroupsByCurriculum] = useState({ '844': [], cbc: [] })
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.from('timetable_concurrent_groups').select('*').order('label')
    if (!error && data) {
      setGroupsByCurriculum({
        '844': data.filter((g) => g.curriculum === '844'),
        cbc: data.filter((g) => g.curriculum === 'cbc'),
      })
    } else {
      setGroupsByCurriculum({ '844': [], cbc: [] })
    }
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  return (
    <ConcurrentGroupsContext.Provider value={{ groupsByCurriculum, loading, reload }}>
      {children}
    </ConcurrentGroupsContext.Provider>
  )
}

const CbcScaleContext = createContext(null)

function useCbcScale() {
  const ctx = useContext(CbcScaleContext)
  return ctx || { scale: DEFAULT_CBC_SCALE, loading: false, reload: () => {} }
}

function CbcScaleProvider({ children }) {
  const [scale, setScale] = useState(DEFAULT_CBC_SCALE)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.from('cbc_scale').select('*').order('min_score', { ascending: false })
    if (!error && data && data.length > 0) {
      setScale(data.map((r) => ({ label: r.label, min_score: r.min_score, points: r.points })))
    } else {
      setScale(DEFAULT_CBC_SCALE)
    }
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  return (
    <CbcScaleContext.Provider value={{ scale, loading, reload }}>
      {children}
    </CbcScaleContext.Provider>
  )
}

// ============================================================================
// AUTH SCREENS
// ============================================================================
function Login({ onSwitchToSignup }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLogin(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const email = username.includes('@') ? username : usernameToEmail(username)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError('Incorrect username or password.')
    setLoading(false)
  }

  return (
    <div style={wrap}>
      <form onSubmit={handleLogin} style={card}>
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <img src="/crest.png" alt="Crest" style={{ width: 56, height: 56, borderRadius: '50%' }} />
        </div>
        <h3 style={{ textAlign: 'center' }}>Log In</h3>
        <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} style={input} />
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} style={input} />
        {error && <p style={errorText}>{error}</p>}
        <button type="submit" disabled={loading} style={{ ...btn, width: '100%' }}>{loading ? 'Logging in...' : 'Log In'}</button>
        <p style={{ fontSize: 12, textAlign: 'center', marginTop: 14 }}>
          New teacher? <a onClick={onSwitchToSignup} style={link}>Create an account</a>
        </p>
      </form>
    </div>
  )
}

const TITLE_LIMITS = { 'Principal': 1, 'Deputy Principal': 2, 'Dean of Studies': 1, 'School Manager': 1, 'Director': 1 }
// Titles that count as "Leadership" — these admins can enter/edit marks for
// any subject and class directly, without self-assigning a teacher row first.
const LEADERSHIP_TITLES = Object.keys(TITLE_LIMITS)
// Of those, School Manager and Director are purely administrative — they
// don't teach a subject/class, so the Profiles screen shouldn't offer to
// assign them one.
const NON_TEACHING_TITLES = ['School Manager', 'Director']

function Signup({ onSwitchToLogin, onSignedUp }) {
  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [roleChoice, setRoleChoice] = useState('teacher') // 'teacher' | one of Object.keys(TITLE_LIMITS)
  const [titleCounts, setTitleCounts] = useState({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // Count existing pending + approved admins per title, so we can block
    // signing up for a slot that's already taken or already requested
    supabase.from('profiles').select('title').eq('role', 'admin').in('status', ['pending', 'approved']).then(({ data }) => {
      const counts = {}
      ;(data || []).forEach((p) => { if (p.title) counts[p.title] = (counts[p.title] || 0) + 1 })
      setTitleCounts(counts)
    })
  }, [])

  function isTitleFull(title) {
    return (titleCounts[title] || 0) >= TITLE_LIMITS[title]
  }

  async function handleSignup(e) {
    e.preventDefault()
    setError('')
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return }
    if (roleChoice !== 'teacher' && isTitleFull(roleChoice)) {
      setError(`${roleChoice} already has the maximum number of people (${TITLE_LIMITS[roleChoice]}) signed up or approved.`)
      return
    }
    setLoading(true)
    const email = usernameToEmail(username)
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) { setError(error.message); setLoading(false); return }

    const isLeadership = roleChoice !== 'teacher'
    const { error: profileError } = await supabase.from('profiles').insert({
      id: data.user.id,
      username: username.trim().toLowerCase(),
      full_name: fullName.trim(),
      role: isLeadership ? 'admin' : 'teacher',
      title: isLeadership ? roleChoice : null,
      status: 'pending',
    })
    if (profileError) { setError(profileError.message); setLoading(false); return }
    setLoading(false)
    onSignedUp()
  }

  return (
    <div style={wrap}>
      <form onSubmit={handleSignup} style={card}>
        <h3>Create your account</h3>
        <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 14 }}>
          Use your real name so an existing admin can confirm you're on staff.
        </p>
        <input placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} style={input} />
        <input placeholder="Choose a username" value={username} onChange={(e) => setUsername(e.target.value)} style={input} />
        <input type="password" placeholder="Choose a password" value={password} onChange={(e) => setPassword(e.target.value)} style={input} />
        <label style={fieldLabel}>Your role
          <select value={roleChoice} onChange={(e) => setRoleChoice(e.target.value)} style={input}>
            <option value="teacher">Subject Teacher</option>
            {Object.keys(TITLE_LIMITS).map((title) => (
              <option key={title} value={title} disabled={isTitleFull(title)}>
                {title}{isTitleFull(title) ? ' (taken)' : ''}
              </option>
            ))}
          </select>
        </label>
        {roleChoice !== 'teacher' && !isTitleFull(roleChoice) && (
          <p style={{ fontSize: 11.5, color: COLORS.accent, marginTop: -4, marginBottom: 10 }}>
            Leadership roles get full admin access once approved — an existing admin will confirm this is genuinely you before it's granted.
          </p>
        )}
        {error && <p style={errorText}>{error}</p>}
        <button type="submit" disabled={loading} style={{ ...btn, width: '100%' }}>{loading ? 'Creating...' : 'Create Account'}</button>
        <p style={{ fontSize: 12, textAlign: 'center', marginTop: 14 }}>
          <a onClick={onSwitchToLogin} style={link}>← Back to log in</a>
        </p>
      </form>
    </div>
  )
}

function PendingApproval({ fullName, onLogout }) {
  return (
    <div style={wrap}>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 32 }}>⏳</div>
        <h3>Awaiting approval</h3>
        <p style={{ fontSize: 13, color: COLORS.muted }}>
          Hi {fullName} — a Dean, Deputy, or Principal needs to confirm you're on staff before you can log in fully.
        </p>
        <button onClick={onLogout} style={btn}>Log out</button>
      </div>
    </div>
  )
}

// ============================================================================
// TOP NAV
// ============================================================================
// ============================================================================
// SHARED: Change Password modal (for any logged-in user — admin or teacher)
// ============================================================================
function ChangePasswordModal({ onClose }) {
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  async function handleSave() {
    setError('')
    if (newPassword.length < 6) { setError('Password must be at least 6 characters.'); return }
    if (newPassword !== confirmPassword) { setError("Passwords don't match."); return }
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) { setError(error.message); setSaving(false); return }
    setSaving(false)
    setSuccess(true)
  }

  return (
    <div style={modalOverlay}>
      <div style={{ ...modalCard, maxWidth: 'min(360px, 94vw)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3>Change Password</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>

        {success ? (
          <>
            <p style={{ fontSize: 13, color: COLORS.good, marginBottom: 16 }}>✓ Password changed successfully.</p>
            <button onClick={onClose} style={{ ...btn, width: '100%' }}>Done</button>
          </>
        ) : (
          <>
            <label style={fieldLabel}>New password
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={input} placeholder="At least 6 characters" />
            </label>
            <label style={fieldLabel}>Confirm new password
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} style={input} />
            </label>
            {error && <p style={errorText}>{error}</p>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button onClick={onClose} style={secondaryBtn}>Cancel</button>
              <button onClick={handleSave} disabled={saving} style={btn}>{saving ? 'Saving...' : 'Save Password'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function useIsNarrow() {
  const [isNarrow, setIsNarrow] = useState(typeof window !== 'undefined' && window.innerWidth < 700)
  useEffect(() => {
    function check() { setIsNarrow(window.innerWidth < 700) }
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  return isNarrow
}

function TopBar({ tab, setTab, onLogout, fullName, title }) {
  const isLeadership = LEADERSHIP_TITLES.includes(title)
  const tabs = [
    'Dashboard', 'Students', 'Exams', 'Reports', 'Performance Track', 'Attendance', 'Timetable', 'Profiles',
    ...(isLeadership ? ['Enter Marks'] : []),
    'My Teaching', 'Approvals', 'Settings',
  ]
  const isNarrow = useIsNarrow()
  const [menuOpen, setMenuOpen] = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)

  if (isNarrow) {
    // ---- Mobile: unchanged top bar + hamburger drawer ----
    return (
      <div style={{ background: COLORS.band, color: COLORS.bandText, fontFamily: 'sans-serif' }}>
        <div style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => setMenuOpen(true)}
              aria-label="Open menu"
              style={{ background: 'none', border: 'none', color: COLORS.bandText, fontSize: 22, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}
            >
              ☰
            </button>
            <img src="/crest.png" alt="Crest" style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0 }} />
            <div style={{ fontWeight: 700, fontSize: 14 }}>PWA Records</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={() => setShowChangePw(true)} style={{ ...secondaryBtn, background: 'transparent', color: COLORS.bandText, borderColor: 'rgba(255,255,255,0.3)', padding: '6px 10px', fontSize: 12 }}>🔑</button>
            <button onClick={onLogout} style={{ ...secondaryBtn, background: 'transparent', color: COLORS.bandText, borderColor: 'rgba(255,255,255,0.3)', padding: '6px 10px', fontSize: 12 }}>Log out</button>
          </div>
        </div>
        {menuOpen && (
          <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60 }}>
            <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: '72vw', maxWidth: 280, background: COLORS.paper, boxShadow: '2px 0 12px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', padding: '18px 0' }}>
              <div style={{ padding: '0 20px 14px', borderBottom: `1px solid ${COLORS.ruleLight}`, marginBottom: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: COLORS.ink }}>{fullName}</div>
                <div style={{ fontSize: 11, color: COLORS.muted }}>{title || 'Paul Wanjigi Alpine — Records'}</div>
              </div>
              {tabs.map((t) => (
                <button
                  key={t}
                  onClick={() => { setTab(t); setMenuOpen(false) }}
                  style={{ textAlign: 'left', padding: '14px 20px', background: tab === t ? COLORS.accentSoft : 'transparent', color: COLORS.ink, border: 'none', fontSize: 14, fontWeight: tab === t ? 700 : 500, cursor: 'pointer' }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}
        {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
      </div>
    )
  }

  // ---- Desktop: fixed left sidebar, Instagram-style ----
  return (
    <div style={{
      width: 240, flexShrink: 0, background: COLORS.band, color: COLORS.bandText,
      fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column',
      height: '100vh', position: 'sticky', top: 0,
    }}>
      <div style={{ padding: '22px 20px 18px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid rgba(255,255,255,0.12)` }}>
        <img src="/crest.png" alt="Crest" style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0 }} />
        <div style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.25 }}>Paul Wanjigi Alpine<br/>Records</div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              textAlign: 'left', padding: '10px 14px', borderRadius: 8, border: 'none',
              background: tab === t ? COLORS.paper : 'transparent',
              color: tab === t ? COLORS.ink : COLORS.bandText,
              fontSize: 13.5, fontWeight: tab === t ? 700 : 500, cursor: 'pointer',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      <div style={{ padding: '14px 16px', borderTop: `1px solid rgba(255,255,255,0.12)` }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>{fullName}</div>
        {title && <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 10 }}>{title}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button onClick={() => setShowChangePw(true)} style={{ ...secondaryBtn, background: 'transparent', color: COLORS.bandText, borderColor: 'rgba(255,255,255,0.3)', fontSize: 12, width: '100%' }}>
            Change Password
          </button>
          <button onClick={onLogout} style={{ ...secondaryBtn, background: 'transparent', color: COLORS.bandText, borderColor: 'rgba(255,255,255,0.3)', fontSize: 12, width: '100%' }}>
            Log out
          </button>
        </div>
      </div>

      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
    </div>
  )
}

// ============================================================================
// DASHBOARD
// ============================================================================
function StatCard({ label, value, tone, onClick }) {
  const toneColors = {
    default: { bg: COLORS.card, fg: COLORS.ink },
    warn: { bg: COLORS.warnSoft, fg: COLORS.warn },
    good: { bg: COLORS.goodSoft, fg: COLORS.good },
  }
  const c = toneColors[tone] || toneColors.default
  return (
    <div onClick={onClick} style={{ background: c.bg, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 18, cursor: onClick ? 'pointer' : 'default', flex: 1, minWidth: 150 }}>
      <div style={{ fontSize: 26, fontWeight: 700, color: c.fg }}>{value}</div>
      <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>{label}</div>
    </div>
  )
}

function DashboardScreen({ onNavigate }) {
  const [counts, setCounts] = useState({ students: 0, pending: 0, exams: 0, teachers: 0 })
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadCounts() }, [])

  async function loadCounts() {
    setLoading(true)
    const [{ count: studentCount }, { count: pendingCount }, { count: examCount }, { count: teacherCount }] = await Promise.all([
      supabase.from('students').select('*', { count: 'exact', head: true }),
      supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('exams').select('*', { count: 'exact', head: true }),
      supabase.from('profiles').select('*', { count: 'exact', head: true }).in('role', ['teacher', 'admin']).eq('status', 'approved'),
    ])
    setCounts({ students: studentCount ?? 0, pending: pendingCount ?? 0, exams: examCount ?? 0, teachers: teacherCount ?? 0 })
    setLoading(false)
  }

  return (
    <div style={pageWrap}>
      <h2>Dashboard</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 20 }}>Live counts from the database.</p>
      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <StatCard label="Total students" value={counts.students} onClick={() => onNavigate('Students')} />
          <StatCard label="Total teachers" value={counts.teachers} onClick={() => onNavigate('Profiles')} />
          <StatCard label="Total exams created" value={counts.exams} onClick={() => onNavigate('Exams')} />
          <StatCard label="Pending teacher approvals" value={counts.pending} tone={counts.pending > 0 ? 'warn' : 'good'} onClick={() => onNavigate('Approvals')} />
        </div>
      )}
      <button onClick={loadCounts} style={{ ...secondaryBtn, marginTop: 20 }}>↻ Refresh</button>
    </div>
  )
}

// ============================================================================
// APPROVALS
// ============================================================================
function ApprovalsScreen({ currentUserId }) {
  const { notify } = useNotify()
  const [pending, setPending] = useState([])
  const [loading, setLoading] = useState(true)
  const [actioningId, setActioningId] = useState(null)
  const [pendingAssignments, setPendingAssignments] = useState([])
  const [loadingAssignments, setLoadingAssignments] = useState(true)
  const [actioningAssignmentId, setActioningAssignmentId] = useState(null)

  useEffect(() => { loadPending(); loadPendingAssignments() }, [])

  async function loadPending() {
    setLoading(true)
    const { data, error } = await supabase
      .from('profiles').select('*').eq('status', 'pending')
      .order('created_at', { ascending: true })
    if (!error) setPending(data)
    setLoading(false)
  }

  async function loadPendingAssignments() {
    setLoadingAssignments(true)
    const { data, error } = await supabase
      .from('teacher_assignments')
      .select('*, subjects(name), profiles(full_name)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
    if (!error) setPendingAssignments(data || [])
    setLoadingAssignments(false)
  }

  async function approveAssignment(id) {
    setActioningAssignmentId(id)
    const { error } = await supabase.from('teacher_assignments').update({ status: 'approved' }).eq('id', id)
    setActioningAssignmentId(null)
    if (error) { notify(`Couldn't approve: ${error.message}`, 'error'); return }
    notify('Assignment approved — it can now be scheduled on the timetable.')
    loadPendingAssignments()
  }

  async function rejectAssignment(id) {
    setActioningAssignmentId(id)
    const { error } = await supabase.from('teacher_assignments').update({ status: 'rejected' }).eq('id', id)
    setActioningAssignmentId(null)
    if (error) { notify(`Couldn't reject: ${error.message}`, 'error'); return }
    notify('Assignment rejected.')
    loadPendingAssignments()
  }

  async function approve(id) {
    const person = pending.find((p) => p.id === id)
    if (person?.role === 'admin' && person.title) {
      const limit = TITLE_LIMITS[person.title]
      const { count } = await supabase
        .from('profiles').select('*', { count: 'exact', head: true })
        .eq('role', 'admin').eq('title', person.title).eq('status', 'approved')
      if ((count ?? 0) >= limit) {
        notify(`Can't approve — ${person.title} already has the maximum of ${limit} approved. Reject this request or remove/reassign the existing one first.`, 'error')
        return
      }
    }
    setActioningId(id)
    await supabase.from('profiles').update({ status: 'approved', approved_by: currentUserId, approved_at: new Date().toISOString() }).eq('id', id)
    setActioningId(null)
    notify(`${person?.full_name || 'Staff member'} approved.`)
    loadPending()
  }

  async function reject(id) {
    setActioningId(id)
    await supabase.from('profiles').update({ status: 'rejected', approved_by: currentUserId, approved_at: new Date().toISOString() }).eq('id', id)
    setActioningId(null)
    notify('Request rejected.')
    loadPending()
  }

  return (
    <div style={pageWrap}>
      <h2>Pending Approvals</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 20 }}>Confirm each name is actually on staff before approving — leadership requests grant full admin access.</p>

      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : pending.length === 0 ? (
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 24, textAlign: 'center', color: COLORS.muted, fontSize: 13 }}>
          No pending sign-ups right now.
        </div>
      ) : (
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
          <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Full Name</th><th style={th}>Username</th><th style={th}>Requested Role</th><th style={th}>Signed up</th><th style={th}></th></tr></thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                  <td style={td}>{p.full_name}</td>
                  <td style={{ ...td, color: COLORS.muted }}>{p.username}</td>
                  <td style={td}>
                    {p.role === 'admin' ? (
                      <span style={{ color: COLORS.accent, fontWeight: 700 }}>{p.title || 'Admin'}</span>
                    ) : (
                      'Subject Teacher'
                    )}
                  </td>
                  <td style={{ ...td, color: COLORS.muted }}>{new Date(p.created_at).toLocaleDateString()}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button onClick={() => reject(p.id)} disabled={actioningId === p.id} style={{ ...secondaryBtn, color: COLORS.warn, borderColor: COLORS.warn }}>Reject</button>
                      <button onClick={() => approve(p.id)} disabled={actioningId === p.id} style={btn}>{actioningId === p.id ? 'Working...' : 'Approve'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 32 }}>Pending Subject/Class Assignments</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 20 }}>
        Teachers self-assign what they teach on first login. Approve each one here before it can be placed on the timetable.
      </p>

      {loadingAssignments ? <p style={{ color: COLORS.muted }}>Loading...</p> : pendingAssignments.length === 0 ? (
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 24, textAlign: 'center', color: COLORS.muted, fontSize: 13 }}>
          No pending assignments right now.
        </div>
      ) : (
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
          <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Teacher</th><th style={th}>Subject</th><th style={th}>Class</th><th style={th}></th></tr></thead>
            <tbody>
              {pendingAssignments.map((a) => (
                <tr key={a.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                  <td style={td}>{a.profiles?.full_name}</td>
                  <td style={td}>{a.subjects?.name}</td>
                  <td style={{ ...td, color: COLORS.muted }}>{CLASS_OPTIONS.find((c) => c.value === a.class_label)?.label || a.class_label}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button onClick={() => rejectAssignment(a.id)} disabled={actioningAssignmentId === a.id} style={{ ...secondaryBtn, color: COLORS.warn, borderColor: COLORS.warn }}>Reject</button>
                      <button onClick={() => approveAssignment(a.id)} disabled={actioningAssignmentId === a.id} style={btn}>{actioningAssignmentId === a.id ? 'Working...' : 'Approve'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// ADD STUDENT MODAL
// ============================================================================
const GRADE10_COMPULSORY = ['Mathematics', 'English', 'Kiswahili', 'Community Service Learning', 'Physical Education', 'ICT']
const GRADE10_NON_EXAMINABLE = ['Physical Education', 'ICT']
const GRADE10_ELECTIVE_MENU = [
  'Biology', 'Chemistry', 'Physics', 'Computer Studies', 'Agriculture', 'Media Technology',
  'Foreign Languages', 'Local Languages', 'Business Studies', 'History', 'Geography',
  'CRE', 'Music', 'Dance', 'Theatre', 'Visual Arts', 'Sports Science',
]

function AddStudentModal({ onClose, onSaved }) {
  const [allSubjects, setAllSubjects] = useState([])
  const [cohort, setCohort] = useState('form_4')
  const [pathway, setPathway] = useState('stem')
  const [fullName, setFullName] = useState('')
  const [admissionNo, setAdmissionNo] = useState('')
  const [electives, setElectives] = useState([])
  const [oneOfChoice, setOneOfChoice] = useState('')
  const [grade10Electives, setGrade10Electives] = useState([])
  const [entranceRaw, setEntranceRaw] = useState('')
  const [parentName, setParentName] = useState('')
  const [parentPhone, setParentPhone] = useState('')
  const [pastExams, setPastExams] = useState([{ label: '', points: '', maxPoints: '84' }])
  const [blockedMsg, setBlockedMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.from('subjects').select('*').then(({ data }) => setAllSubjects(data || []))
  }, [])

  function toggleGrade10Elective(subject) {
    setGrade10Electives((prev) => (prev.includes(subject) ? prev.filter((s) => s !== subject) : [...prev, subject]))
  }

  function toggleElective(subject) {
    if (electives.includes(subject)) {
      setElectives(electives.filter((s) => s !== subject))
      setBlockedMsg('')
      return
    }
    if (isExcludedTogether(electives, subject)) {
      const pair = EXCLUSION_PAIRS.find(([a, b]) => a === subject || b === subject)
      const conflict = pair.find((s) => s !== subject)
      setBlockedMsg(`Can't add ${subject} — already taking ${conflict}.`)
      return
    }
    setElectives([...electives, subject])
    setBlockedMsg('')
  }

  function updatePastExam(i, field, value) {
    setPastExams((prev) => prev.map((p, idx) => (idx === i ? { ...p, [field]: value } : p)))
  }
  function addPastExamRow() {
    setPastExams((prev) => [...prev, { label: '', points: '', maxPoints: '84' }])
  }

  const isForm34 = cohort === 'form_3' || cohort === 'form_4'
  const entranceType = cohort === 'grade_10' ? 'KJSEA' : 'KCPE'
  const entranceMax = cohort === 'grade_10' ? 72 : 500
  const canSave = fullName.trim() && admissionNo.trim() && (!isForm34 || (electives.length > 0 && oneOfChoice))

  async function handleSave() {
    setSaving(true)
    setError('')

    const { data: student, error: studentError } = await supabase
      .from('students')
      .insert({
        full_name: fullName.trim(),
        admission_no: admissionNo.trim(),
        cohort,
        pathway: cohort === 'grade_10' ? pathway : null,
        entrance_type: entranceRaw ? entranceType : null,
        entrance_score: entranceRaw ? Number(entranceRaw) : null,
        entrance_max: entranceRaw ? entranceMax : null,
        parent_name: parentName.trim() || null,
        parent_phone: parentPhone.trim() || null,
      })
      .select()
      .single()

    if (studentError) {
      setError(studentError.message)
      setSaving(false)
      return
    }

    if (isForm34) {
      const subjectByName = Object.fromEntries(allSubjects.map((s) => [s.name, s.id]))
      const rows = [
        ...COMPULSORY_84.map((name) => ({ student_id: student.id, subject_id: subjectByName[name], is_compulsory: true })),
        ...electives.map((name) => ({ student_id: student.id, subject_id: subjectByName[name], is_compulsory: false })),
        { student_id: student.id, subject_id: subjectByName[oneOfChoice], is_compulsory: false },
      ].filter((r) => r.subject_id)
      await supabase.from('student_subjects').insert(rows)
    }

    if (cohort === 'grade_10') {
      const subjectByName = Object.fromEntries(allSubjects.map((s) => [s.name, s.id]))
      const rows = [
        ...GRADE10_COMPULSORY.map((name) => ({ student_id: student.id, subject_id: subjectByName[name], is_compulsory: true })),
        ...grade10Electives.map((name) => ({ student_id: student.id, subject_id: subjectByName[name], is_compulsory: false })),
      ].filter((r) => r.subject_id)
      await supabase.from('student_subjects').insert(rows)
    }

    const validPast = pastExams.filter((p) => p.label.trim() && p.points !== '')
    if (validPast.length > 0) {
      const rows = validPast.map((p, i) => ({
        student_id: student.id, label: p.label.trim(), order_index: i + 1,
        points: Number(p.points), max_points: Number(p.maxPoints || 84),
      }))
      await supabase.from('historical_performance').insert(rows)
    }

    setSaving(false)
    onSaved()
    onClose()
  }

  return (
    <div style={modalOverlay}>
      <div style={{ ...modalCard, maxWidth: 'min(560px, 94vw)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3>Add Student</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 14 }}>
          <label style={fieldLabel}>Full name
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} style={input} />
          </label>
          <label style={fieldLabel}>Admission No.
            <input value={admissionNo} onChange={(e) => setAdmissionNo(e.target.value)} style={input} />
          </label>
          <label style={fieldLabel}>Cohort
            <select value={cohort} onChange={(e) => { setCohort(e.target.value); setElectives([]); setOneOfChoice(''); setGrade10Electives([]) }} style={input}>
              <option value="form_3">Form 3</option>
              <option value="form_4">Form 4</option>
              <option value="grade_10">Grade 10</option>
            </select>
          </label>
          {cohort === 'grade_10' && (
            <label style={fieldLabel}>Pathway
              <select value={pathway} onChange={(e) => setPathway(e.target.value)} style={input}>
                <option value="stem">STEM</option>
                <option value="social_sciences">Social Sciences</option>
                <option value="arts_sports">Arts & Sports</option>
              </select>
            </label>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 14 }}>
          <label style={fieldLabel}>{entranceType} score (raw, out of {entranceMax})
            <input type="number" value={entranceRaw} onChange={(e) => setEntranceRaw(e.target.value)} style={input} />
          </label>
          <label style={fieldLabel}>Parent name
            <input value={parentName} onChange={(e) => setParentName(e.target.value)} style={input} />
          </label>
          <label style={fieldLabel}>Parent phone
            <input value={parentPhone} onChange={(e) => setParentPhone(e.target.value)} style={input} />
          </label>
        </div>

        {isForm34 && (
          <>
            <div style={sectionLabel}>Compulsory (auto-included)</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              {COMPULSORY_84.map((s) => <span key={s} style={pillStatic}>{s}</span>)}
            </div>
            <div style={sectionLabel}>Choose one: Physics or Biology, Geography or History</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              {['Physics', 'Biology', 'Geography', 'History'].map((s) => (
                <button key={s} onClick={() => toggleElective(s)} style={pillBtn(electives.includes(s))}>{s}</button>
              ))}
            </div>
            <div style={sectionLabel}>Choose one: Computer, Business, or Agriculture</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              {ONE_OF_GROUP.map((s) => (
                <button key={s} onClick={() => setOneOfChoice(s)} style={pillBtn(oneOfChoice === s)}>{s}</button>
              ))}
            </div>
            <button onClick={() => toggleElective('CRE')} style={{ ...pillBtn(electives.includes('CRE')), marginBottom: 14 }}>+ CRE (optional)</button>
            {blockedMsg && <div style={{ background: COLORS.warnSoft, color: COLORS.warn, padding: '8px 12px', borderRadius: 6, fontSize: 12.5, marginBottom: 14 }}>⚠ {blockedMsg}</div>}
          </>
        )}

        {cohort === 'grade_10' && (
          <>
            <div style={sectionLabel}>Compulsory (auto-included)</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
              {GRADE10_COMPULSORY.map((s) => (
                <span key={s} style={pillStatic}>
                  {s}{GRADE10_NON_EXAMINABLE.includes(s) ? ' (non-examinable)' : ''}
                </span>
              ))}
            </div>
            <p style={{ fontSize: 11, color: COLORS.muted, marginBottom: 14 }}>
              Mathematics is tracked as one subject regardless of Core/Essential — no need to distinguish.
            </p>

            <div style={sectionLabel}>Electives — pick as many as needed (no minimum)</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              {GRADE10_ELECTIVE_MENU.map((s) => (
                <button key={s} onClick={() => toggleGrade10Elective(s)} style={pillBtn(grade10Electives.includes(s))}>{s}</button>
              ))}
            </div>
          </>
        )}

        <div style={sectionLabel}>Past performance (optional — backfills the progress graph)</div>
        {pastExams.map((p, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <input placeholder="e.g. Form 3 Term 2 2025" value={p.label} onChange={(e) => updatePastExam(i, 'label', e.target.value)} style={{ ...input, flex: 2 }} />
            <input placeholder="Points" type="number" value={p.points} onChange={(e) => updatePastExam(i, 'points', e.target.value)} style={{ ...input, flex: 1 }} />
            <input placeholder="Max" type="number" value={p.maxPoints} onChange={(e) => updatePastExam(i, 'maxPoints', e.target.value)} style={{ ...input, width: 70 }} />
          </div>
        ))}
        <button onClick={addPastExamRow} style={{ ...secondaryBtn, marginBottom: 16 }}>+ Add another past exam</button>

        {error && <p style={errorText}>{error}</p>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
          <button onClick={handleSave} disabled={!canSave || saving} style={btn}>{saving ? 'Saving...' : 'Save Student'}</button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// BULK CSV IMPORT — add to StudentsScreen
// Requires papaparse (already installed earlier)
// ============================================================================
const CSV_HEADERS = [
  'full_name', 'admission_no', 'cohort', 'pathway',
  'electives', 'one_of_choice', 'entrance_type', 'entrance_score', 'entrance_max',
  'parent_name', 'parent_phone',
  'past_exam_1_label', 'past_exam_1_points', 'past_exam_1_max_points',
]
const CSV_SAMPLE = [
  ['Faith Wanjiru', 'PWA0099', 'form_4', '', 'Physics;Geography', 'Business Studies', 'KCPE', '390', '500', 'Jane Wanjiru', '0712345678', 'Form 3 Term 2 2025', '70', '84'],
  ['Amani Njeri', 'PWA0142', 'grade_10', 'stem', '', '', 'KJSEA', '51', '72', 'Peter Njeri', '0723456789', '', '', ''],
]

function getCsvTemplate() {
  return Papa.unparse([CSV_HEADERS, ...CSV_SAMPLE])
}

function validateRow(row, allSubjectNames, existingAdmNos, seenAdmNos) {
  const errors = []
  if (!row.full_name?.trim()) errors.push('Missing name')
  if (!row.admission_no?.trim()) errors.push('Missing admission no.')
  else if (existingAdmNos.has(row.admission_no) || seenAdmNos.has(row.admission_no)) errors.push('Duplicate admission no.')
  if (!['form_3', 'form_4', 'grade_10'].includes(row.cohort)) errors.push('Cohort must be form_3, form_4, or grade_10')
  if (row.cohort === 'grade_10' && !['stem', 'social_sciences', 'arts_sports'].includes(row.pathway)) errors.push('Grade 10 needs a valid pathway')

  if (row.cohort === 'form_3' || row.cohort === 'form_4') {
    const electives = (row.electives || '').split(';').map((s) => s.trim()).filter(Boolean)
    for (const [a, b] of EXCLUSION_PAIRS) {
      if (electives.includes(a) && electives.includes(b)) errors.push(`Can't take both ${a} and ${b}`)
    }
    if (row.one_of_choice && !ONE_OF_GROUP.includes(row.one_of_choice)) errors.push('one_of_choice must be Computer Studies, Business Studies, or Agriculture')
  }

  const expectedType = row.cohort === 'grade_10' ? 'KJSEA' : 'KCPE'
  if (row.entrance_type && row.entrance_type !== expectedType) errors.push(`Entrance type should be ${expectedType} for this cohort`)

  return errors
}

function BulkImportModal({ onClose, onImported, allSubjects }) {
  const [rows, setRows] = useState([])
  const [fileName, setFileName] = useState('')
  const [showTemplate, setShowTemplate] = useState(false)
  const [copied, setCopied] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)
  const [existingAdmNos, setExistingAdmNos] = useState(new Set())

  useEffect(() => {
    supabase.from('students').select('admission_no').then(({ data }) => {
      setExistingAdmNos(new Set((data || []).map((s) => s.admission_no)))
    })
  }, [])

  function copyTemplate() {
    navigator.clipboard?.writeText(getCsvTemplate())
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setFileName(file.name)
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const seen = new Set()
        const parsed = results.data.map((row) => {
          const errors = validateRow(row, [], existingAdmNos, seen)
          seen.add(row.admission_no)
          return { ...row, errors }
        })
        setRows(parsed)
      },
    })
  }

  const validRows = rows.filter((r) => r.errors.length === 0)

  async function handleImport() {
    setImporting(true)
    const subjectByName = Object.fromEntries(allSubjects.map((s) => [s.name, s.id]))
    let successCount = 0
    let failCount = 0

    for (const row of validRows) {
      const { data: student, error: studentError } = await supabase.from('students').insert({
        full_name: row.full_name.trim(),
        admission_no: row.admission_no.trim(),
        cohort: row.cohort,
        pathway: row.cohort === 'grade_10' ? row.pathway : null,
        entrance_type: row.entrance_score ? row.entrance_type : null,
        entrance_score: row.entrance_score ? Number(row.entrance_score) : null,
        entrance_max: row.entrance_max ? Number(row.entrance_max) : null,
        parent_name: row.parent_name?.trim() || null,
        parent_phone: row.parent_phone?.trim() || null,
      }).select().single()

      if (studentError) { failCount++; continue }

      if (row.cohort === 'form_3' || row.cohort === 'form_4') {
        const electives = (row.electives || '').split(';').map((s) => s.trim()).filter(Boolean)
        const subjectRows = [
          ...COMPULSORY_84.map((name) => ({ student_id: student.id, subject_id: subjectByName[name], is_compulsory: true })),
          ...electives.map((name) => ({ student_id: student.id, subject_id: subjectByName[name], is_compulsory: false })),
          ...(row.one_of_choice ? [{ student_id: student.id, subject_id: subjectByName[row.one_of_choice], is_compulsory: false }] : []),
        ].filter((r) => r.subject_id)
        if (subjectRows.length > 0) await supabase.from('student_subjects').insert(subjectRows)
      }

      if (row.past_exam_1_label && row.past_exam_1_points) {
        await supabase.from('historical_performance').insert({
          student_id: student.id,
          label: row.past_exam_1_label.trim(),
          order_index: 1,
          points: Number(row.past_exam_1_points),
          max_points: Number(row.past_exam_1_max_points || 84),
        })
      }

      successCount++
    }

    setImporting(false)
    setImportResult({ successCount, failCount })
    onImported()
  }

  return (
    <div style={modalOverlay}>
      <div style={{ ...modalCard, maxWidth: 'min(760px, 96vw)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3>Bulk Import Students</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setShowTemplate((v) => !v)} style={secondaryBtn}>{showTemplate ? 'Hide' : 'View'} CSV template</button>
          <label style={{ ...secondaryBtn, cursor: 'pointer' }}>
            Choose file…
            <input type="file" accept=".csv" onChange={handleFile} style={{ display: 'none' }} />
          </label>
          {fileName && <span style={{ fontSize: 12, color: COLORS.muted }}>{fileName}</span>}
        </div>

        {showTemplate && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11.5, color: COLORS.muted }}>Copy, paste into Excel/Sheets, save as .csv</span>
              <button onClick={copyTemplate} style={{ ...secondaryBtn, padding: '5px 12px', fontSize: 11.5 }}>{copied ? '✓ Copied' : 'Copy'}</button>
            </div>
            <textarea readOnly value={getCsvTemplate()} style={{ width: '100%', height: 90, fontFamily: 'monospace', fontSize: 11, padding: 10, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 6 }} onClick={(e) => e.target.select()} />
          </div>
        )}

        {rows.length > 0 && !importResult && (
          <>
            <div style={{ display: 'flex', gap: 12, marginBottom: 12, fontSize: 12.5 }}>
              <span style={{ color: COLORS.good, fontWeight: 700 }}>✓ {validRows.length} ready to import</span>
              {rows.length - validRows.length > 0 && <span style={{ color: COLORS.warn, fontWeight: 700 }}>⚠ {rows.length - validRows.length} need fixing</span>}
            </div>
            <div style={{ maxHeight: 280, overflowY: 'auto', border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, marginBottom: 16 }}>
              <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead><tr style={{ background: COLORS.paper }}><th style={th}>Name</th><th style={th}>Adm. No.</th><th style={th}>Cohort</th><th style={th}>Status</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${COLORS.ruleLight}`, background: r.errors.length ? COLORS.warnSoft : 'transparent' }}>
                      <td style={td}>{r.full_name || '—'}</td>
                      <td style={{ ...td, color: COLORS.muted }}>{r.admission_no || '—'}</td>
                      <td style={td}>{r.cohort || '—'}</td>
                      <td style={td}>{r.errors.length === 0 ? <span style={{ color: COLORS.good }}>✓ Ready</span> : <span style={{ color: COLORS.warn }}>{r.errors.join('; ')}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {importResult && (
          <div style={{ background: COLORS.goodSoft, padding: 16, borderRadius: 8, marginBottom: 16, fontSize: 13 }}>
            ✓ Imported {importResult.successCount} students{importResult.failCount > 0 ? `, ${importResult.failCount} failed` : ''}.
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={secondaryBtn}>{importResult ? 'Close' : 'Cancel'}</button>
          {!importResult && (
            <button onClick={handleImport} disabled={validRows.length === 0 || importing} style={btn}>
              {importing ? 'Importing...' : `Import ${validRows.length || ''} student${validRows.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}


// ============================================================================
// ADMIN: Edit Student modal — core fields plus enrolled-subject editing
// (compulsory + electives, exclusion rules enforced, without deleting the
// student record).
// ============================================================================
function EditStudentModal({ student, allSubjects, onClose, onSaved }) {
  const { notify } = useNotify()
  const [fullName, setFullName] = useState(student.full_name)
  const [admissionNo, setAdmissionNo] = useState(student.admission_no)
  const [entranceScore, setEntranceScore] = useState(student.entrance_score ?? '')
  const [entranceMax, setEntranceMax] = useState(student.entrance_max ?? '')
  const [parentName, setParentName] = useState(student.parent_name ?? '')
  const [parentPhone, setParentPhone] = useState(student.parent_phone ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [blockedMsg, setBlockedMsg] = useState('')

  const isForm34 = student.cohort === 'form_3' || student.cohort === 'form_4'
  const isGrade10 = student.cohort === 'grade_10'

  const [loadingSubjects, setLoadingSubjects] = useState(isForm34 || isGrade10)
  const [electives, setElectives] = useState([]) // form 3/4: extra electives beyond the one-of-group
  const [oneOfChoice, setOneOfChoice] = useState('') // form 3/4: Computer Studies / Business Studies / Agriculture
  const [grade10Electives, setGrade10Electives] = useState([])

  useEffect(() => {
    if (!isForm34 && !isGrade10) return
    setLoadingSubjects(true)
    supabase.from('student_subjects').select('subject_id, is_compulsory, subjects(name)').eq('student_id', student.id)
      .then(({ data }) => {
        const rows = data || []
        const nonCompulsoryNames = rows.filter((r) => !r.is_compulsory).map((r) => r.subjects?.name).filter(Boolean)
        if (isForm34) {
          const existingOneOf = nonCompulsoryNames.find((n) => ONE_OF_GROUP.includes(n))
          setOneOfChoice(existingOneOf || '')
          setElectives(nonCompulsoryNames.filter((n) => !ONE_OF_GROUP.includes(n)))
        } else {
          setGrade10Electives(nonCompulsoryNames.filter((n) => GRADE10_ELECTIVE_MENU.includes(n)))
        }
        setLoadingSubjects(false)
      })
  }, [student.id])

  function toggleElective(subject) {
    if (electives.includes(subject)) {
      setElectives(electives.filter((s) => s !== subject))
      setBlockedMsg('')
      return
    }
    if (isExcludedTogether(electives, subject)) {
      const pair = EXCLUSION_PAIRS.find(([a, b]) => a === subject || b === subject)
      const conflict = pair.find((s) => s !== subject)
      setBlockedMsg(`Can't add ${subject} — already taking ${conflict}.`)
      return
    }
    setElectives([...electives, subject])
    setBlockedMsg('')
  }

  function toggleGrade10Elective(subject) {
    setGrade10Electives((prev) => (prev.includes(subject) ? prev.filter((s) => s !== subject) : [...prev, subject]))
  }

  const canSave = fullName.trim() && admissionNo.trim() && (!isForm34 || (electives.length > 0 && oneOfChoice))

  async function handleSave() {
    setSaving(true)
    setError('')
    const { error: studentError } = await supabase.from('students').update({
      full_name: fullName.trim(),
      admission_no: admissionNo.trim(),
      entrance_score: entranceScore === '' ? null : Number(entranceScore),
      entrance_max: entranceMax === '' ? null : Number(entranceMax),
      parent_name: parentName.trim() || null,
      parent_phone: parentPhone.trim() || null,
    }).eq('id', student.id)
    if (studentError) { setError(studentError.message); setSaving(false); return }

    if (isForm34 || isGrade10) {
      const subjectByName = Object.fromEntries((allSubjects || []).map((s) => [s.name, s.id]))
      const rows = isForm34
        ? [
            ...COMPULSORY_84.map((name) => ({ student_id: student.id, subject_id: subjectByName[name], is_compulsory: true })),
            ...electives.map((name) => ({ student_id: student.id, subject_id: subjectByName[name], is_compulsory: false })),
            { student_id: student.id, subject_id: subjectByName[oneOfChoice], is_compulsory: false },
          ]
        : [
            ...GRADE10_COMPULSORY.map((name) => ({ student_id: student.id, subject_id: subjectByName[name], is_compulsory: true })),
            ...grade10Electives.map((name) => ({ student_id: student.id, subject_id: subjectByName[name], is_compulsory: false })),
          ]
      const validRows = rows.filter((r) => r.subject_id)

      const { error: deleteError } = await supabase.from('student_subjects').delete().eq('student_id', student.id)
      if (deleteError) { setError(deleteError.message); setSaving(false); return }
      if (validRows.length > 0) {
        const { error: insertError } = await supabase.from('student_subjects').insert(validRows)
        if (insertError) { setError(insertError.message); setSaving(false); return }
      }
    }

    setSaving(false)
    notify(`${fullName.trim()} updated.`)
    onSaved()
    onClose()
  }

  return (
    <div style={modalOverlay}>
      <div style={{ ...modalCard, maxWidth: 'min(520px, 94vw)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3>Edit Student</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <p style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14 }}>
          Cohort can't be changed here — delete and re-add the student if that needs to change.
        </p>
        <label style={fieldLabel}>Full name
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} style={input} />
        </label>
        <label style={fieldLabel}>Admission No.
          <input value={admissionNo} onChange={(e) => setAdmissionNo(e.target.value)} style={input} />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          <label style={fieldLabel}>Entrance score
            <input type="number" value={entranceScore} onChange={(e) => setEntranceScore(e.target.value)} style={input} />
          </label>
          <label style={fieldLabel}>Entrance max
            <input type="number" value={entranceMax} onChange={(e) => setEntranceMax(e.target.value)} style={input} />
          </label>
        </div>
        <label style={fieldLabel}>Parent name
          <input value={parentName} onChange={(e) => setParentName(e.target.value)} style={input} />
        </label>
        <label style={fieldLabel}>Parent phone
          <input value={parentPhone} onChange={(e) => setParentPhone(e.target.value)} style={input} />
        </label>

        {(isForm34 || isGrade10) && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${COLORS.ruleLight}` }}>
            <div style={sectionLabel}>Enrolled Subjects</div>
            {loadingSubjects ? (
              <p style={{ fontSize: 12.5, color: COLORS.muted }}>Loading current subjects...</p>
            ) : isForm34 ? (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  {COMPULSORY_84.map((s) => <span key={s} style={pillStatic}>{s}</span>)}
                </div>
                <label style={fieldLabel}>One of Computer Studies / Business Studies / Agriculture
                  <select value={oneOfChoice} onChange={(e) => setOneOfChoice(e.target.value)} style={input}>
                    <option value="">Select…</option>
                    {ONE_OF_GROUP.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <div style={fieldLabel}>Electives
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                    {['Physics', 'Biology', 'Chemistry', 'Geography', 'History', 'CRE', 'French', 'German'].map((s) => (
                      <span key={s} onClick={() => toggleElective(s)} style={pillBtn(electives.includes(s))}>{s}</span>
                    ))}
                  </div>
                </div>
                {blockedMsg && <p style={{ ...errorText, marginTop: 6 }}>{blockedMsg}</p>}
              </>
            ) : (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  {GRADE10_COMPULSORY.map((s) => <span key={s} style={pillStatic}>{s}</span>)}
                </div>
                <div style={fieldLabel}>Electives
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                    {GRADE10_ELECTIVE_MENU.map((s) => (
                      <span key={s} onClick={() => toggleGrade10Elective(s)} style={pillBtn(grade10Electives.includes(s))}>{s}</span>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {error && <p style={errorText}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
          <button onClick={handleSave} disabled={saving || !canSave} style={btn}>{saving ? 'Saving...' : 'Save Changes'}</button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// STUDENTS SCREEN
// ============================================================================
function StudentsScreen() {
  const { notify, confirmAction } = useNotify()
  const [students, setStudents] = useState([])
  const [subjectsByStudent, setSubjectsByStudent] = useState({}) // { studentId: [subjectName, ...] }
  const [allSubjects, setAllSubjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editingStudent, setEditingStudent] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const [cohortFilter, setCohortFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const isNarrow = useIsNarrow()

  const cohortOptions = [
    { value: 'all', label: 'All Classes' },
    { value: 'form_3', label: 'Form 3' },
    { value: 'form_4', label: 'Form 4' },
    { value: 'grade_10', label: 'Grade 10' },
  ]

  useEffect(() => {
    loadStudents()
    supabase.from('subjects').select('*').then(({ data }) => setAllSubjects(data || []))
  }, [cohortFilter])

  async function loadStudents() {
    setLoading(true)
    let query = supabase.from('students').select('*').order('created_at', { ascending: false })
    if (cohortFilter !== 'all') {
      query = query.eq('cohort', cohortFilter)
    }
    const { data } = await query
    const list = data || []
    setStudents(list)
    setLoading(false)

    if (list.length > 0) {
      const { data: subjectRows } = await supabase
        .from('student_subjects').select('student_id, subjects(name)').in('student_id', list.map((s) => s.id))
      const grouped = {}
      ;(subjectRows || []).forEach((r) => {
        if (!r.subjects?.name) return
        if (!grouped[r.student_id]) grouped[r.student_id] = []
        grouped[r.student_id].push(r.subjects.name)
      })
      setSubjectsByStudent(grouped)
    } else {
      setSubjectsByStudent({})
    }
  }

  async function handleDelete(id, name) {
    const confirmed = await confirmAction(`Delete ${name || 'this student'}? This also removes their marks, subjects, and report history. This cannot be undone.`, { danger: true, confirmLabel: 'Delete' })
    if (!confirmed) return
    setDeletingId(id)

    const { error: marksError } = await supabase.from('marks').delete().eq('student_id', id)
    if (marksError) { setDeletingId(null); notify(`Couldn't delete: ${marksError.message}`, 'error'); return }

    const { error: subjectsError } = await supabase.from('student_subjects').delete().eq('student_id', id)
    if (subjectsError) { setDeletingId(null); notify(`Couldn't delete: ${subjectsError.message}`, 'error'); return }

    const { error: studentError } = await supabase.from('students').delete().eq('id', id)
    setDeletingId(null)
    if (studentError) { notify(`Couldn't delete: ${studentError.message}`, 'error'); return }

    notify(`${name || 'Student'} deleted.`)
    loadStudents()
  }

  const filteredStudents = students.filter((s) => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.trim().toLowerCase()
    return s.full_name?.toLowerCase().includes(q) || s.admission_no?.toLowerCase().includes(q)
  })

  function SubjectTags({ studentId }) {
    const names = subjectsByStudent[studentId] || []
    if (names.length === 0) return <span style={{ color: COLORS.muted, fontSize: 12 }}>—</span>
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {names.map((n) => <span key={n} style={{ ...pillStatic, padding: '2px 9px', fontSize: 11 }}>{n}</span>)}
      </div>
    )
  }

  return (
    <div style={pageWrap}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2>Students</h2>
          <p style={{ color: COLORS.muted, fontSize: 13, margin: 0 }}>{filteredStudents.length} of {students.length} students shown.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowImport(true)} style={secondaryBtn}>Bulk import CSV</button>
          <button onClick={() => setShowAdd(true)} style={btn}>+ Add Student</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <label style={{ ...fieldLabel, maxWidth: 220 }}>Class
          <select value={cohortFilter} onChange={(e) => setCohortFilter(e.target.value)} style={input}>
            {cohortOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label style={{ ...fieldLabel, flex: 1, minWidth: 200 }}>Search
          <input
            placeholder="Search by name or admission no..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={input}
          />
        </label>
      </div>

      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : isNarrow ? (
        // ---- Card layout for phones: no horizontal scrolling needed ----
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filteredStudents.map((s) => (
            <div key={s.id} style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>{s.full_name}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 12.5, marginBottom: 10 }}>
                <div><span style={{ color: COLORS.muted }}>Adm. No.</span><br/>{s.admission_no}</div>
                <div><span style={{ color: COLORS.muted }}>Cohort</span><br/>{s.cohort}{s.pathway ? ` · ${s.pathway}` : ''}</div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <span style={{ color: COLORS.muted }}>Entrance</span><br/>
                  {s.entrance_type ? `${s.entrance_score}/${s.entrance_max}` : '—'}
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <span style={{ color: COLORS.muted }}>Subjects</span><br/>
                  <div style={{ marginTop: 4 }}><SubjectTags studentId={s.id} /></div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16, borderTop: `1px solid ${COLORS.ruleLight}`, paddingTop: 8 }}>
                <button onClick={() => setEditingStudent(s)} style={{ fontSize: 12.5, color: COLORS.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}>Edit</button>
                <button onClick={() => handleDelete(s.id, s.full_name)} disabled={deletingId === s.id} style={{ fontSize: 12.5, color: COLORS.warn, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}>
                  {deletingId === s.id ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
          {filteredStudents.length === 0 && (
            <div style={{ textAlign: 'center', color: COLORS.muted, padding: 24, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
              No students match.
            </div>
          )}
        </div>
      ) : (
        // ---- Table layout for desktop ----
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
          <table style={{ width: '100%', minWidth: 640, borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Name</th><th style={th}>Adm. No.</th><th style={th}>Cohort</th><th style={th}>Subjects</th><th style={th}>Entrance</th><th style={th}></th></tr></thead>
            <tbody>
              {filteredStudents.map((s) => (
                <tr key={s.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                  <td style={td}>{s.full_name}</td>
                  <td style={{ ...td, color: COLORS.muted }}>{s.admission_no}</td>
                  <td style={td}>{s.cohort}{s.pathway ? ` · ${s.pathway}` : ''}</td>
                  <td style={{ ...td, maxWidth: 260 }}><SubjectTags studentId={s.id} /></td>
                  <td style={{ ...td, color: COLORS.muted }}>{s.entrance_type ? `${s.entrance_score}/${s.entrance_max}` : '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                      <button onClick={() => setEditingStudent(s)} style={{ fontSize: 12, color: COLORS.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Edit</button>
                      <button onClick={() => handleDelete(s.id, s.full_name)} disabled={deletingId === s.id} style={{ fontSize: 12, color: COLORS.warn, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        {deletingId === s.id ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredStudents.length === 0 && (
                <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 24 }}>No students match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && <AddStudentModal onClose={() => setShowAdd(false)} onSaved={loadStudents} />}
      {showImport && <BulkImportModal onClose={() => setShowImport(false)} onImported={loadStudents} allSubjects={allSubjects} />}
      {editingStudent && <EditStudentModal student={editingStudent} allSubjects={allSubjects} onClose={() => setEditingStudent(null)} onSaved={loadStudents} />}
    </div>
  )
}

// ============================================================================
// EXAMS SCREEN
// ============================================================================
// ============================================================================
// ADMIN: Exam Marks Overview — see every student's marks for an exam,
// organized by cohort
// ============================================================================
function ExamMarksOverview({ exam, onBack }) {
  const [cohort, setCohort] = useState('form_4')
  const [students, setStudents] = useState([])
  const [subjectColumns, setSubjectColumns] = useState([])
  const [studentSubjects, setStudentSubjects] = useState({}) // { studentId: [{id, name}, ...] } — this student's own enrollment
  const [marksGrid, setMarksGrid] = useState({}) // { studentId: { subjectId: score } }
  const [rankings, setRankings] = useState({}) // { studentId: { rnk, total_points, max_points } }
  const [loading, setLoading] = useState(true)
  const [viewingStudent, setViewingStudent] = useState(null)
  const isNarrow = useIsNarrow()

  const cohortOptions = [
    { value: 'form_3', label: 'Form 3' },
    { value: 'form_4', label: 'Form 4' },
    { value: 'grade_10', label: 'Grade 10' },
  ]
  const isGrade10 = cohort === 'grade_10'

  useEffect(() => { loadOverview() }, [cohort])

  async function loadOverview() {
    setLoading(true)
    const { data: studentData } = await supabase.from('students').select('id, full_name, admission_no').eq('cohort', cohort).order('full_name')
    setStudents(studentData || [])
    const studentIds = (studentData || []).map((s) => s.id)

    if (studentIds.length === 0) {
      setSubjectColumns([])
      setStudentSubjects({})
      setMarksGrid({})
      setRankings({})
      setLoading(false)
      return
    }

    const { data: enrollments } = await supabase
      .from('student_subjects').select('student_id, subject_id, subjects(id, name)').in('student_id', studentIds)
    const subjectMap = {}
    const perStudent = {}
    ;(enrollments || []).forEach((e) => {
      if (!e.subjects) return
      subjectMap[e.subjects.id] = e.subjects.name
      if (!perStudent[e.student_id]) perStudent[e.student_id] = []
      perStudent[e.student_id].push({ id: e.subjects.id, name: e.subjects.name })
    })
    const columns = Object.entries(subjectMap).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
    setSubjectColumns(columns)
    Object.values(perStudent).forEach((list) => list.sort((a, b) => a.name.localeCompare(b.name)))
    setStudentSubjects(perStudent)

    const { data: marksData } = await supabase
      .from('marks').select('student_id, subject_id, score').eq('exam_id', exam.id).in('student_id', studentIds)
    const grid = {}
    ;(marksData || []).forEach((m) => {
      if (!grid[m.student_id]) grid[m.student_id] = {}
      grid[m.student_id][m.subject_id] = m.score
    })
    setMarksGrid(grid)

    const { data: rankData } = await supabase.rpc('compute_cohort_rankings', { p_cohort: cohort, p_exam_id: exam.id })
    const rankMap = {}
    ;(rankData || []).forEach((r) => { rankMap[r.student_id] = r })
    setRankings(rankMap)

    setLoading(false)
  }

  return (
    <div style={pageWrap}>
      <button onClick={onBack} style={{ ...secondaryBtn, marginBottom: 16 }}>← Back to Exams</button>
      <h2>{exam.name} — Marks Overview</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 16 }}>{exam.term} {exam.year}</p>

      <label style={{ ...fieldLabel, marginBottom: 18, maxWidth: 220 }}>Cohort
        <select value={cohort} onChange={(e) => setCohort(e.target.value)} style={input}>
          {cohortOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>

      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : students.length === 0 ? (
        <div style={{ textAlign: 'center', color: COLORS.muted, padding: 24, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
          No students in this cohort yet.
        </div>
      ) : isGrade10 ? (
        // ---- Grade 10 CBC: compact summary list, per-student subjects vary ----
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
          <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: COLORS.paper }}>
                <th style={th}>Student Name</th>
                <th style={th}>Adm No</th>
                <th style={{ ...th, textAlign: 'center' }}>Total Subjects Taken</th>
                <th style={{ ...th, textAlign: 'center' }}>Total Points/Max</th>
                <th style={{ ...th, textAlign: 'center' }}>Position</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {students.map((s) => {
                const rank = rankings[s.id]
                const subjects = studentSubjects[s.id] || []
                return (
                  <tr key={s.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                    <td style={{ ...td, fontWeight: 600 }}>{s.full_name}</td>
                    <td style={{ ...td, color: COLORS.muted }}>{s.admission_no}</td>
                    <td style={{ ...td, textAlign: 'center' }}>{subjects.length}</td>
                    <td style={{ ...td, textAlign: 'center', fontWeight: 700 }}>{rank ? `${rank.total_points}/${rank.max_points}` : '—'}</td>
                    <td style={{ ...td, textAlign: 'center', fontWeight: 700, color: COLORS.accent }}>{rank ? rank.rnk : '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button onClick={() => setViewingStudent(s)} style={{ fontSize: 12, color: COLORS.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}>
                        View Marks
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
          <table style={{ width: '100%', minWidth: 480 + subjectColumns.length * 90, borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: COLORS.paper }}>
                <th style={{ ...th, position: isNarrow ? 'static' : 'sticky', left: 0, background: COLORS.paper, zIndex: 1 }}>Student</th>
                {subjectColumns.map((c) => <th key={c.id} style={{ ...th, textAlign: 'center' }}>{c.name}</th>)}
                <th style={{ ...th, textAlign: 'center' }}>Total</th>
                <th style={{ ...th, textAlign: 'center' }}>Position</th>
              </tr>
            </thead>
            <tbody>
              {students.map((s) => {
                const rank = rankings[s.id]
                return (
                  <tr key={s.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                    <td style={{ ...td, position: isNarrow ? 'static' : 'sticky', left: 0, background: '#fff', fontWeight: 600 }}>
                      {s.full_name}
                      <div style={{ fontSize: 10.5, color: COLORS.muted, fontWeight: 400 }}>{s.admission_no}</div>
                    </td>
                    {subjectColumns.map((c) => (
                      <td key={c.id} style={{ ...td, textAlign: 'center' }}>
                        {marksGrid[s.id]?.[c.id] ?? '—'}
                      </td>
                    ))}
                    <td style={{ ...td, textAlign: 'center', fontWeight: 700 }}>
                      {rank ? `${rank.total_points}/${rank.max_points}` : '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'center', fontWeight: 700, color: COLORS.accent }}>
                      {rank ? rank.rnk : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {viewingStudent && (
        <div style={modalOverlay} onClick={() => setViewingStudent(null)}>
          <div style={{ ...modalCard, maxWidth: 'min(440px, 94vw)' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>{viewingStudent.full_name}</h3>
              <button onClick={() => setViewingStudent(null)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>
            <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 16 }}>{viewingStudent.admission_no}</p>
            <div style={{ border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: COLORS.paper }}>
                    <th style={th}>Subject</th>
                    <th style={{ ...th, textAlign: 'center' }}>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {(studentSubjects[viewingStudent.id] || []).map((subj) => (
                    <tr key={subj.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                      <td style={td}>{subj.name}</td>
                      <td style={{ ...td, textAlign: 'center' }}>{marksGrid[viewingStudent.id]?.[subj.id] ?? '—'}</td>
                    </tr>
                  ))}
                  {(studentSubjects[viewingStudent.id] || []).length === 0 && (
                    <tr><td colSpan={2} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 16 }}>No subjects enrolled.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {rankings[viewingStudent.id] && (
              <div style={{ marginTop: 14, fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                <span><strong>Total:</strong> {rankings[viewingStudent.id].total_points}/{rankings[viewingStudent.id].max_points}</span>
                <span style={{ color: COLORS.accent, fontWeight: 700 }}>Position {rankings[viewingStudent.id].rnk}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ExamsScreen() {
  const { notify, confirmAction } = useNotify()
  const [exams, setExams] = useState([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [term, setTerm] = useState('Term 1')
  const [year, setYear] = useState(2026)
  const [resumeDate, setResumeDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [editingResumeId, setEditingResumeId] = useState(null)
  const [editingResumeValue, setEditingResumeValue] = useState('')

  // Officials (Principal/Manager names + signatures) for the new exam
  const [officialsMode, setOfficialsMode] = useState('same') // 'same' | 'new'
  const [principalName, setPrincipalName] = useState('')
  const [managerName, setManagerName] = useState('')
  const [principalSigFile, setPrincipalSigFile] = useState(null)
  const [managerSigFile, setManagerSigFile] = useState(null)
  const [editingOfficialsId, setEditingOfficialsId] = useState(null)

  useEffect(() => { loadExams() }, [])

  async function loadExams() {
    setLoading(true)
    const { data } = await supabase.from('exams').select('*').order('order_index', { ascending: true })
    setExams(data || [])
    setLoading(false)
  }

  const previousExam = exams.length > 0 ? exams[exams.length - 1] : null
  const hasPreviousOfficials = previousExam && (previousExam.principal_name || previousExam.manager_name)

  async function uploadSignature(file, label) {
    if (!file) return null
    const ext = file.name.split('.').pop()
    const path = `${label}-${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('signatures').upload(path, file)
    if (error) return null
    const { data } = supabase.storage.from('signatures').getPublicUrl(path)
    return data.publicUrl
  }

  async function createExam() {
    if (!name.trim()) return
    setSaving(true)
    const nextOrder = exams.length > 0 ? Math.max(...exams.map((e) => e.order_index)) + 1 : 1
    const { data: { user } } = await supabase.auth.getUser()

    let officials = {}
    if (officialsMode === 'same' && previousExam) {
      officials = {
        principal_name: previousExam.principal_name,
        manager_name: previousExam.manager_name,
        principal_signature_url: previousExam.principal_signature_url,
        manager_signature_url: previousExam.manager_signature_url,
      }
    } else {
      const [pUrl, mUrl] = await Promise.all([
        uploadSignature(principalSigFile, 'principal'),
        uploadSignature(managerSigFile, 'manager'),
      ])
      officials = {
        principal_name: principalName.trim() || null,
        manager_name: managerName.trim() || null,
        principal_signature_url: pUrl,
        manager_signature_url: mUrl,
      }
    }

    await supabase.from('exams').insert({
      name: name.trim(), term, year, order_index: nextOrder, created_by: user.id,
      term_resumes_on: resumeDate || null,
      ...officials,
    })
    setName('')
    setResumeDate('')
    setPrincipalName('')
    setManagerName('')
    setPrincipalSigFile(null)
    setManagerSigFile(null)
    setOfficialsMode('same')
    setSaving(false)
    loadExams()
  }

  async function saveResumeDate(examId) {
    await supabase.from('exams').update({ term_resumes_on: editingResumeValue || null }).eq('id', examId)
    setEditingResumeId(null)
    loadExams()
  }

  async function saveOfficialsEdit(examId, pName, mName, pFile, mFile) {
    const updates = { principal_name: pName.trim() || null, manager_name: mName.trim() || null }
    if (pFile) updates.principal_signature_url = await uploadSignature(pFile, 'principal')
    if (mFile) updates.manager_signature_url = await uploadSignature(mFile, 'manager')
    await supabase.from('exams').update(updates).eq('id', examId)
    setEditingOfficialsId(null)
    loadExams()
  }

  async function handleDeleteExam(examId, examName) {
    const confirmed = await confirmAction(
      `Permanently delete "${examName}"? This also removes every mark and report card recorded for this exam. This cannot be undone.`,
      { danger: true, confirmLabel: 'Delete Exam' }
    )
    if (!confirmed) return
    setDeletingId(examId)

    const { error: reportCardsError } = await supabase.from('report_cards').delete().eq('exam_id', examId)
    if (reportCardsError) { setDeletingId(null); notify(`Couldn't delete: ${reportCardsError.message}`, 'error'); return }

    const { error: marksError } = await supabase.from('marks').delete().eq('exam_id', examId)
    if (marksError) { setDeletingId(null); notify(`Couldn't delete: ${marksError.message}`, 'error'); return }

    const { error: examError } = await supabase.from('exams').delete().eq('id', examId)
    setDeletingId(null)
    if (examError) { notify(`Couldn't delete: ${examError.message}`, 'error'); return }

    notify(`${examName} deleted.`)
    loadExams()
  }


  const isNarrow = useIsNarrow()
  const [viewingExam, setViewingExam] = useState(null)

  if (viewingExam) {
    return <ExamMarksOverview exam={viewingExam} onBack={() => setViewingExam(null)} />
  }

  return (
    <div style={pageWrap}>
      <h2>Exams</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 20 }}>Create a new exam whenever one happens — no fixed schedule required.</p>

      <div style={{
        background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 18, marginBottom: 24,
      }}>
        <div style={{ display: 'flex', flexDirection: isNarrow ? 'column' : 'row', gap: 12, alignItems: isNarrow ? 'stretch' : 'flex-end', flexWrap: 'wrap', marginBottom: 18 }}>
          <label style={fieldLabel}>Exam name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Term 2 Opener" style={input} />
          </label>
          <label style={fieldLabel}>Term
            <select value={term} onChange={(e) => setTerm(e.target.value)} style={input}>
              <option>Term 1</option><option>Term 2</option><option>Term 3</option>
            </select>
          </label>
          <label style={fieldLabel}>Year
            <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} style={input} />
          </label>
          <label style={fieldLabel}>Term resumes on (optional)
            <input type="date" value={resumeDate} onChange={(e) => setResumeDate(e.target.value)} style={input} />
          </label>
        </div>

        <div style={{ borderTop: `1px solid ${COLORS.ruleLight}`, paddingTop: 14, marginBottom: 14 }}>
          <div style={sectionLabel}>Signing Officials for this exam</div>
          {hasPreviousOfficials && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <button onClick={() => setOfficialsMode('same')} style={officialsMode === 'same' ? btn : secondaryBtn}>
                Same as last time
              </button>
              <button onClick={() => setOfficialsMode('new')} style={officialsMode === 'new' ? btn : secondaryBtn}>
                Enter new details
              </button>
            </div>
          )}

          {officialsMode === 'same' && hasPreviousOfficials ? (
            <div style={{ fontSize: 12.5, color: COLORS.muted, background: COLORS.paper, padding: '10px 12px', borderRadius: 6 }}>
              Will reuse: <strong style={{ color: COLORS.ink }}>{previousExam.principal_name || '—'}</strong> (Principal) &nbsp;·&nbsp;
              <strong style={{ color: COLORS.ink }}>{previousExam.manager_name || '—'}</strong> (Manager)
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: isNarrow ? 'column' : 'row', gap: 12, flexWrap: 'wrap' }}>
              <label style={fieldLabel}>Principal's name
                <input value={principalName} onChange={(e) => setPrincipalName(e.target.value)} style={input} placeholder="School Principal" />
              </label>
              <label style={fieldLabel}>Principal's signature (image)
                <input type="file" accept="image/*" onChange={(e) => setPrincipalSigFile(e.target.files[0])} style={input} />
              </label>
              <label style={fieldLabel}>School Manager's name
                <input value={managerName} onChange={(e) => setManagerName(e.target.value)} style={input} placeholder="School Manager" />
              </label>
              <label style={fieldLabel}>School Manager's signature (image)
                <input type="file" accept="image/*" onChange={(e) => setManagerSigFile(e.target.files[0])} style={input} />
              </label>
            </div>
          )}
        </div>

        <button onClick={createExam} disabled={saving} style={{ ...btn, width: isNarrow ? '100%' : 'auto' }}>{saving ? 'Creating...' : '+ Create Exam'}</button>
      </div>

      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : isNarrow ? (
        // ---- Card layout for phones ----
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {exams.map((e) => (
            <div key={e.id} style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{e.name}</div>
                <div style={{ fontSize: 11, color: COLORS.muted }}>#{e.order_index}</div>
              </div>
              <div style={{ fontSize: 12.5, color: COLORS.muted, marginBottom: 8 }}>{e.term} {e.year}</div>
              <div style={{ borderTop: `1px solid ${COLORS.ruleLight}`, paddingTop: 8, fontSize: 12.5 }}>
                <span style={{ color: COLORS.muted }}>Term Resumes: </span>
                {editingResumeId === e.id ? (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <input type="date" value={editingResumeValue} onChange={(ev) => setEditingResumeValue(ev.target.value)} style={{ ...input, marginBottom: 0, flex: 1 }} />
                    <button onClick={() => saveResumeDate(e.id)} style={{ ...secondaryBtn, padding: '6px 12px' }}>Save</button>
                  </div>
                ) : (
                  <span
                    onClick={() => { setEditingResumeId(e.id); setEditingResumeValue(e.term_resumes_on || '') }}
                    style={{ cursor: 'pointer', color: e.term_resumes_on ? COLORS.ink : COLORS.accent, fontWeight: 600 }}
                  >
                    {e.term_resumes_on ? new Date(e.term_resumes_on).toLocaleDateString('en-GB') : 'Set date →'}
                  </span>
                )}
              </div>
              <button onClick={() => setViewingExam(e)} style={{ ...secondaryBtn, marginTop: 10, width: '100%', fontSize: 12 }}>
                📊 View Marks
              </button>
              <button
                onClick={() => handleDeleteExam(e.id, e.name)}
                disabled={deletingId === e.id}
                style={{ ...secondaryBtn, marginTop: 6, width: '100%', fontSize: 12, color: COLORS.warn, borderColor: COLORS.warn }}
              >
                {deletingId === e.id ? 'Deleting...' : '🗑 Delete Exam'}
              </button>
            </div>
          ))}
          {exams.length === 0 && (
            <div style={{ textAlign: 'center', color: COLORS.muted, padding: 24, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
              No exams yet.
            </div>
          )}
        </div>
      ) : (
        // ---- Table layout for desktop ----
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
          <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>#</th><th style={th}>Exam</th><th style={th}>Term</th><th style={th}>Year</th><th style={th}>Term Resumes</th><th style={th}></th></tr></thead>
            <tbody>
              {exams.map((e) => (
                <tr key={e.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                  <td style={{ ...td, color: COLORS.muted }}>{e.order_index}</td>
                  <td style={td}>{e.name}</td>
                  <td style={td}>{e.term}</td>
                  <td style={td}>{e.year}</td>
                  <td style={td}>
                    {editingResumeId === e.id ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input type="date" value={editingResumeValue} onChange={(ev) => setEditingResumeValue(ev.target.value)} style={{ ...input, marginBottom: 0, padding: '4px 6px' }} />
                        <button onClick={() => saveResumeDate(e.id)} style={{ ...secondaryBtn, padding: '4px 10px' }}>Save</button>
                      </div>
                    ) : (
                      <span
                        onClick={() => { setEditingResumeId(e.id); setEditingResumeValue(e.term_resumes_on || '') }}
                        style={{ cursor: 'pointer', color: e.term_resumes_on ? COLORS.ink : COLORS.muted }}
                      >
                        {e.term_resumes_on ? new Date(e.term_resumes_on).toLocaleDateString('en-GB') : 'Set date →'}
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button onClick={() => setViewingExam(e)} style={{ fontSize: 12, color: COLORS.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginRight: 14 }}>
                      📊 View Marks
                    </button>
                    <button
                      onClick={() => handleDeleteExam(e.id, e.name)}
                      disabled={deletingId === e.id}
                      style={{ fontSize: 12, color: COLORS.warn, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                    >
                      {deletingId === e.id ? 'Deleting...' : '🗑 Delete'}
                    </button>
                  </td>
                </tr>
              ))}
              {exams.length === 0 && (
                <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 24 }}>No exams yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// TEACHER: First-login self-assignment
// ============================================================================
const CLASS_OPTIONS = [
  { value: 'form_3', label: 'Form 3' },
  { value: 'form_4', label: 'Form 4' },
  { value: 'grade_10', label: 'Grade 10' },
]

// Which curriculum each class belongs to — used to pick the right set of
// "concurrent subject" constraints (e.g. Physics/Biology run at the same
// time) when generating the timetable.
const CURRICULUM_FOR_CLASS = { form_3: '844', form_4: '844', grade_10: 'cbc' }
const CURRICULUM_LABELS = { '844': '8-4-4 (Form 3/4)', cbc: 'CBC (Grade 10)' }

function TeacherOnboarding({ teacherId, onDone }) {
  const [allSubjects, setAllSubjects] = useState([])
  const [assignments, setAssignments] = useState([{ subjectId: '', classLabel: '' }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.from('subjects').select('*').order('name').then(({ data }) => setAllSubjects(data || []))
  }, [])

  function update(i, field, value) {
    setAssignments((prev) => prev.map((a, idx) => (idx === i ? { ...a, [field]: value } : a)))
  }
  function addRow() {
    setAssignments((prev) => [...prev, { subjectId: '', classLabel: '' }])
  }
  function removeRow(i) {
    setAssignments((prev) => prev.filter((_, idx) => idx !== i))
  }

  const canSave = assignments.every((a) => a.subjectId && a.classLabel)

  async function handleSave() {
    setSaving(true)
    setError('')
    const rows = assignments.map((a) => ({
      teacher_id: teacherId,
      subject_id: a.subjectId,
      class_label: a.classLabel,
      status: 'pending', // Dean of Studies must approve before this feeds the timetable generator
    }))
    const { error } = await supabase.from('teacher_assignments').insert(rows)
    if (error) {
      setError(error.message)
      setSaving(false)
      return
    }
    setSaving(false)
    onDone()
  }

  return (
    <div style={wrap}>
      <div style={{ ...card, width: 480 }}>
        <h3>Welcome — one quick step</h3>
        <p style={{ fontSize: 13, color: COLORS.muted, marginBottom: 18 }}>
          Tell us what you teach so you only see the right classes when entering marks. You can start entering marks right away — the Dean of Studies will confirm these before they appear on the school timetable.
        </p>

        {assignments.map((a, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <select value={a.subjectId} onChange={(e) => update(i, 'subjectId', e.target.value)} style={{ ...input, flex: 1.4, marginBottom: 0 }}>
              <option value="">Subject…</option>
              {allSubjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select value={a.classLabel} onChange={(e) => update(i, 'classLabel', e.target.value)} style={{ ...input, flex: 1, marginBottom: 0 }}>
              <option value="">Class…</option>
              {CLASS_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            {assignments.length > 1 && (
              <button onClick={() => removeRow(i)} style={secondaryBtn}>✕</button>
            )}
          </div>
        ))}

        <button onClick={addRow} style={{ ...secondaryBtn, marginBottom: 18 }}>+ Add another subject/class</button>
        {error && <p style={errorText}>{error}</p>}
        <button onClick={handleSave} disabled={!canSave || saving} style={{ ...btn, width: '100%' }}>
          {saving ? 'Saving...' : 'Continue to Marks Entry'}
        </button>
      </div>
    </div>
  )
}

// ============================================================================
// TEACHER: Marks Entry
// ============================================================================
function MarksEntryContent({ teacherId, adminMode = false }) {
  const { notify } = useNotify()
  const [showManage, setShowManage] = useState(false)
  const [myAssignments, setMyAssignments] = useState([])
  const [selectedAssignment, setSelectedAssignment] = useState('')
  const [allSubjects, setAllSubjects] = useState([])
  const [manualSubjectId, setManualSubjectId] = useState('')
  const [manualClassLabel, setManualClassLabel] = useState('')
  const [exams, setExams] = useState([])
  const [selectedExamId, setSelectedExamId] = useState('')
  const [students, setStudents] = useState([])
  const [marksByStudent, setMarksByStudent] = useState({})
  const [prevMarksByStudent, setPrevMarksByStudent] = useState({})
  const [drafts, setDrafts] = useState({})
  const [remarkDrafts, setRemarkDrafts] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const [generatingIds, setGeneratingIds] = useState(new Set())
  const [bulkGenerating, setBulkGenerating] = useState(false)
  const [remarkBulkMsg, setRemarkBulkMsg] = useState('')
  const isNarrow = useIsNarrow()
  // In admin mode (Leadership titles), a "virtual" assignment is built from
  // the manually picked subject + class instead of a teacher_assignments row,
  // so these admins can mark any subject/class without self-assigning first.
  function currentAssignment() {
    if (adminMode) {
      if (!manualSubjectId || !manualClassLabel) return null
      return {
        subject_id: manualSubjectId,
        class_label: manualClassLabel,
        subjects: { name: allSubjects.find((s) => s.id === manualSubjectId)?.name },
      }
    }
    return myAssignments.find((a) => a.id === selectedAssignment) || null
  }
  useEffect(() => { loadAssignmentsAndExams() }, [teacherId, adminMode])
  useEffect(() => {
    const ready = adminMode ? (manualSubjectId && manualClassLabel) : selectedAssignment
    if (ready && selectedExamId) loadStudentsAndMarks()
  }, [selectedAssignment, manualSubjectId, manualClassLabel, selectedExamId])
  async function loadAssignmentsAndExams() {
    setLoading(true)
    if (adminMode) {
      const [{ data: subjectData }, { data: examData }] = await Promise.all([
        supabase.from('subjects').select('*').order('name'),
        supabase.from('exams').select('*').order('order_index', { ascending: false }),
      ])
      setAllSubjects(subjectData || [])
      setExams(examData || [])
      if (examData && examData.length > 0) setSelectedExamId(examData[0].id)
      setLoading(false)
      return
    }
    const [{ data: assignData }, { data: examData }] = await Promise.all([
      supabase.from('teacher_assignments').select('*, subjects(name)').eq('teacher_id', teacherId),
      supabase.from('exams').select('*').order('order_index', { ascending: false }),
    ])
    setMyAssignments(assignData || [])
    setExams(examData || [])
    if (assignData && assignData.length > 0) setSelectedAssignment(assignData[0].id)
    if (examData && examData.length > 0) setSelectedExamId(examData[0].id)
    setLoading(false)
  }
  async function loadStudentsAndMarks() {
    setLoading(true)
    const assignment = currentAssignment()
    if (!assignment) { setLoading(false); return }
    const { data: classStudents } = await supabase
      .from('students').select('*').eq('cohort', assignment.class_label).order('full_name')
    const classStudentIds = (classStudents || []).map((s) => s.id)
    // Only show students actually enrolled in this subject — not the whole class,
    // since Grade 10 electives (and even Form 3/4 elective groups) mean not
    // every student in a class takes every subject. But students who predate
    // subject-enrollment tracking (or slipped through an import without it)
    // have NO student_subjects rows at all — for those, we can't tell what
    // they take, so show them rather than silently hiding the whole class.
    const { data: allEnrollmentRows } = await supabase
      .from('student_subjects').select('student_id, subject_id').in('student_id', classStudentIds)
    const enrolledForSubject = new Set(
      (allEnrollmentRows || []).filter((r) => r.subject_id === assignment.subject_id).map((r) => r.student_id)
    )
    const anyEnrollmentRecord = new Set((allEnrollmentRows || []).map((r) => r.student_id))
    const studentData = (classStudents || []).filter(
      (s) => enrolledForSubject.has(s.id) || !anyEnrollmentRecord.has(s.id)
    )
    setStudents(studentData || [])
    const { data: marksData } = await supabase
      .from('marks').select('*')
      .eq('subject_id', assignment.subject_id)
      .eq('exam_id', selectedExamId)
    const byStudent = {}
    ;(marksData || []).forEach((m) => { byStudent[m.student_id] = m })
    setMarksByStudent(byStudent)
    setDrafts({})
    const remarkInit = {}
    ;(marksData || []).forEach((m) => { if (m.remark) remarkInit[m.student_id] = m.remark })
    setRemarkDrafts(remarkInit)
    // Pull the same subject's marks from the exam immediately before this
    // one, so generated remarks can reference "previous performance".
    const currentExamObj = exams.find((e) => e.id === selectedExamId)
    const prevExam = currentExamObj
      ? exams.filter((e) => e.order_index < currentExamObj.order_index).sort((a, b) => b.order_index - a.order_index)[0]
      : null
    let prevByStudent = {}
    if (prevExam) {
      const { data: prevMarksData } = await supabase
        .from('marks').select('*')
        .eq('subject_id', assignment.subject_id)
        .eq('exam_id', prevExam.id)
      ;(prevMarksData || []).forEach((m) => { prevByStudent[m.student_id] = m })
    }
    setPrevMarksByStudent(prevByStudent)
    setLoading(false)
  }
  function updateDraft(studentId, value) {
    setDrafts((prev) => ({ ...prev, [studentId]: value }))
  }
  function updateRemarkDraft(studentId, value) {
    setRemarkDrafts((prev) => ({ ...prev, [studentId]: value }))
  }
  function currentScoreFor(studentId) {
    const draft = drafts[studentId]
    if (draft !== undefined && draft !== '') return draft
    return marksByStudent[studentId]?.score
  }
  // Core call, no alerting — used by both the single button and bulk run
  // so bulk can collect failures instead of popping N alerts.
  async function runGenerate(studentId) {
    const student = students.find((s) => s.id === studentId)
    const assignment = currentAssignment()
    const subjectName = assignment?.subjects?.name || 'Subject'
    const score = currentScoreFor(studentId)
    const prevScore = prevMarksByStudent[studentId]?.score
    const currentGrades = score !== undefined && score !== null && score !== ''
      ? [{ name: subjectName, score }] : []
    const previousGrades = prevScore !== undefined && prevScore !== null
      ? [{ name: subjectName, score: prevScore }] : []
    const remark = await generateStudentRemark(student, currentGrades, previousGrades)
    updateRemarkDraft(studentId, remark)
  }
  async function generateRemarkFor(studentId) {
    setGeneratingIds((prev) => new Set(prev).add(studentId))
    try {
      await runGenerate(studentId)
    } catch (err) {
      const name = students.find((s) => s.id === studentId)?.full_name || 'this student'
      notify(`Couldn't generate a remark for ${name}: ${err.message}`, 'error')
    } finally {
      setGeneratingIds((prev) => { const next = new Set(prev); next.delete(studentId); return next })
    }
  }
  async function generateAllRemarks() {
    const targets = students
      .filter((s) => {
        const score = currentScoreFor(s.id)
        return score !== undefined && score !== null && score !== ''
      })
      .map((s) => s.id)
    if (targets.length === 0) {
      setRemarkBulkMsg('No students have a score entered yet — nothing to summarize.')
      return
    }
    setBulkGenerating(true)
    setRemarkBulkMsg('')
    setGeneratingIds(new Set(targets))
    let ok = 0
    let failed = 0
    let lastError = ''
    const CONCURRENCY = 3 // gentler on the Gemini API than the DB batch size elsewhere
    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      const batch = targets.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(async (id) => {
        try {
          await runGenerate(id)
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err.message }
        }
      }))
      results.forEach((r) => {
        if (r.ok) ok++
        else { failed++; lastError = r.error }
      })
    }
    setGeneratingIds(new Set())
    setBulkGenerating(false)
    setRemarkBulkMsg(
      failed === 0
        ? `Generated ${ok} remark${ok === 1 ? '' : 's'}.`
        : `Generated ${ok}, ${failed} failed (${lastError}). Remaining students unaffected.`
    )
  }
  async function saveAll() {
    setSaving(true)
    setSavedMsg('')
    const assignment = currentAssignment()
    const rows = Object.entries(drafts)
      .filter(([, v]) => v !== '' && v !== undefined)
      .map(([studentId, value]) => ({
        student_id: studentId,
        subject_id: assignment.subject_id,
        exam_id: selectedExamId,
        score: Number(value),
        remark: remarkDrafts[studentId] || null,
        entered_by: teacherId,
      }))
    if (rows.length === 0) { setSaving(false); return }
    const { error } = await supabase.from('marks').upsert(rows, { onConflict: 'student_id,subject_id,exam_id' })
    if (!error) {
      setSavedMsg(`Saved ${rows.length} mark${rows.length === 1 ? '' : 's'} at ${new Date().toLocaleTimeString()}`)
      loadStudentsAndMarks()
    }
    setSaving(false)
  }
  const assignment = currentAssignment()
  const enteredCount = students.filter((s) => marksByStudent[s.id] || drafts[s.id] !== undefined).length
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
        <h2>Marks Entry{adminMode ? ' — Any Class' : ''}</h2>
        {!adminMode && (
          <button onClick={() => setShowManage(true)} style={secondaryBtn}>+ Add another subject/class</button>
        )}
      </div>
      {adminMode && (
        <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 4 }}>
          As a Leadership admin you can enter or correct marks for any subject and class directly — no need to self-assign first.
        </p>
      )}
      {!adminMode && myAssignments.length === 0 ? (
        <p style={{ color: COLORS.muted }}>No subjects assigned yet.</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
            {adminMode ? (
              <>
                <label style={fieldLabel}>Subject
                  <select value={manualSubjectId} onChange={(e) => setManualSubjectId(e.target.value)} style={{ ...input, minWidth: 180 }}>
                    <option value="">Choose subject…</option>
                    {allSubjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label style={fieldLabel}>Class
                  <select value={manualClassLabel} onChange={(e) => setManualClassLabel(e.target.value)} style={{ ...input, minWidth: 160 }}>
                    <option value="">Choose class…</option>
                    {CLASS_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </label>
              </>
            ) : (
              <label style={fieldLabel}>Subject / Class
                <select value={selectedAssignment} onChange={(e) => setSelectedAssignment(e.target.value)} style={{ ...input, minWidth: 220 }}>
                  {myAssignments.map((a) => (
                    <option key={a.id} value={a.id}>{a.subjects?.name} — {CLASS_OPTIONS.find((c) => c.value === a.class_label)?.label}</option>
                  ))}
                </select>
              </label>
            )}
            <label style={fieldLabel}>Exam
              <select value={selectedExamId} onChange={(e) => setSelectedExamId(e.target.value)} style={{ ...input, minWidth: 220 }}>
                {exams.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.term} {e.year}</option>)}
              </select>
            </label>
            <div style={{ marginLeft: 'auto', fontSize: 12, color: COLORS.muted, alignSelf: 'flex-end', paddingBottom: 10 }}>
              {enteredCount} / {students.length} entered
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: COLORS.muted }}>{remarkBulkMsg}</span>
            <button onClick={generateAllRemarks} disabled={bulkGenerating || students.length === 0} style={secondaryBtn}>
              {bulkGenerating ? 'Generating remarks...' : '✨ Generate All Remarks'}
            </button>
          </div>
          {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : isNarrow ? (
            // ---- Card layout for phones ----
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {students.map((s) => {
                const existing = marksByStudent[s.id]
                const draft = drafts[s.id]
                const hasValue = draft !== undefined ? draft !== '' : !!existing
                const isGenerating = generatingIds.has(s.id)
                return (
                  <div key={s.id} style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{s.full_name}</div>
                        <div style={{ fontSize: 11.5, color: COLORS.muted }}>{s.admission_no}</div>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: hasValue ? COLORS.good : COLORS.warn, whiteSpace: 'nowrap' }}>
                        {hasValue ? '● Entered' : '○ Pending'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                      <label style={{ ...fieldLabel, flex: '0 0 80px' }}>Score
                        <input
                          type="number" min={0} max={100}
                          defaultValue={existing ? existing.score : ''}
                          onChange={(e) => updateDraft(s.id, e.target.value)}
                          style={{ width: '100%', padding: '8px', textAlign: 'center', border: `1px solid ${COLORS.rule}`, borderRadius: 4, boxSizing: 'border-box' }}
                        />
                      </label>
                      <label style={{ ...fieldLabel, flex: 1 }}>Remark
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input
                            type="text" placeholder="Optional…"
                            value={remarkDrafts[s.id] ?? (existing ? existing.remark || '' : '')}
                            onChange={(e) => updateRemarkDraft(s.id, e.target.value)}
                            style={{ flex: 1, padding: '8px', border: `1px solid ${COLORS.rule}`, borderRadius: 4, boxSizing: 'border-box' }}
                          />
                          <button
                            onClick={() => generateRemarkFor(s.id)}
                            disabled={isGenerating || bulkGenerating}
                            title="Generate remark"
                            style={{ ...secondaryBtn, padding: '0 10px', flexShrink: 0 }}
                          >
                            {isGenerating ? '…' : '✨'}
                          </button>
                        </div>
                      </label>
                    </div>
                  </div>
                )
              })}
              {students.length === 0 && (
                <div style={{ textAlign: 'center', color: COLORS.muted, padding: 24, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
                  No students in this class yet.
                </div>
              )}
            </div>
          ) : (
            // ---- Table layout for desktop ----
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
              <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>Student</th><th style={th}>Adm. No.</th><th style={{ ...th, textAlign: 'center' }}>Score</th><th style={th}>Remark</th><th style={{ ...th, textAlign: 'center' }}>Status</th></tr></thead>
                <tbody>
                  {students.map((s) => {
                    const existing = marksByStudent[s.id]
                    const draft = drafts[s.id]
                    const hasValue = draft !== undefined ? draft !== '' : !!existing
                    const isGenerating = generatingIds.has(s.id)
                    return (
                      <tr key={s.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                        <td style={td}>{s.full_name}</td>
                        <td style={{ ...td, color: COLORS.muted }}>{s.admission_no}</td>
                        <td style={{ ...td, textAlign: 'center' }}>
                          <input
                            type="number" min={0} max={100}
                            defaultValue={existing ? existing.score : ''}
                            onChange={(e) => updateDraft(s.id, e.target.value)}
                            style={{ width: 64, padding: '6px 8px', textAlign: 'center', border: `1px solid ${COLORS.rule}`, borderRadius: 4 }}
                          />
                        </td>
                        <td style={td}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <input
                              type="text" placeholder="Optional remark…"
                              value={remarkDrafts[s.id] ?? (existing ? existing.remark || '' : '')}
                              onChange={(e) => updateRemarkDraft(s.id, e.target.value)}
                              style={{ width: '100%', minWidth: 140, padding: '6px 8px', border: `1px solid ${COLORS.rule}`, borderRadius: 4, boxSizing: 'border-box' }}
                            />
                            <button
                              onClick={() => generateRemarkFor(s.id)}
                              disabled={isGenerating || bulkGenerating}
                              title="Generate remark"
                              style={{ ...secondaryBtn, padding: '4px 10px', flexShrink: 0 }}
                            >
                              {isGenerating ? '…' : '✨'}
                            </button>
                          </div>
                        </td>
                        <td style={{ ...td, textAlign: 'center' }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: hasValue ? COLORS.good : COLORS.warn }}>
                            {hasValue ? '● Entered' : '○ Pending'}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                  {students.length === 0 && (
                    <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 24 }}>No students in this class yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
            <span style={{ fontSize: 12, color: COLORS.muted }}>{savedMsg || 'Unsaved changes are only committed once you save.'}</span>
            <button onClick={saveAll} disabled={saving} style={btn}>{saving ? 'Saving...' : 'Save All'}</button>
          </div>
        </>
      )}
      {showManage && (
        <AddAssignmentModal
          teacherId={teacherId}
          onClose={() => setShowManage(false)}
          onAdded={() => { setShowManage(false); loadAssignmentsAndExams() }}
        />
      )}
    </>
  )
}

// ============================================================================
// TEACHER: Full-page Marks Entry (own header + logout) — used when logged in
// as an approved teacher, not an admin
// ============================================================================
function MarksEntryScreen({ teacherId, teacherName, onLogout }) {
  const [showChangePw, setShowChangePw] = useState(false)
  const [view, setView] = useState('marks') // 'marks' | 'attendance' | 'timetable'
  return (
    <div style={{ background: COLORS.paper, minHeight: '100vh' }}>
      <div style={{ background: COLORS.band, color: COLORS.bandText, padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src="/crest.png" alt="Crest" style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0 }} />
          <div style={{ fontWeight: 700 }}>Paul Wanjigi Alpine — Records</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 12 }}>{teacherName}</span>
          <button onClick={() => setShowChangePw(true)} style={{ ...secondaryBtn, background: 'transparent', color: COLORS.bandText, borderColor: 'rgba(255,255,255,0.3)', fontSize: 12 }}>Change Password</button>
          <button onClick={onLogout} style={{ ...secondaryBtn, background: 'transparent', color: COLORS.bandText, borderColor: 'rgba(255,255,255,0.3)' }}>Log out</button>
        </div>
      </div>
      <div style={pageWrap}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <button onClick={() => setView('marks')} style={view === 'marks' ? btn : secondaryBtn}>Marks Entry</button>
          <button onClick={() => setView('attendance')} style={view === 'attendance' ? btn : secondaryBtn}>Attendance</button>
          <button onClick={() => setView('timetable')} style={view === 'timetable' ? btn : secondaryBtn}>My Timetable</button>
        </div>
        {view === 'marks' && <MarksEntryContent teacherId={teacherId} />}
        {view === 'attendance' && <TeacherAttendanceScreen teacherId={teacherId} />}
        {view === 'timetable' && <TeacherTimetableScreen teacherId={teacherId} />}
      </div>
      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
    </div>
  )
}

// ============================================================================
// ADMIN: "My Teaching" — lets an admin who also teaches a subject enter
// their own marks, using the exact same logic as regular teachers
// ============================================================================
function AdminTeachingScreen({ profile }) {
  return (
    <div style={pageWrap}>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 4 }}>
        If you also teach a subject, assign it here and enter marks the same way any teacher would.
      </p>
      <MarksEntryContent teacherId={profile.id} />
    </div>
  )
}

// ============================================================================
// ADMIN (Leadership only): "Enter Marks" — Principal / Deputy Principal /
// Dean of Studies / School Manager / Director can enter or correct marks for
// ANY subject and class directly, without needing a teacher_assignments row
// ============================================================================
function AdminMarksEntryScreen({ profile }) {
  return (
    <div style={pageWrap}>
      <MarksEntryContent teacherId={profile.id} adminMode />
    </div>
  )
}

// ============================================================================
// TEACHER: Add another subject/class assignment (post-onboarding)
// ============================================================================
function AddAssignmentModal({ teacherId, onClose, onAdded }) {
  const [allSubjects, setAllSubjects] = useState([])
  const [subjectId, setSubjectId] = useState('')
  const [classLabel, setClassLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.from('subjects').select('*').order('name').then(({ data }) => setAllSubjects(data || []))
  }, [])

  async function handleSave() {
    setSaving(true)
    setError('')
    const { error } = await supabase.from('teacher_assignments').insert({
      teacher_id: teacherId, subject_id: subjectId, class_label: classLabel,
    })
    if (error) { setError(error.message); setSaving(false); return }
    setSaving(false)
    onAdded()
  }

  return (
    <div style={modalOverlay}>
      <div style={{ ...modalCard, maxWidth: 'min(420px, 94vw)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3>Add Another Subject/Class</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <label style={fieldLabel}>Subject
          <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} style={input}>
            <option value="">Select…</option>
            {allSubjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label style={fieldLabel}>Class
          <select value={classLabel} onChange={(e) => setClassLabel(e.target.value)} style={input}>
            <option value="">Select…</option>
            {CLASS_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        {error && <p style={errorText}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
          <button onClick={handleSave} disabled={!subjectId || !classLabel || saving} style={btn}>
            {saving ? 'Saving...' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}

function TeacherHome({ profile, onLogout }) {
  const [hasAssignments, setHasAssignments] = useState(null) // null = loading

  useEffect(() => { checkAssignments() }, [])

  async function checkAssignments() {
    const { count } = await supabase
      .from('teacher_assignments')
      .select('*', { count: 'exact', head: true })
      .eq('teacher_id', profile.id)
    setHasAssignments((count ?? 0) > 0)
  }

  if (hasAssignments === null) {
    return <div style={wrap}><p>Loading...</p></div>
  }
  if (!hasAssignments) {
    return <TeacherOnboarding teacherId={profile.id} onDone={() => setHasAssignments(true)} />
  }
  return <MarksEntryScreen teacherId={profile.id} teacherName={profile.full_name} onLogout={onLogout} />
}

// ============================================================================
// GRADING LOGIC — pure calculation utilities extracted to src/utils/grading.js
// (GradeScaleContext/Provider stay here since they're React state, not calc logic)
// ============================================================================
const GradeScaleContext = createContext(null)

function useGradeScale() {
  const ctx = useContext(GradeScaleContext)
  return ctx || { scale: DEFAULT_KNEC_SCALE, loading: false, reload: () => {} }
}

function GradeScaleProvider({ children }) {
  const [scale, setScale] = useState(DEFAULT_KNEC_SCALE)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.from('grade_scale').select('*').order('min_score', { ascending: false })
    if (!error && data && data.length > 0) {
      setScale(data.map((r) => ({ label: r.label, min_score: r.min_score, points: r.points })))
    } else {
      setScale(DEFAULT_KNEC_SCALE)
    }
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  return (
    <GradeScaleContext.Provider value={{ scale, loading, reload }}>
      {children}
    </GradeScaleContext.Provider>
  )
}


// ============================================================================
// BATCH REPORT GENERATION + SMS/WHATSAPP SEND
// Replaces the single-student ReportsScreen with one that supports both
// single and batch modes, plus a WhatsApp send link per student.
// ============================================================================
function buildProgressGraphSvg(timeline) {
  if (!timeline || timeline.length === 0) return ''
  const width = 700, height = 140, padding = { top: 10, right: 16, bottom: 24, left: 30 }
  const chartW = width - padding.left - padding.right
  const chartH = height - padding.top - padding.bottom
  const n = timeline.length
  const xFor = (i) => padding.left + (n === 1 ? chartW / 2 : (i / (n - 1)) * chartW)
  const yFor = (v) => padding.top + chartH - (v / 100) * chartH

  const points = timeline.map((t, i) => `${xFor(i)},${yFor(t.value)}`).join(' ')
  const dots = timeline.map((t, i) => `
    <circle cx="${xFor(i)}" cy="${yFor(t.value)}" r="${i === 0 ? 4 : 3}" fill="${i === 0 ? '#9C6B2E' : '#2C3E37'}" stroke="#fff" stroke-width="1.2" />
  `).join('')
  const labels = timeline.map((t, i) => `
    <text x="${xFor(i)}" y="${height - 6}" font-size="9" fill="#6B6558" text-anchor="middle">${t.label}</text>
  `).join('')
  const gridLines = [0, 25, 50, 75, 100].map((v) => `
    <line x1="${padding.left}" y1="${yFor(v)}" x2="${width - padding.right}" y2="${yFor(v)}" stroke="#E4DFD1" stroke-width="1" />
    <text x="${padding.left - 6}" y="${yFor(v) + 3}" font-size="8" fill="#6B6558" text-anchor="end">${v}</text>
  `).join('')

  return `
    <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="background:#fff;">
      ${gridLines}
      <line x1="${xFor(0)}" y1="${padding.top}" x2="${xFor(0)}" y2="${height - padding.bottom}" stroke="#9C6B2E" stroke-dasharray="3,3" />
      <polyline points="${points}" fill="none" stroke="#2C3E37" stroke-width="2" />
      ${dots}
      ${labels}
    </svg>
  `
}

function buildReportHtml(report) {
  const rowsHtml = report.subjectRows.map((r) => `
    <tr style="border-top:1px solid #E4DFD1;">
      <td style="padding:7px 10px;">${r.name}${r.is_compulsory ? ' *' : ''}</td>
      <td style="padding:7px 10px;">${r.prevGrade || '—'}</td>
      <td style="padding:7px 10px;"><strong>${r.grade || '—'}</strong></td>
      <td style="padding:7px 10px;color:#6B6558;">${r.remark || ''}</td>
    </tr>`).join('')

  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })

  const gradeOrLevelWord = report.isCbc ? 'Level' : 'Grade'

  return `
    <div style="max-width:760px;margin:0 auto;font-family:sans-serif;color:#1E2A24;">
      <!-- Letterhead -->
      <div style="border-bottom:3px solid #2C3E37;padding-bottom:12px;margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:16px;">
          <img src="/crest.png" style="width:64px;height:64px;border-radius:50%;object-fit:cover;flex-shrink:0;" />
          <div style="flex:1;">
            <div style="font-size:24px;font-weight:800;color:#2C3E37;line-height:1.15;">Paul Wanjigi Alpine High School</div>
            <div style="font-size:11.5px;color:#6B6558;margin-top:2px;">P.O. BOX 1801-20117 NAIVASHA &nbsp;·&nbsp; www.pwahigh.com</div>
            <div style="font-size:11.5px;color:#9C6B2E;font-weight:700;margin-top:2px;">Mission: To graduate leaders with integrity</div>
          </div>
        </div>
      </div>

      <!-- Title bar -->
      <div style="display:flex;justify-content:space-between;align-items:center;background:#2C3E37;color:#F4F1E8;padding:8px 16px;margin-bottom:18px;font-size:12.5px;">
        <div><strong>${report.exam.name}</strong> &nbsp;·&nbsp; ${report.exam.term} ${report.exam.year}</div>
        <div>Issue Date: ${new Date().toLocaleDateString('en-GB')}</div>
      </div>

      <!-- Student info -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;background:#F7F5EF;border:1px solid #E4DFD1;padding:12px 16px;margin-bottom:18px;font-size:13px;">
        <div><span style="color:#6B6558;font-size:11px;">Student</span><br/><strong>${report.student.full_name}</strong></div>
        <div><span style="color:#6B6558;font-size:11px;">Adm. No.</span><br/><strong>${report.student.admission_no}</strong></div>
        <div><span style="color:#6B6558;font-size:11px;">${report.student.cohort === 'grade_10' ? 'Grade' : 'Form'}</span><br/><strong>${report.student.cohort}</strong></div>
      </div>

      <!-- Subject table -->
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:4px;">
        <thead>
          <tr style="background:#2C3E37;color:#F4F1E8;">
            <th style="text-align:left;padding:8px 10px;">Subject</th>
            <th style="text-align:left;padding:8px 10px;">Previous</th>
            <th style="text-align:left;padding:8px 10px;">This Exam</th>
            <th style="text-align:left;padding:8px 10px;">Remarks</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>

      <!-- Summary: This Term vs Last Term -->
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:18px;">
        <thead>
          <tr style="background:#2C3E37;color:#F4F1E8;">
            <th style="text-align:left;padding:7px 10px;"></th>
            <th style="text-align:left;padding:7px 10px;">Total Points</th>
            <th style="text-align:left;padding:7px 10px;">Position</th>
          </tr>
        </thead>
        <tbody>
          <tr style="background:#E9DDC6;">
            <td style="padding:7px 10px;font-weight:700;">This Term</td>
            <td style="padding:7px 10px;font-weight:700;">${report.aggregate.total} / ${report.aggregate.maxTotal}</td>
            <td style="padding:7px 10px;font-weight:700;">${report.position ?? '—'} of ${report.outOf ?? '—'}</td>
          </tr>
          <tr style="border-top:1px solid #E4DFD1;">
            <td style="padding:7px 10px;color:#6B6558;">Last Term</td>
            <td style="padding:7px 10px;color:#6B6558;">${report.prevAggregate ? `${report.prevAggregate.total} / ${report.prevAggregate.maxTotal}` : '—'}</td>
            <td style="padding:7px 10px;color:#6B6558;">${report.prevPosition ? `${report.prevPosition} of ${report.prevOutOf}` : '—'}</td>
          </tr>
        </tbody>
      </table>

      ${report.timeline && report.timeline.length > 0 ? `
      <!-- Progress graph -->
      <div style="margin-bottom:18px;">
        <div style="font-size:10.5px;letter-spacing:1px;color:#6B6558;text-transform:uppercase;margin-bottom:4px;">Progress</div>
        <div style="border:1px solid #E4DFD1;padding:6px 4px 0;">
          ${buildProgressGraphSvg(report.timeline)}
        </div>
      </div>
      ` : ''}

      <!-- Comments -->
      <div style="font-size:13px;margin-bottom:18px;line-height:1.6;">
        <div><strong>Principal's Comments:</strong> ${report.principalComment || '—'}</div>
        <div><strong>Class Teacher's Comments:</strong> ${report.classTeacherComment || '—'}</div>
        <div style="color:#6B6558;margin-top:6px;">Date: ${today}</div>
      </div>

      <!-- Signatures -->
      <div style="display:flex;justify-content:space-between;margin-top:30px;font-size:12px;">
        <div style="width:45%;text-align:center;">
          <div style="border-top:1px solid #1E2A24;padding-top:4px;">School Manager</div>
        </div>
        <div style="width:45%;text-align:center;">
          <div style="border-top:1px solid #1E2A24;padding-top:4px;">School Principal</div>
        </div>
      </div>

      <!-- Parent / Guardian sign-off -->
      <div style="margin-top:26px;border-top:1px solid #E4DFD1;padding-top:14px;font-size:12px;">
        <div style="margin-bottom:10px;">Report seen by Parent / Guardian / Sponsor:</div>
        <div style="display:flex;justify-content:space-between;">
          <div style="width:45%;">Date: <span style="display:inline-block;border-bottom:1px solid #1E2A24;width:70%;">&nbsp;</span></div>
          <div style="width:45%;">Signature: <span style="display:inline-block;border-bottom:1px solid #1E2A24;width:60%;">&nbsp;</span></div>
        </div>
      </div>

      <!-- Term resumes -->
      <div style="margin-top:16px;font-size:12.5px;font-weight:700;color:#2C3E37;">
        The Term Resumes on: ${report.exam.term_resumes_on ? new Date(report.exam.term_resumes_on).toLocaleDateString('en-GB') : '— (not yet set by admin)'}
      </div>
    </div>
  `
}

async function reportToPdfBlob(report) {
  const container = document.createElement('div')
  container.style.position = 'fixed'
  container.style.left = '-9999px'
  container.style.top = '0'
  container.style.width = '800px'
  container.style.background = '#fff'
  container.style.padding = '24px'
  container.style.fontFamily = 'sans-serif'
  container.innerHTML = buildReportHtml(report)

  document.body.appendChild(container)
  const canvas = await html2canvas(container, { scale: 2, backgroundColor: '#ffffff', windowWidth: 800, width: 800 })
  document.body.removeChild(container)

  const imgData = canvas.toDataURL('image/png')
  const pdf = new jsPDF('p', 'mm', 'a4')
  const pageWidth = pdf.internal.pageSize.getWidth()
  const imgWidth = pageWidth - 20
  const imgHeight = (canvas.height * imgWidth) / canvas.width
  pdf.addImage(imgData, 'PNG', 10, 10, imgWidth, imgHeight)
  return pdf.output('blob')
}

async function downloadReportAsPdf(report) {
  const blob = await reportToPdfBlob(report)
  const fileName = `${report.student.admission_no}_${report.student.full_name.replace(/\s+/g, '_')}_${report.exam.name.replace(/\s+/g, '_')}.pdf`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

async function downloadAllAsZip(results, onProgress) {
  const zip = new JSZip()
  let done = 0
  for (const r of results) {
    const blob = await reportToPdfBlob(r.report)
    const fileName = `${r.student.admission_no}_${r.student.full_name.replace(/\s+/g, '_')}.pdf`
    zip.file(fileName, blob)
    done++
    onProgress?.(done, results.length)
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(zipBlob)
  const a = document.createElement('a')
  a.href = url
  a.download = `report_cards_${new Date().toISOString().slice(0, 10)}.zip`
  a.click()
  URL.revokeObjectURL(url)
}

function printAllReports(results) {
  const container = document.createElement('div')
  container.id = 'print-all-container'
  container.innerHTML = results
    .map((r) => `<div style="page-break-after: always; padding: 0; font-family: sans-serif; zoom: 0.8;">${buildReportHtml(r.report)}</div>`)
    .join('')

  const style = document.createElement('style')
  style.id = 'print-all-style'
  style.innerHTML = `
    @media print {
      body > *:not(#print-all-container) { display: none !important; }
      #print-all-container { display: block !important; }
    }
    @media screen { #print-all-container { display: none; } }
  `
  document.head.appendChild(style)
  document.body.appendChild(container)

  window.print()

  const cleanup = () => {
    document.body.removeChild(container)
    document.head.removeChild(style)
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
}
function printSingleReport(report) {
  const container = document.createElement('div')
  container.id = 'print-single-container'
  container.innerHTML = buildReportHtml(report)
  const style = document.createElement('style')
  style.id = 'print-single-style'
  style.innerHTML = `
    @page { size: A4; margin: 8mm; }
    @media print {
      body > *:not(#print-single-container) { display: none !important; }
      #print-single-container { display: block !important; padding: 0 !important; }
      #print-single-container > div { zoom: 0.8; }
    }
    @media screen { #print-single-container { display: none; } }
  `
  document.head.appendChild(style)
  document.body.appendChild(container)
  window.print()
  const cleanup = () => {
    document.body.removeChild(container)
    document.head.removeChild(style)
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
}

function buildWhatsAppLink(phone, message) {
  // Strip anything that isn't a digit, then assume Kenyan numbers need
  // the country code if they start with 0 (e.g. 0712345678 -> 254712345678)
  let cleaned = (phone || '').replace(/\D/g, '')
  if (cleaned.startsWith('0')) cleaned = '254' + cleaned.slice(1)
  return `https://wa.me/${cleaned}?text=${encodeURIComponent(message)}`
}

function buildSmsMessage(report) {
  const lines = [
    `${report.student.full_name} (${report.student.admission_no}) - ${report.exam.name}`,
    ...report.subjectRows.map((r) => `${r.name}: ${r.grade || '—'}`),
    `Total: ${report.aggregate.total}/${report.aggregate.maxTotal} | Position: ${report.position}/${report.outOf}`,
  ]
  return lines.join('\n')
}

  function ReportsScreen() {
  const { notify } = useNotify()
  const { scale: gradeScale } = useGradeScale()
  const { scale: cbcScale } = useCbcScale()
  const [mode, setMode] = useState('single') // single | batch
  const [batchCohortFilter, setBatchCohortFilter] = useState('form_4')
  const [exams, setExams] = useState([])
  const [students, setStudents] = useState([])
  const [selectedExamId, setSelectedExamId] = useState('')
  const [selectedStudentId, setSelectedStudentId] = useState('')
  const [selectedBatchIds, setSelectedBatchIds] = useState(new Set())
  const [principalComment, setPrincipalComment] = useState('')
  const [classTeacherComment, setClassTeacherComment] = useState('')
  const [report, setReport] = useState(null)
  const [batchResults, setBatchResults] = useState([])
  const [zipProgress, setZipProgress] = useState(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const [generatingPrincipal, setGeneratingPrincipal] = useState(false)
  const [generatingTeacher, setGeneratingTeacher] = useState(false)
  const [batchGenerateComments, setBatchGenerateComments] = useState(false)
  useEffect(() => {
    supabase.from('exams').select('*').order('order_index', { ascending: false }).then(({ data }) => {
      setExams(data || [])
      if (data && data.length > 0) setSelectedExamId(data[0].id)
    })
    supabase.from('students').select('*').order('full_name').then(({ data }) => setStudents(data || []))
  }, [])
  // Core computation for a single student — reused by both single & batch modes
async function computeReportFor(student, examId, cache = {}) {
    const isCbc = student.cohort === 'grade_10'
    const exam = exams.find((e) => e.id === examId)
    const prevExam = exams.filter((e) => e.order_index < exam.order_index).sort((a, b) => b.order_index - a.order_index)[0]
    const { data: studentSubjects } = await supabase.from('student_subjects').select('*, subjects(id, name)').eq('student_id', student.id)
    const subjectIds = (studentSubjects || []).map((ss) => ss.subject_id)
    const { data: nowMarks } = await supabase.from('marks').select('*').eq('student_id', student.id).eq('exam_id', examId).in('subject_id', subjectIds)
    const { data: prevMarks } = prevExam
      ? await supabase.from('marks').select('*').eq('student_id', student.id).eq('exam_id', prevExam.id).in('subject_id', subjectIds)
      : { data: [] }
    const subjectRows = (studentSubjects || []).map((ss) => {
      const now = (nowMarks || []).find((m) => m.subject_id === ss.subject_id)
      const prev = (prevMarks || []).find((m) => m.subject_id === ss.subject_id)
      return {
        name: ss.subjects.name,
        is_compulsory: ss.is_compulsory,
        score: now ? now.score : null,
        prevScore: prev ? prev.score : null,
        grade: now ? (isCbc ? cbcLevel(now.score, cbcScale) : kcseGrade(now.score, gradeScale)) : null,
        prevGrade: prev ? (isCbc ? cbcLevel(prev.score, cbcScale) : kcseGrade(prev.score, gradeScale)) : null,
        remark: now ? now.remark : null,
      }
    })
    const aggregate = isCbc
      ? computeCbcTotal(subjectRows.map((r) => ({ score: r.score })), cbcScale)
      : computeKcseAggregate(subjectRows.map((r) => ({ score: r.score, is_compulsory: r.is_compulsory })), gradeScale)
    // Cache cohort rankings per exam so a batch run doesn't refetch the
    // same cohort-wide ranking data for every single student.
    const rankKey = `${student.cohort}:${examId}`
    if (!cache[rankKey]) {
      const { data } = await supabase.rpc('compute_cohort_rankings', { p_cohort: student.cohort, p_exam_id: examId })
      cache[rankKey] = data || []
    }
    const sorted = cache[rankKey].slice().sort((a, b) => a.rnk - b.rnk)
    const myRanking = sorted.find((r) => r.student_id === student.id)
    const position = myRanking ? Number(myRanking.rnk) : null
    const outOf = sorted.length
    let prevAggregate = null, prevPosition = null, prevOutOf = null
    if (prevExam) {
      prevAggregate = isCbc
        ? computeCbcTotal(subjectRows.map((r) => ({ score: r.prevScore })), cbcScale)
        : computeKcseAggregate(subjectRows.map((r) => ({ score: r.prevScore, is_compulsory: r.is_compulsory })), gradeScale)
      const prevRankKey = `${student.cohort}:${prevExam.id}`
      if (!cache[prevRankKey]) {
        const { data } = await supabase.rpc('compute_cohort_rankings', { p_cohort: student.cohort, p_exam_id: prevExam.id })
        cache[prevRankKey] = data || []
      }
      const prevSorted = cache[prevRankKey].slice().sort((a, b) => a.rnk - b.rnk)
      const prevRanking = prevSorted.find((r) => r.student_id === student.id)
      prevPosition = prevRanking ? Number(prevRanking.rnk) : null
      prevOutOf = prevSorted.length
    }
    const timeline = []
    if (student.entrance_type && student.entrance_score != null) {
      timeline.push({
        label: student.entrance_type,
        value: Math.round((student.entrance_score / student.entrance_max) * 100),
      })
    }
    const { data: historical } = await supabase
      .from('historical_performance').select('*').eq('student_id', student.id).order('order_index')
    ;(historical || []).forEach((h) => {
      timeline.push({ label: h.label, value: Math.round((h.points / h.max_points) * 100) })
    })
    // Cache the full exams list too — identical for every student in a batch.
    if (!cache.allExams) {
      const { data } = await supabase.from('exams').select('*').order('order_index')
      cache.allExams = data || []
    }
    const allExams = cache.allExams
    // Single batched query covering every exam's marks at once,
    // instead of looping and firing one query per exam.
    const { data: allExamMarks } = await supabase
      .from('marks').select('score, exam_id').eq('student_id', student.id).in('subject_id', subjectIds)
      .in('exam_id', allExams.map((e) => e.id))
    for (const ex of allExams) {
      const examMarks = (allExamMarks || []).filter((m) => m.exam_id === ex.id)
      if (examMarks.length > 0) {
        const meanScore = examMarks.reduce((sum, m) => sum + m.score, 0) / examMarks.length
        timeline.push({ label: ex.name, value: Math.round(meanScore) })
      }
    }
    return { student, exam, prevExam, subjectRows, aggregate, position, outOf, isCbc, timeline, prevAggregate, prevPosition, prevOutOf }
  }
  async function generatePreview() {
    if (!selectedExamId || !selectedStudentId) return
    setLoading(true)
    setReport(null)
    setPrincipalComment('')
    setClassTeacherComment('')
    const student = students.find((s) => s.id === selectedStudentId)
    const r = await computeReportFor(student, selectedExamId)
    setReport(r)
    setLoading(false)
  }
  async function handleGeneratePrincipalComment() {
    if (!report) return
    setGeneratingPrincipal(true)
    try {
      const comment = await generateReportComment(report.student, report.subjectRows, report.aggregate, report.position, report.outOf, 'principal')
      setPrincipalComment(comment)
    } catch (err) {
      notify(`Couldn't generate Principal's comment: ${err.message}`, 'error')
    } finally {
      setGeneratingPrincipal(false)
    }
  }
  async function handleGenerateTeacherComment() {
    if (!report) return
    setGeneratingTeacher(true)
    try {
      const comment = await generateReportComment(report.student, report.subjectRows, report.aggregate, report.position, report.outOf, 'teacher')
      setClassTeacherComment(comment)
    } catch (err) {
      notify(`Couldn't generate Class Teacher's comment: ${err.message}`, 'error')
    } finally {
      setGeneratingTeacher(false)
    }
  }
  async function saveReport(r, pComment, cComment) {
    const { data: { user } } = await supabase.auth.getUser()
    return supabase.from('report_cards').upsert({
      student_id: r.student.id,
      exam_id: r.exam.id,
      generated_by: user.id,
      report_date: new Date().toISOString().slice(0, 10),
      snapshot: { ...r, principalComment: pComment, classTeacherComment: cComment },
      principal_comment: pComment,
      class_teacher_comment: cComment,
    }, { onConflict: 'student_id,exam_id' })
  }
  async function handleSaveSingle() {
    if (!report) return
    setSaving(true)
    const { error } = await saveReport(report, principalComment, classTeacherComment)
    if (!error) setSavedMsg(`Report saved at ${new Date().toLocaleTimeString()}`)
    setSaving(false)
  }
  async function handleDownloadPdf() {
    const blob = await reportToPdfBlob({ ...report, principalComment, classTeacherComment })
    const fileName = `${report.student.admission_no}_${report.student.full_name.replace(/\s+/g, '_')}_${report.exam.name.replace(/\s+/g, '_')}.pdf`
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
  }
  function toggleBatch(id) {
    setSelectedBatchIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  async function handleBatchGenerate() {
    if (selectedBatchIds.size === 0 || !selectedExamId) return
    setLoading(true)
    setBatchResults([])
    const cache = {}
    const ids = Array.from(selectedBatchIds)
    // Lower concurrency when AI comments are on — each student then makes
    // 2 extra Groq calls (principal + teacher), so keep bursts gentler.
    const CONCURRENCY = batchGenerateComments ? 2 : 5
    const results = []
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = ids.slice(i, i + CONCURRENCY)
      const batchResultsChunk = await Promise.all(batch.map(async (id) => {
        const student = students.find((s) => s.id === id)
        const r = await computeReportFor(student, selectedExamId, cache)
        let pComment = ''
        let cComment = ''
        let commentError = null
        if (batchGenerateComments) {
          try {
            pComment = await generateReportComment(r.student, r.subjectRows, r.aggregate, r.position, r.outOf, 'principal')
          } catch (err) {
            commentError = err.message
          }
          try {
            cComment = await generateReportComment(r.student, r.subjectRows, r.aggregate, r.position, r.outOf, 'teacher')
          } catch (err) {
            commentError = commentError || err.message
          }
        }
        const { error } = await saveReport(r, pComment, cComment)
        return { student, ok: !error, report: r, principalComment: pComment, classTeacherComment: cComment, commentError }
      }))
      results.push(...batchResultsChunk)
      setBatchResults([...results])
    }
    setLoading(false)
  }
  return (
    <div style={pageWrap}>
      <h2>Generate Reports</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 16 }}>
        Generate one student's report on demand, or batch-generate a whole class — each still produces its own separate report.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        <button onClick={() => { setMode('single'); setBatchResults([]) }} style={mode === 'single' ? btn : secondaryBtn}>Single student</button>
        <button onClick={() => { setMode('batch'); setReport(null) }} style={mode === 'batch' ? btn : secondaryBtn}>Batch — multiple students</button>
      </div>
      <label style={{ ...fieldLabel, marginBottom: 16, maxWidth: 300 }}>Exam
        <select value={selectedExamId} onChange={(e) => { setSelectedExamId(e.target.value); setReport(null); setBatchResults([]) }} style={input}>
          {exams.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.term} {e.year}</option>)}
        </select>
      </label>
      {mode === 'single' && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
            <label style={fieldLabel}>Student
              <select value={selectedStudentId} onChange={(e) => { setSelectedStudentId(e.target.value); setReport(null) }} style={{ ...input, minWidth: 220 }}>
                <option value="">Select…</option>
                {students.map((s) => <option key={s.id} value={s.id}>{s.full_name} ({s.admission_no})</option>)}
              </select>
            </label>
            <button onClick={generatePreview} disabled={!selectedStudentId || loading} style={{ ...btn, alignSelf: 'flex-end' }}>
              {loading ? 'Computing...' : 'Generate Preview'}
            </button>
          </div>
          {report && (
            <>
              <div style={{ marginBottom: 16 }}>
                <label style={fieldLabel}>Principal's Comments
                  <div style={{ display: 'flex', gap: 6 }}>
                    <textarea value={principalComment} onChange={(e) => setPrincipalComment(e.target.value)} rows={2} style={{ ...input, minWidth: '100%', flex: 1 }} />
                    <button
                      onClick={handleGeneratePrincipalComment}
                      disabled={generatingPrincipal}
                      title="Generate remark"
                      style={{ ...secondaryBtn, padding: '4px 10px', height: 'fit-content', flexShrink: 0 }}
                    >
                      {generatingPrincipal ? '…' : '✨'}
                    </button>
                  </div>
                </label>
                <label style={fieldLabel}>Class Teacher's Comments
                  <div style={{ display: 'flex', gap: 6 }}>
                    <textarea value={classTeacherComment} onChange={(e) => setClassTeacherComment(e.target.value)} rows={2} style={{ ...input, minWidth: '100%', flex: 1 }} />
                    <button
                      onClick={handleGenerateTeacherComment}
                      disabled={generatingTeacher}
                      title="Generate remark"
                      style={{ ...secondaryBtn, padding: '4px 10px', height: 'fit-content', flexShrink: 0 }}
                    >
                      {generatingTeacher ? '…' : '✨'}
                    </button>
                  </div>
                </label>
              </div>
              <div
                id="report-preview"
                style={{ background: '#fff', border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 'clamp(12px, 4vw, 24px)', marginBottom: 12, overflowX: 'auto' }}
                dangerouslySetInnerHTML={{ __html: buildReportHtml({ ...report, principalComment, classTeacherComment }) }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <span style={{ fontSize: 12, color: COLORS.muted }}>{savedMsg}</span>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <a
                    href={buildWhatsAppLink(report.student.parent_phone, buildSmsMessage(report))}
                    target="_blank" rel="noreferrer"
                    style={{ ...secondaryBtn, textDecoration: 'none', display: 'inline-block' }}
                  >
                    💬 WhatsApp Parent
                  </a>
                  <button onClick={handleDownloadPdf} style={secondaryBtn}>⬇ Download PDF</button>
                  <button onClick={() => printSingleReport({ ...report, principalComment, classTeacherComment })} style={secondaryBtn}>🖨 Print</button>
                  <button onClick={handleSaveSingle} disabled={saving} style={btn}>{saving ? 'Saving...' : 'Save Report'}</button>
                </div>
              </div>
            </>
          )}
        </>
      )}
      {mode === 'batch' && (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={fieldLabel}>Class
              <select value={batchCohortFilter} onChange={(e) => setBatchCohortFilter(e.target.value)} style={{ ...input, minWidth: 180 }}>
                <option value="form_3">Form 3</option>
                <option value="form_4">Form 4</option>
                <option value="grade_10">Grade 10</option>
              </select>
            </label>
            <button
              onClick={() => {
                const idsInClass = students.filter((s) => s.cohort === batchCohortFilter).map((s) => s.id)
                setSelectedBatchIds(new Set(idsInClass))
              }}
              style={secondaryBtn}
            >
              ✓ Select all in this class
            </button>
            <button onClick={() => setSelectedBatchIds(new Set())} style={secondaryBtn}>Clear selection</button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: COLORS.muted, marginBottom: 14, cursor: 'pointer' }}>
            <input type="checkbox" checked={batchGenerateComments} onChange={(e) => setBatchGenerateComments(e.target.checked)} />
            Also generate Principal & Class Teacher comments for each student — optional, takes longer for large classes
          </label>
          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto', marginBottom: 16 }}>
            <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}></th><th style={th}>Name</th><th style={th}>Adm. No.</th><th style={th}>Cohort</th></tr></thead>
              <tbody>
                {students
                  .filter((s) => s.cohort === batchCohortFilter)
                  .sort((a, b) => a.full_name.localeCompare(b.full_name))
                  .map((s) => (
                    <tr key={s.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                      <td style={{ ...td, width: 34 }}>
                        <input type="checkbox" checked={selectedBatchIds.has(s.id)} onChange={() => toggleBatch(s.id)} />
                      </td>
                      <td style={td}>{s.full_name}</td>
                      <td style={{ ...td, color: COLORS.muted }}>{s.admission_no}</td>
                      <td style={td}>{s.cohort}</td>
                    </tr>
                  ))}
                {students.filter((s) => s.cohort === batchCohortFilter).length === 0 && (
                  <tr><td colSpan={4} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 24 }}>No students in this class yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: COLORS.muted }}>{selectedBatchIds.size} selected</span>
            <button onClick={handleBatchGenerate} disabled={selectedBatchIds.size === 0 || loading} style={btn}>
              {loading ? 'Generating...' : `Generate ${selectedBatchIds.size || ''} Reports`}
            </button>
          </div>
          {batchResults.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: COLORS.muted }}>
                  {zipProgress ? `Zipping ${zipProgress.done}/${zipProgress.total}...` : `${batchResults.length} reports generated`}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => printAllReports(batchResults)} style={secondaryBtn}>🖨 Print All</button>
                  <button
                    onClick={() => downloadAllAsZip(batchResults, (done, total) => setZipProgress({ done, total })).then(() => setZipProgress(null))}
                    disabled={!!zipProgress}
                    style={btn}
                  >
                    {zipProgress ? 'Zipping...' : '⬇ Download All (ZIP)'}
                  </button>
                </div>
              </div>
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
              <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>Student</th><th style={th}>Total</th><th style={th}>Position</th><th style={th}>Status</th><th style={th}></th></tr></thead>
                <tbody>
                  {batchResults.map((r) => (
                    <tr key={r.student.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                      <td style={td}>{r.student.full_name}</td>
                      <td style={td}>{r.report.aggregate.total}/{r.report.aggregate.maxTotal}</td>
                      <td style={td}>{r.report.position}/{r.report.outOf}</td>
                      <td style={{ ...td, color: r.ok ? COLORS.good : COLORS.warn }}>
                        {r.ok ? '✓ Saved' : '✕ Failed'}
                        {r.commentError && <div style={{ fontSize: 10.5, color: COLORS.warn }}>Comment generation failed</div>}
                      </td>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 10 }}>
                          <button onClick={() => downloadReportAsPdf({ ...r.report, principalComment: r.principalComment, classTeacherComment: r.classTeacherComment })} style={{ fontSize: 12, color: COLORS.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                            ⬇ PDF
                          </button>
                          <a href={buildWhatsAppLink(r.student.parent_phone, buildSmsMessage(r.report))} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: COLORS.accent }}>
                            WhatsApp →
                          </a>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
// ============================================================================
// ADMIN: Teachers overview — add to nav alongside Dashboard/Students/etc.
// ============================================================================
// ============================================================================
// ADMIN: Title-based promotion modal — pick Principal / Deputy Principal /
// Dean of Studies, with slot limits enforced against currently approved admins
// ============================================================================
function ChangeRoleModal({ teacher, teachers, onClose, onChanged }) {
  const { notify, confirmAction } = useNotify()
  const [selectedRole, setSelectedRole] = useState(teacher.role === 'admin' ? teacher.title : 'teacher')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const wasAdmin = teacher.role === 'admin'

  // Count title slots excluding this person's own current row, so re-saving
  // them into the title they already hold (or moving a full slot to someone
  // else) doesn't false-positive against the limit.
  const titleCounts = {}
  teachers.forEach((t) => {
    if (t.id === teacher.id) return
    if (t.role === 'admin' && t.title) titleCounts[t.title] = (titleCounts[t.title] || 0) + 1
  })
  function isTitleFull(title) {
    return (titleCounts[title] || 0) >= TITLE_LIMITS[title]
  }

  async function handleConfirm() {
    if (!selectedRole) { setError('Select a role first.'); return }
    if (selectedRole !== 'teacher' && isTitleFull(selectedRole)) {
      setError(`${selectedRole} already has the maximum of ${TITLE_LIMITS[selectedRole]}.`)
      return
    }
    // Demoting someone out of admin is the sensitive direction — confirm it.
    if (wasAdmin && selectedRole === 'teacher') {
      const confirmed = await confirmAction(
        `Remove ${teacher.full_name}'s admin access and make them a regular teacher? They'll lose access to Students, Reports, Approvals, and Settings.`,
        { danger: true, confirmLabel: 'Demote' }
      )
      if (!confirmed) return
    }
    setSaving(true)
    setError('')
    const updates = selectedRole === 'teacher'
      ? { role: 'teacher', title: null }
      : { role: 'admin', title: selectedRole }
    const { error: updateError } = await supabase.from('profiles').update(updates).eq('id', teacher.id)
    if (updateError) { setError(updateError.message); setSaving(false); return }
    setSaving(false)
    notify(selectedRole === 'teacher' ? `${teacher.full_name} is now a Teacher.` : `${teacher.full_name} is now ${selectedRole}.`)
    onChanged()
    onClose()
  }

  return (
    <div style={modalOverlay}>
      <div style={{ ...modalCard, maxWidth: 'min(420px, 94vw)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3>{wasAdmin ? `Change Role — ${teacher.full_name}` : `Promote ${teacher.full_name}`}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 14 }}>
          {wasAdmin
            ? 'Choose a new title, or move them back to Teacher.'
            : 'Choose the administrative title. This grants full admin access — students, marks, reports, approvals.'}
        </p>
        <label style={fieldLabel}>Role
          <select value={selectedRole || ''} onChange={(e) => { setSelectedRole(e.target.value); setError('') }} style={input}>
            <option value="">Select…</option>
            {wasAdmin && <option value="teacher">Teacher (remove admin access)</option>}
            {Object.keys(TITLE_LIMITS).map((title) => (
              <option key={title} value={title} disabled={isTitleFull(title)}>
                {title}{isTitleFull(title) ? ` (full — ${titleCounts[title] || 0}/${TITLE_LIMITS[title]})` : ` (${titleCounts[title] || 0}/${TITLE_LIMITS[title]})`}
              </option>
            ))}
          </select>
        </label>
        {error && <p style={errorText}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
          <button onClick={handleConfirm} disabled={saving || !selectedRole} style={btn}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}

function TeachersScreen({ currentUserId }) {
  const { notify, confirmAction } = useNotify()
  const [teachers, setTeachers] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [changingRoleFor, setChangingRoleFor] = useState(null)
  const [assigningTeacher, setAssigningTeacher] = useState(null)

  useEffect(() => { loadTeachers() }, [])

async function loadTeachers() {
    setLoading(true)
    const { data: allApproved } = await supabase
      .from('profiles')
      .select('*')
      .in('role', ['teacher', 'admin'])
      .eq('status', 'approved')
      .order('full_name')

    // Teachers always show; admins only show if they hold a real leadership
    // title (Dean/Principal/Deputy/School Manager/Director). Untitled/system
    // admin accounts (e.g. a personal monitoring login) stay hidden here.
    const teacherProfiles = (allApproved || []).filter(
      (p) => p.role === 'teacher' || (p.role === 'admin' && p.title)
    )

    const teacherIds = (teacherProfiles || []).map((t) => t.id)

    // One query for every teacher's assignments, instead of one query per teacher.
    const { data: allAssignments } = teacherIds.length > 0
      ? await supabase
          .from('teacher_assignments')
          .select('*, subjects(name)')
          .in('teacher_id', teacherIds)
      : { data: [] }

    const withAssignments = (teacherProfiles || []).map((t) => ({
      ...t,
      assignments: (allAssignments || []).filter((a) => a.teacher_id === t.id),
    }))

    setTeachers(withAssignments)
    setLoading(false)
  }

  async function removeAssignment(assignmentId) {
    await supabase.from('teacher_assignments').delete().eq('id', assignmentId)
    notify('Assignment removed.')
    loadTeachers()
  }

  async function removeTeacher(teacherId, name) {
    const confirmed = await confirmAction(`Permanently delete ${name}? This removes their account and assignments. This cannot be undone.`, { danger: true, confirmLabel: 'Delete' })
    if (!confirmed) return

    const { error: assignError } = await supabase.from('teacher_assignments').delete().eq('teacher_id', teacherId)
    if (assignError) { notify(`Couldn't delete: ${assignError.message}`, 'error'); return }

    const { error: profileError } = await supabase.from('profiles').delete().eq('id', teacherId)
    if (profileError) { notify(`Couldn't delete: ${profileError.message}`, 'error'); return }

    notify(`${name} deleted.`)
    loadTeachers()
  }

  async function setClassTeacher(teacherId, cohort) {
    // Clear anyone else currently appointed to this cohort first —
    // only one class teacher per cohort at a time (admins are eligible too)
    if (cohort) {
      await supabase.from('profiles').update({ class_teacher_of: null }).eq('class_teacher_of', cohort)
    }
    await supabase.from('profiles').update({ class_teacher_of: cohort || null }).eq('id', teacherId)
    notify(cohort ? 'Class Teacher assigned.' : 'Class Teacher unassigned.')
    loadTeachers()
  }

  const filteredTeachers = teachers.filter((t) => {
    if (!searchQuery.trim()) return true
    const q = searchQuery.trim().toLowerCase()
    return t.full_name?.toLowerCase().includes(q) || t.username?.toLowerCase().includes(q)
  })

  return (
    <div style={pageWrap}>
      <h2>Profiles</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 20 }}>
        Every teacher (and any admin who also teaches) self-assigns their subjects/classes, or an admin can add one for them below. Remove an assignment here if it was set up wrong.
      </p>

      <label style={{ ...fieldLabel, marginBottom: 18, maxWidth: 320 }}>Search
        <input
          placeholder="Search by name or username..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={input}
        />
      </label>

      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : filteredTeachers.length === 0 ? (
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 24, textAlign: 'center', color: COLORS.muted, fontSize: 13 }}>
          {teachers.length === 0 ? 'No approved staff yet.' : 'No staff match your search.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filteredTeachers.map((t) => (
            <div key={t.id} style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10, flexWrap: 'wrap', gap: 6 }}>
                <div>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{t.full_name}</span>
                  <span style={{ fontSize: 12, color: COLORS.muted, marginLeft: 8 }}>@{t.username}</span>
                  {t.role === 'admin' ? (
                    <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.accent, background: COLORS.accentSoft, padding: '2px 8px', borderRadius: 10, marginLeft: 8 }}>
                      {t.title || 'Admin'}
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.good, background: COLORS.goodSoft, padding: '2px 8px', borderRadius: 10, marginLeft: 8 }}>
                      Subject Teacher
                    </span>
                  )}
                  {t.class_teacher_of && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#7A6A2E', background: '#F3EEDA', padding: '2px 8px', borderRadius: 10, marginLeft: 6 }}>
                      Class Teacher — {CLASS_OPTIONS.find((c) => c.value === t.class_teacher_of)?.label}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                  {t.id !== currentUserId ? (
                    <button onClick={() => setChangingRoleFor(t)} style={{ fontSize: 12, color: COLORS.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                      {t.role === 'admin' ? 'Change Role' : 'Promote to Admin'}
                    </button>
                  ) : (
                    <span style={{ fontSize: 12, color: COLORS.muted, fontStyle: 'italic' }} title="Ask another admin to change your own role">
                      (this is you)
                    </span>
                  )}
                  {!(t.role === 'admin' && NON_TEACHING_TITLES.includes(t.title)) && (
                    <button onClick={() => setAssigningTeacher(t)} style={{ fontSize: 12, color: COLORS.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                      + Add Subject/Class
                    </button>
                  )}
                  <button onClick={() => removeTeacher(t.id, t.full_name)} style={{ fontSize: 12, color: COLORS.warn, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    Remove
                  </button>
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 11.5, color: COLORS.muted }}>
                  Class Teacher of:{' '}
                  <select
                    value={t.class_teacher_of || ''}
                    onChange={(e) => setClassTeacher(t.id, e.target.value)}
                    style={{ fontSize: 11.5, padding: '3px 6px', border: `1px solid ${COLORS.ruleLight}`, borderRadius: 4 }}
                  >
                    <option value="">— None —</option>
                    {CLASS_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </label>
              </div>
              {!(t.role === 'admin' && NON_TEACHING_TITLES.includes(t.title)) && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {t.assignments.length === 0 && (
                    <span style={{ fontSize: 12, color: COLORS.muted, fontStyle: 'italic' }}>No subjects assigned</span>
                  )}
                  {t.assignments.map((a) => (
                    <span key={a.id} style={{ ...pillStatic, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {a.subjects?.name} · {CLASS_OPTIONS.find((c) => c.value === a.class_label)?.label || a.class_label}
                      <span onClick={() => removeAssignment(a.id)} style={{ cursor: 'pointer', color: COLORS.warn, fontWeight: 700 }}>✕</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {changingRoleFor && (
        <ChangeRoleModal
          teacher={changingRoleFor}
          teachers={teachers}
          onClose={() => setChangingRoleFor(null)}
          onChanged={loadTeachers}
        />
      )}
      {assigningTeacher && (
        <AddAssignmentModal
          teacherId={assigningTeacher.id}
          onClose={() => setAssigningTeacher(null)}
          onAdded={() => { setAssigningTeacher(null); notify('Subject/class added.'); loadTeachers() }}
        />
      )}
    </div>
  )
}

// ============================================================================
// ADMIN: Performance Track — full class ranking list + most improved,
// separate from individual report cards
// ============================================================================
function buildPerformanceTrackHtml(cohortLabel, examLabel, mostImproved, rankings) {
  const improvedRows = mostImproved.map((m, i) => `
    <tr style="border-top:1px solid #E4DFD1;">
      <td style="padding:6px 10px;">${i + 1}</td>
      <td style="padding:6px 10px;">${m.student.full_name}</td>
      <td style="padding:6px 10px;color:#6B6558;">${m.student.admission_no}</td>
      <td style="padding:6px 10px;">${m.previousRank} → <strong>${m.currentRank}</strong></td>
      <td style="padding:6px 10px;color:#3E6B4F;font-weight:700;">▲ ${m.change}</td>
    </tr>`).join('')

  const rankingRows = rankings.map((r) => `
    <tr style="border-top:1px solid #E4DFD1;">
      <td style="padding:6px 10px;font-weight:700;">${r.rnk}</td>
      <td style="padding:6px 10px;">${r.student.full_name}</td>
      <td style="padding:6px 10px;color:#6B6558;">${r.student.admission_no}</td>
      <td style="padding:6px 10px;">${r.total_points} / ${r.max_points}</td>
    </tr>`).join('')

  return `
    <div style="max-width:760px;margin:0 auto;font-family:sans-serif;color:#1E2A24;padding:20px;">
      <div style="border-bottom:2px solid #2C3E37;padding-bottom:10px;margin-bottom:16px;">
        <div style="font-size:18px;font-weight:800;color:#2C3E37;">Performance Track — ${cohortLabel}</div>
        <div style="font-size:12px;color:#6B6558;">${examLabel}</div>
      </div>

      ${mostImproved.length > 0 ? `
      <div style="font-size:13px;font-weight:700;color:#9C6B2E;margin-bottom:6px;">🏆 Most Improved</div>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:20px;">
        <thead><tr style="background:#F7F5EF;"><th style="text-align:left;padding:6px 10px;">#</th><th style="text-align:left;padding:6px 10px;">Student</th><th style="text-align:left;padding:6px 10px;">Adm No.</th><th style="text-align:left;padding:6px 10px;">Rank Change</th><th style="text-align:left;padding:6px 10px;">Δ</th></tr></thead>
        <tbody>${improvedRows}</tbody>
      </table>` : ''}

      <div style="font-size:13px;font-weight:700;color:#2C3E37;margin-bottom:6px;">Full Class Ranking</div>
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
        <thead><tr style="background:#2C3E37;color:#F4F1E8;"><th style="text-align:left;padding:6px 10px;">Position</th><th style="text-align:left;padding:6px 10px;">Student</th><th style="text-align:left;padding:6px 10px;">Adm No.</th><th style="text-align:left;padding:6px 10px;">Total Points</th></tr></thead>
        <tbody>${rankingRows}</tbody>
      </table>
    </div>
  `
}

function buildPerformanceTrackWhatsAppText(cohortLabel, examLabel, mostImproved, rankings) {
  const lines = [`Performance Track — ${cohortLabel}`, examLabel, '']
  if (mostImproved.length > 0) {
    lines.push('🏆 Most Improved:')
    mostImproved.slice(0, 5).forEach((m, i) => {
      lines.push(`${i + 1}. ${m.student.full_name} — ${m.previousRank}→${m.currentRank} (▲${m.change})`)
    })
    lines.push('')
  }
  lines.push('Top of Class Ranking:')
  rankings.slice(0, 10).forEach((r) => {
    lines.push(`${r.rnk}. ${r.student.full_name} — ${r.total_points}/${r.max_points}`)
  })
  return lines.join('\n')
}

function PerformanceTrackScreen() {
  const [cohort, setCohort] = useState('form_4')
  const [exams, setExams] = useState([])
  const [selectedExamId, setSelectedExamId] = useState('')
  const [rankings, setRankings] = useState([])
  const [mostImproved, setMostImproved] = useState([])
  const [loading, setLoading] = useState(false)
  const isNarrow = useIsNarrow()

  useEffect(() => {
    supabase.from('exams').select('*').order('order_index', { ascending: false }).then(({ data }) => {
      setExams(data || [])
      if (data && data.length > 0) setSelectedExamId(data[0].id)
    })
  }, [])

  useEffect(() => {
    if (selectedExamId && cohort) loadRankings()
  }, [selectedExamId, cohort])

  async function loadRankings() {
    setLoading(true)
    const exam = exams.find((e) => e.id === selectedExamId)
    if (!exam) { setLoading(false); return }
    const prevExam = exams
      .filter((e) => e.order_index < exam.order_index)
      .sort((a, b) => b.order_index - a.order_index)[0]

    const [{ data: current }, { data: students }] = await Promise.all([
      supabase.rpc('compute_cohort_rankings', { p_cohort: cohort, p_exam_id: selectedExamId }),
      supabase.from('students').select('id, full_name, admission_no').eq('cohort', cohort),
    ])
    const studentById = Object.fromEntries((students || []).map((s) => [s.id, s]))

    const currentRanked = (current || [])
      .map((r) => ({ ...r, student: studentById[r.student_id] }))
      .filter((r) => r.student)
      .sort((a, b) => a.rnk - b.rnk)
    setRankings(currentRanked)

    if (prevExam) {
      const { data: previous } = await supabase.rpc('compute_cohort_rankings', { p_cohort: cohort, p_exam_id: prevExam.id })
      const prevByStudent = Object.fromEntries((previous || []).map((r) => [r.student_id, r]))

      const improved = currentRanked
        .filter((r) => prevByStudent[r.student_id])
        .map((r) => {
          const prev = prevByStudent[r.student_id]
          return {
            student: r.student,
            currentRank: Number(r.rnk),
            previousRank: Number(prev.rnk),
            change: Number(prev.rnk) - Number(r.rnk), // positive = moved up (improved)
            currentPoints: r.total_points,
            previousPoints: prev.total_points,
          }
        })
        .filter((r) => r.change > 0)
        .sort((a, b) => b.change - a.change)
        .slice(0, 10)
      setMostImproved(improved)
    } else {
      setMostImproved([])
    }
    setLoading(false)
  }

  const cohortOptions = [
    { value: 'form_3', label: 'Form 3' },
    { value: 'form_4', label: 'Form 4' },
    { value: 'grade_10', label: 'Grade 10' },
  ]
  const cohortLabel = cohortOptions.find((c) => c.value === cohort)?.label || cohort
  const currentExam = exams.find((e) => e.id === selectedExamId)
  const examLabel = currentExam ? `${currentExam.name} — ${currentExam.term} ${currentExam.year}` : ''

  async function downloadPdf() {
    const container = document.createElement('div')
    container.style.position = 'fixed'
    container.style.left = '-9999px'
    container.style.background = '#fff'
    container.style.width = '800px'
    container.innerHTML = buildPerformanceTrackHtml(cohortLabel, examLabel, mostImproved, rankings)
    document.body.appendChild(container)
    const canvas = await html2canvas(container, { scale: 2, backgroundColor: '#ffffff' })
    document.body.removeChild(container)
    const imgData = canvas.toDataURL('image/png')
    const pdf = new jsPDF('p', 'mm', 'a4')
    const pageWidth = pdf.internal.pageSize.getWidth()
    const imgWidth = pageWidth - 20
    const imgHeight = (canvas.height * imgWidth) / canvas.width
    pdf.addImage(imgData, 'PNG', 10, 10, imgWidth, imgHeight)
    pdf.save(`${cohortLabel.replace(/\s+/g, '_')}_${examLabel.replace(/[^\w]+/g, '_')}_Performance_Track.pdf`)
  }

  function printTrack() {
    const container = document.createElement('div')
    container.id = 'print-pt-container'
    container.innerHTML = buildPerformanceTrackHtml(cohortLabel, examLabel, mostImproved, rankings)
    const style = document.createElement('style')
    style.id = 'print-pt-style'
    style.innerHTML = `
      @media print {
        body > *:not(#print-pt-container) { display: none !important; }
        #print-pt-container { display: block !important; }
      }
      @media screen { #print-pt-container { display: none; } }
    `
    document.head.appendChild(style)
    document.body.appendChild(container)
    window.print()
    const cleanup = () => {
      document.body.removeChild(container)
      document.head.removeChild(style)
      window.removeEventListener('afterprint', cleanup)
    }
    window.addEventListener('afterprint', cleanup)
  }

  const whatsAppText = buildPerformanceTrackWhatsAppText(cohortLabel, examLabel, mostImproved, rankings)
  const whatsAppShareLink = `https://wa.me/?text=${encodeURIComponent(whatsAppText)}`

  return (
    <div style={pageWrap}>
      <h2>Performance Track</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 20 }}>
        Full class ranking and most-improved students for an exam, compared against the one before it.
      </p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <label style={fieldLabel}>Cohort
          <select value={cohort} onChange={(e) => setCohort(e.target.value)} style={{ ...input, minWidth: 160 }}>
            {cohortOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label style={fieldLabel}>Exam
          <select value={selectedExamId} onChange={(e) => setSelectedExamId(e.target.value)} style={{ ...input, minWidth: 220 }}>
            {exams.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.term} {e.year}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', gap: 8, alignSelf: 'flex-end', marginBottom: 10 }}>
          <a href={whatsAppShareLink} target="_blank" rel="noreferrer" style={{ ...secondaryBtn, textDecoration: 'none', display: 'inline-block' }}>
            💬 Share via WhatsApp
          </a>
          <button onClick={printTrack} style={secondaryBtn}>🖨 Print</button>
          <button onClick={downloadPdf} style={btn}>⬇ Download PDF</button>
        </div>
      </div>

      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : (
        <>
          {mostImproved.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <div style={sectionLabel}>🏆 Most Improved</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {mostImproved.map((m, i) => (
                  <div key={m.student.id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: i === 0 ? COLORS.accentSoft : COLORS.card, border: `1px solid ${COLORS.ruleLight}`,
                    borderRadius: 8, padding: '10px 16px', flexWrap: 'wrap', gap: 8,
                  }}>
                    <div>
                      <span style={{ fontWeight: 700, fontSize: 13.5 }}>{i + 1}. {m.student.full_name}</span>
                      <span style={{ fontSize: 11.5, color: COLORS.muted, marginLeft: 8 }}>{m.student.admission_no}</span>
                    </div>
                    <div style={{ fontSize: 12.5 }}>
                      <span style={{ color: COLORS.muted }}>{m.previousRank}</span>
                      <span style={{ margin: '0 6px' }}>→</span>
                      <strong>{m.currentRank}</strong>
                      <span style={{ color: COLORS.good, fontWeight: 700, marginLeft: 8 }}>▲ {m.change} {m.change === 1 ? 'place' : 'places'}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={sectionLabel}>Full Class Ranking</div>
          {isNarrow ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rankings.map((r) => (
                <div key={r.student_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: '10px 14px' }}>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: 13.5 }}>{r.rnk}. {r.student.full_name}</span>
                    <div style={{ fontSize: 11, color: COLORS.muted }}>{r.student.admission_no}</div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{r.total_points}/{r.max_points}</div>
                </div>
              ))}
              {rankings.length === 0 && (
                <div style={{ textAlign: 'center', color: COLORS.muted, padding: 24, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
                  No marks recorded for this cohort/exam yet.
                </div>
              )}
            </div>
          ) : (
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
              <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>Position</th><th style={th}>Student</th><th style={th}>Adm. No.</th><th style={th}>Total Points</th></tr></thead>
                <tbody>
                  {rankings.map((r) => (
                    <tr key={r.student_id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                      <td style={{ ...td, fontWeight: 700 }}>{r.rnk}</td>
                      <td style={td}>{r.student.full_name}</td>
                      <td style={{ ...td, color: COLORS.muted }}>{r.student.admission_no}</td>
                      <td style={td}>{r.total_points} / {r.max_points}</td>
                    </tr>
                  ))}
                  {rankings.length === 0 && (
                    <tr><td colSpan={4} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 24 }}>No marks recorded for this cohort/exam yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ============================================================================
// SHARED: Attendance core — date picker + student list + status toggles
// ============================================================================
function AttendanceCore({ classLabel, recorderId }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [students, setStudents] = useState([])
  const [statusByStudent, setStatusByStudent] = useState({})
  const [drafts, setDrafts] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const isNarrow = useIsNarrow()

  useEffect(() => { if (classLabel) loadStudentsAndAttendance() }, [classLabel, date])

  async function loadStudentsAndAttendance() {
    setLoading(true)
    const { data: studentData } = await supabase
      .from('students').select('*').eq('cohort', classLabel).order('full_name')
    setStudents(studentData || [])

    const { data: attData } = await supabase
      .from('attendance').select('*').eq('date', date)
      .in('student_id', (studentData || []).map((s) => s.id))

    const byStudent = {}
    ;(attData || []).forEach((a) => { byStudent[a.student_id] = a.status })
    setStatusByStudent(byStudent)
    setDrafts({})
    setLoading(false)
  }

  function setStatus(studentId, status) {
    setDrafts((prev) => ({ ...prev, [studentId]: status }))
  }

  async function saveAll() {
    setSaving(true)
    setSavedMsg('')
    const rows = students.map((s) => ({
      student_id: s.id,
      date,
      status: drafts[s.id] || statusByStudent[s.id] || 'present',
      recorded_by: recorderId,
    }))
    const { error } = await supabase.from('attendance').upsert(rows, { onConflict: 'student_id,date' })
    if (!error) {
      setSavedMsg(`Saved attendance for ${rows.length} students at ${new Date().toLocaleTimeString()}`)
      loadStudentsAndAttendance()
    }
    setSaving(false)
  }

  function markAllPresent() {
    const all = {}
    students.forEach((s) => { all[s.id] = 'present' })
    setDrafts(all)
  }

  const statusColors = {
    present: { bg: COLORS.goodSoft, fg: COLORS.good, label: 'Present' },
    absent: { bg: COLORS.warnSoft, fg: COLORS.warn, label: 'Absent' },
    late: { bg: COLORS.accentSoft, fg: COLORS.accent, label: 'Late' },
  }

  const presentCount = students.filter((s) => (drafts[s.id] || statusByStudent[s.id] || 'present') === 'present').length

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={fieldLabel}>Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} />
        </label>
        <button onClick={markAllPresent} style={secondaryBtn}>✓ Mark all present</button>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: COLORS.muted }}>
          {presentCount} / {students.length} present
        </div>
      </div>

      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: isNarrow ? 8 : 0 }}>
          {students.map((s, i) => {
            const current = drafts[s.id] || statusByStudent[s.id] || 'present'
            return (
              <div
                key={s.id}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', background: isNarrow ? COLORS.card : (i % 2 ? COLORS.paper : '#fff'),
                  border: isNarrow ? `1px solid ${COLORS.ruleLight}` : 'none',
                  borderRadius: isNarrow ? 8 : 0, borderBottom: isNarrow ? undefined : `1px solid ${COLORS.ruleLight}`,
                  flexWrap: 'wrap', gap: 8,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{s.full_name}</div>
                  <div style={{ fontSize: 11, color: COLORS.muted }}>{s.admission_no}</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['present', 'absent', 'late'].map((st) => (
                    <button
                      key={st}
                      onClick={() => setStatus(s.id, st)}
                      style={{
                        padding: '5px 12px', borderRadius: 14, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                        border: `1px solid ${current === st ? statusColors[st].fg : COLORS.ruleLight}`,
                        background: current === st ? statusColors[st].bg : '#fff',
                        color: current === st ? statusColors[st].fg : COLORS.muted,
                      }}
                    >
                      {statusColors[st].label}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
          {students.length === 0 && (
            <div style={{ textAlign: 'center', color: COLORS.muted, padding: 24, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
              No students in this class yet.
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <span style={{ fontSize: 12, color: COLORS.muted }}>{savedMsg || 'Unsaved changes are only committed once you save.'}</span>
        <button onClick={saveAll} disabled={saving || students.length === 0} style={btn}>{saving ? 'Saving...' : 'Save Attendance'}</button>
      </div>
    </div>
  )
}

// ============================================================================
// ADMIN: Attendance — any cohort
// ============================================================================
function AdminAttendanceScreen({ profile }) {
  const [cohort, setCohort] = useState('form_4')
  const cohortOptions = [
    { value: 'form_3', label: 'Form 3' },
    { value: 'form_4', label: 'Form 4' },
    { value: 'grade_10', label: 'Grade 10' },
  ]
  return (
    <div style={pageWrap}>
      <h2>Attendance</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 20 }}>Mark daily attendance for any class.</p>
      <label style={{ ...fieldLabel, marginBottom: 18, maxWidth: 220 }}>Class
        <select value={cohort} onChange={(e) => setCohort(e.target.value)} style={input}>
          {cohortOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>
      <AttendanceCore classLabel={cohort} recorderId={profile.id} />
    </div>
  )
}

// ============================================================================
// TEACHER: Attendance — only their own assigned classes
// ============================================================================
function TeacherAttendanceScreen({ teacherId }) {
  const [classTeacherOf, setClassTeacherOf] = useState(undefined) // undefined = loading, null = not appointed
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadMyAppointment() }, [teacherId])

  async function loadMyAppointment() {
    setLoading(true)
    const { data } = await supabase.from('profiles').select('class_teacher_of').eq('id', teacherId).single()
    setClassTeacherOf(data?.class_teacher_of || null)
    setLoading(false)
  }

  if (loading) return <p style={{ color: COLORS.muted }}>Loading...</p>
  if (!classTeacherOf) {
    return (
      <div style={{ background: COLORS.warnSoft, color: COLORS.warn, padding: '14px 18px', borderRadius: 8, fontSize: 13 }}>
        You haven't been appointed as a Class Teacher yet. An admin needs to assign you to a class in the Teachers tab before you can take attendance.
      </div>
    )
  }

  return (
    <div>
      <div style={{ fontSize: 13, color: COLORS.muted, marginBottom: 16 }}>
        You are the Class Teacher for <strong style={{ color: COLORS.ink }}>{CLASS_OPTIONS.find((c) => c.value === classTeacherOf)?.label}</strong>.
      </div>
      <AttendanceCore classLabel={classTeacherOf} recorderId={teacherId} />
    </div>
  )
}

// ============================================================================
// TIMETABLE
// ============================================================================
// Tables this feature expects (create via Supabase SQL editor):
//
// create table timetable_periods (
//   id uuid primary key default gen_random_uuid(),
//   label text not null,            -- e.g. "Period 1"
//   start_time time not null,
//   end_time time not null,
//   order_index int not null
// );
//
// create table timetable_slots (
//   id uuid primary key default gen_random_uuid(),
//   day_of_week int not null,       -- 1=Mon .. 5=Fri
//   period_id uuid references timetable_periods(id),   -- null for a custom/flexible block
//   start_time time not null,
//   end_time time not null,
//   class_label text not null,
//   subject_id uuid references subjects(id),
//   teacher_id uuid references profiles(id),
//   room text,
//   source text default 'manual',   -- 'manual' | 'import' | 'generated'
//   created_at timestamptz default now()
// );

const TIMETABLE_DAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
]

function ttToMinutes(t) {
  if (!t) return 0
  const [h, m] = t.split(':').map(Number)
  return h * 60 + (m || 0)
}
function ttOverlap(aStart, aEnd, bStart, bEnd) {
  return ttToMinutes(aStart) < ttToMinutes(bEnd) && ttToMinutes(bStart) < ttToMinutes(aEnd)
}
// Conflicts = same day + overlapping time + (same teacher OR same room OR same class)
function ttFindConflicts(candidate, existingSlots, excludeId) {
  return existingSlots.filter((s) => {
    if (s.id === excludeId) return false
    if (Number(s.day_of_week) !== Number(candidate.day_of_week)) return false
    if (!ttOverlap(s.start_time, s.end_time, candidate.start_time, candidate.end_time)) return false
    const sameTeacher = candidate.teacher_id && s.teacher_id === candidate.teacher_id
    const sameRoom = candidate.room && s.room && s.room.trim().toLowerCase() === candidate.room.trim().toLowerCase()
    const sameClass = s.class_label === candidate.class_label
    return sameTeacher || sameRoom || sameClass
  })
}
function ttConflictReason(conflict, candidate) {
  if (conflict.teacher_id === candidate.teacher_id) return 'teacher already booked'
  if (candidate.room && conflict.room && conflict.room.trim().toLowerCase() === candidate.room.trim().toLowerCase()) return 'room already booked'
  return 'class already has a lesson then'
}
// Same as ttFindConflicts, except two entries for the same class at the same
// time are allowed if both subjects belong to the same concurrent elective
// group (e.g. Physics/Biology, or the Computer Studies/Business/Agriculture
// one-of block) — those genuinely run at the same time for different
// students within the class. Teacher and room clashes are still blocked.
function ttFindConflictsForGroup(candidate, existingSlots, excludeId, groupSubjectIds) {
  return existingSlots.filter((s) => {
    if (s.id === excludeId) return false
    if (Number(s.day_of_week) !== Number(candidate.day_of_week)) return false
    if (!ttOverlap(s.start_time, s.end_time, candidate.start_time, candidate.end_time)) return false
    const sameTeacher = candidate.teacher_id && s.teacher_id === candidate.teacher_id
    const sameRoom = candidate.room && s.room && s.room.trim().toLowerCase() === candidate.room.trim().toLowerCase()
    const sameClassOutsideGroup = s.class_label === candidate.class_label && !groupSubjectIds.has(s.subject_id)
    return sameTeacher || sameRoom || sameClassOutsideGroup
  })
}
// Groups a class's approved assignments into concurrent blocks (subjects
// scheduled at the same day+period). `dbGroups` are the Dean-defined
// concurrent groups for this class's curriculum (from
// timetable_concurrent_groups, matched by subject_id). If none are defined
// yet, falls back to the legacy hardcoded 8-4-4 pairs (Physics/Biology,
// Geography/History) and the Computer Studies/Business/Agriculture elective
// block, matched by subject name, so existing 8-4-4 schools keep working
// with zero setup. Everything left over (compulsory or unlisted subjects)
// becomes its own single-member group.
function ttBuildSubjectGroups(classAssignments, dbGroups) {
  const used = new Set()
  const groups = []

  if (dbGroups && dbGroups.length > 0) {
    for (const g of dbGroups) {
      const subjectIdSet = new Set(g.subject_ids || [])
      const members = classAssignments.filter((a) => subjectIdSet.has(a.subject_id) && !used.has(a))
      if (members.length > 0) {
        members.forEach((m) => used.add(m))
        groups.push({ members, subjectIds: new Set(members.map((m) => m.subject_id)), label: g.label, concurrent: true })
      }
    }
  } else {
    for (const pair of EXCLUSION_PAIRS) {
      const members = classAssignments.filter((a) => pair.includes(a.subjects?.name) && !used.has(a))
      if (members.length > 0) {
        members.forEach((m) => used.add(m))
        groups.push({ members, subjectIds: new Set(members.map((m) => m.subject_id)), label: pair.join(' / '), concurrent: true })
      }
    }
    const oneOfMembers = classAssignments.filter((a) => ONE_OF_GROUP.includes(a.subjects?.name) && !used.has(a))
    if (oneOfMembers.length > 0) {
      oneOfMembers.forEach((m) => used.add(m))
      groups.push({ members: oneOfMembers, subjectIds: new Set(oneOfMembers.map((m) => m.subject_id)), label: 'Elective (one of)', concurrent: true })
    }
  }

  classAssignments.filter((a) => !used.has(a)).forEach((a) => {
    groups.push({ members: [a], subjectIds: new Set([a.subject_id]), label: a.subjects?.name, concurrent: false })
  })
  return groups
}
// Looks across every defined period (any day) for the closest slot, same duration,
// that produces zero conflicts for this teacher/room/class.
function ttSuggestNearestSlot(candidate, existingSlots, periods, excludeId) {
  const candidates = periods.length > 0
    ? periods.map((p) => ({ day_of_week: candidate.day_of_week, start_time: p.start_time, end_time: p.end_time, period_id: p.id }))
    : []
  // Prefer same day first, then other days; within a day, closest start time first.
  const scored = candidates
    .map((c) => ({
      ...c,
      sameDay: c.day_of_week === candidate.day_of_week ? 0 : 1,
      diff: Math.abs(ttToMinutes(c.start_time) - ttToMinutes(candidate.start_time)),
    }))
    .sort((a, b) => a.sameDay - b.sameDay || a.diff - b.diff)
  for (const c of scored) {
    const test = { ...candidate, day_of_week: c.day_of_week, start_time: c.start_time, end_time: c.end_time, period_id: c.period_id }
    if (ttFindConflicts(test, existingSlots, excludeId).length === 0) return test
  }
  return null
}

// ---- Shared grid renderer (used by both admin and teacher views) ----
function TimetableGrid({ periods, slots, days = TIMETABLE_DAYS, renderCell }) {
  const gridSlots = slots.filter((s) => s.period_id)
  const customSlots = slots.filter((s) => !s.period_id)
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Period</th>
              {days.map((d) => <th key={d.value} style={th}>{d.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {periods.length === 0 && (
              <tr><td colSpan={days.length + 1} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 24 }}>No periods defined yet — add them under Manage.</td></tr>
            )}
            {periods.map((p) => (
              <tr key={p.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                <td style={{ ...td, whiteSpace: 'nowrap', color: COLORS.muted, fontSize: 12 }}>{p.label}<br /><span style={{ fontSize: 10.5 }}>{p.start_time}–{p.end_time}</span></td>
                {days.map((d) => {
                  const cellSlots = gridSlots.filter((s) => s.period_id === p.id && Number(s.day_of_week) === d.value)
                  return <td key={d.value} style={{ ...td, verticalAlign: 'top', minWidth: 120 }}>{cellSlots.map((s) => renderCell(s))}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {customSlots.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={sectionLabel}>Other time blocks (flexible)</div>
          {days.map((d) => {
            const daySlots = customSlots.filter((s) => Number(s.day_of_week) === d.value).sort((a, b) => ttToMinutes(a.start_time) - ttToMinutes(b.start_time))
            if (daySlots.length === 0) return null
            return (
              <div key={d.value} style={{ marginBottom: 8, fontSize: 12.5 }}>
                <strong style={{ color: COLORS.ink }}>{d.label}: </strong>
                {daySlots.map((s, i) => <span key={s.id}>{i > 0 && ', '}{s.start_time}–{s.end_time} {renderCell(s, true)}</span>)}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

function TimetableListView({ slots, renderRowExtra }) {
  const sorted = [...slots].sort((a, b) => a.day_of_week - b.day_of_week || ttToMinutes(a.start_time) - ttToMinutes(b.start_time))
  return (
    <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
      <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse' }}>
        <thead><tr><th style={th}>Day</th><th style={th}>Time</th><th style={th}>Class</th><th style={th}>Subject</th><th style={th}>Teacher</th><th style={th}>Room</th><th style={th}></th></tr></thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
              <td style={td}>{TIMETABLE_DAYS.find((d) => d.value === Number(s.day_of_week))?.label}</td>
              <td style={td}>{s.start_time}–{s.end_time}</td>
              <td style={td}>{CLASS_OPTIONS.find((c) => c.value === s.class_label)?.label || s.class_label}</td>
              <td style={td}>{s.subjects?.name || '—'}</td>
              <td style={td}>{s.profiles?.full_name || '—'}</td>
              <td style={td}>{s.room || '—'}</td>
              <td style={{ ...td, textAlign: 'right' }}>{renderRowExtra ? renderRowExtra(s) : null}</td>
            </tr>
          ))}
          {sorted.length === 0 && <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 24 }}>No timetable entries yet.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

function TimetableScreen() {
  const { notify, confirmAction } = useNotify()
  const [loading, setLoading] = useState(true)
  const [periods, setPeriods] = useState([])
  const [slots, setSlots] = useState([])
  const [subjects, setSubjects] = useState([])
  const [teachers, setTeachers] = useState([])
  const [assignments, setAssignments] = useState([])
  const [viewMode, setViewMode] = useState('grid') // 'grid' | 'list'
  const [managePanel, setManagePanel] = useState(null) // null | 'add' | 'periods' | 'import' | 'concurrency' | 'generate'
  const [classFilter, setClassFilter] = useState('all')
  const [teacherFilter, setTeacherFilter] = useState('all')

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [{ data: periodData }, { data: slotData }, { data: subjectData }, { data: teacherData }, { data: assignData }] = await Promise.all([
      supabase.from('timetable_periods').select('*').order('order_index'),
      supabase.from('timetable_slots').select('*, subjects(name), profiles(full_name)').order('day_of_week'),
      supabase.from('subjects').select('*').order('name'),
      supabase.from('profiles').select('id, full_name, role').eq('status', 'approved').order('full_name'),
      supabase.from('teacher_assignments').select('*, subjects(name), profiles(full_name)'),
    ])
    setPeriods(periodData || [])
    setSlots(slotData || [])
    setSubjects(subjectData || [])
    setTeachers(teacherData || [])
    setAssignments(assignData || [])
    setLoading(false)
  }

  const filteredSlots = slots.filter((s) =>
    (classFilter === 'all' || s.class_label === classFilter) &&
    (teacherFilter === 'all' || s.teacher_id === teacherFilter)
  )

  async function insertSlot(candidate, { allowSuggestion = true } = {}) {
    const conflicts = ttFindConflicts(candidate, slots, candidate.id)
    if (conflicts.length > 0) {
      const reasons = [...new Set(conflicts.map((c) => ttConflictReason(c, candidate)))].join(', ')
      if (!allowSuggestion) { notify(`Conflict: ${reasons}.`, 'error'); return false }
      const suggestion = ttSuggestNearestSlot(candidate, slots, periods, candidate.id)
      if (!suggestion) { notify(`Conflict (${reasons}) and no free slot could be found.`, 'error'); return false }
      const dayLabel = TIMETABLE_DAYS.find((d) => d.value === suggestion.day_of_week)?.label
      const useIt = await confirmAction(
        `Conflict: ${reasons}. Use the nearest available slot instead — ${dayLabel} ${suggestion.start_time}–${suggestion.end_time}?`,
        { confirmLabel: 'Use suggested slot' }
      )
      if (!useIt) return false
      candidate = suggestion
    }
    const { error } = await supabase.from('timetable_slots').insert({
      day_of_week: candidate.day_of_week, period_id: candidate.period_id || null,
      start_time: candidate.start_time, end_time: candidate.end_time,
      class_label: candidate.class_label, subject_id: candidate.subject_id,
      teacher_id: candidate.teacher_id, room: candidate.room || null,
      source: candidate.source || 'manual',
    })
    if (error) { notify(`Couldn't save: ${error.message}`, 'error'); return false }
    return true
  }

  async function handleDeleteSlot(slot) {
    const confirmed = await confirmAction('Remove this timetable entry?', { danger: true, confirmLabel: 'Remove' })
    if (!confirmed) return
    const { error } = await supabase.from('timetable_slots').delete().eq('id', slot.id)
    if (error) { notify(`Couldn't remove: ${error.message}`, 'error'); return }
    notify('Removed.')
    loadAll()
  }

  if (loading) return <div style={pageWrap}><p style={{ color: COLORS.muted }}>Loading...</p></div>

  return (
    <div style={pageWrap}>
      <h2 style={{ marginBottom: 4 }}>Timetable</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 18 }}>Build the school timetable by hand, import it, or generate a draft. Conflicts are blocked automatically.</p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <button onClick={() => setViewMode('grid')} style={viewMode === 'grid' ? btn : secondaryBtn}>Grid view</button>
        <button onClick={() => setViewMode('list')} style={viewMode === 'list' ? btn : secondaryBtn}>List view</button>
        <span style={{ width: 1, background: COLORS.ruleLight, margin: '0 4px' }} />
        <button onClick={() => setManagePanel(managePanel === 'add' ? null : 'add')} style={managePanel === 'add' ? btn : secondaryBtn}>+ Add Entry</button>
        <button onClick={() => setManagePanel(managePanel === 'periods' ? null : 'periods')} style={managePanel === 'periods' ? btn : secondaryBtn}>Periods</button>
        <button onClick={() => setManagePanel(managePanel === 'import' ? null : 'import')} style={managePanel === 'import' ? btn : secondaryBtn}>Import</button>
        <button onClick={() => setManagePanel(managePanel === 'concurrency' ? null : 'concurrency')} style={managePanel === 'concurrency' ? btn : secondaryBtn}>Concurrency</button>
        <button onClick={() => setManagePanel(managePanel === 'generate' ? null : 'generate')} style={managePanel === 'generate' ? btn : secondaryBtn}>Generate</button>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <label style={fieldLabel}>Class
          <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} style={input}>
            <option value="all">All classes</option>
            {CLASS_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label style={fieldLabel}>Teacher
          <select value={teacherFilter} onChange={(e) => setTeacherFilter(e.target.value)} style={input}>
            <option value="all">All teachers</option>
            {teachers.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
          </select>
        </label>
      </div>

      {managePanel === 'add' && (
        <TimetableAddForm
          periods={periods} subjects={subjects} teachers={teachers} assignments={assignments}
          onSubmit={async (candidate) => { const ok = await insertSlot(candidate); if (ok) { notify('Entry added.'); loadAll() } }}
        />
      )}
      {managePanel === 'periods' && <TimetablePeriodsManager periods={periods} onChanged={loadAll} />}
      {managePanel === 'import' && (
        <TimetableImportPanel
          periods={periods} subjects={subjects} teachers={teachers} existingSlots={slots}
          onDone={() => { setManagePanel(null); loadAll() }}
        />
      )}
      {managePanel === 'concurrency' && <TimetableConcurrentGroupsManager subjects={subjects} />}
      {managePanel === 'generate' && (
        <TimetableGenerator
          periods={periods} existingSlots={slots}
          onDone={() => { setManagePanel(null); loadAll() }}
        />
      )}

      <div style={{ marginTop: 20 }}>
        {viewMode === 'grid' ? (
          <TimetableGrid
            periods={periods} slots={filteredSlots}
            renderCell={(s, inline) => (
              <div key={s.id} style={{ background: COLORS.accentSoft, borderRadius: 6, padding: '4px 8px', marginBottom: inline ? 0 : 4, fontSize: 12, display: inline ? 'inline-block' : 'block' }}>
                <div style={{ fontWeight: 700 }}>{s.subjects?.name || '—'} · {CLASS_OPTIONS.find((c) => c.value === s.class_label)?.label || s.class_label}</div>
                <div style={{ color: COLORS.muted }}>{s.profiles?.full_name || '—'}{s.room ? ` · ${s.room}` : ''}</div>
                <button onClick={() => handleDeleteSlot(s)} style={{ background: 'none', border: 'none', color: COLORS.warn, cursor: 'pointer', fontSize: 11, padding: 0 }}>Remove</button>
              </div>
            )}
          />
        ) : (
          <TimetableListView slots={filteredSlots} renderRowExtra={(s) => (
            <button onClick={() => handleDeleteSlot(s)} style={{ fontSize: 12, color: COLORS.warn, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Remove</button>
          )} />
        )}
      </div>
    </div>
  )
}

function TimetableAddForm({ periods, subjects, teachers, assignments, onSubmit }) {
  const [day, setDay] = useState(1)
  const [timeMode, setTimeMode] = useState(periods.length > 0 ? 'period' : 'custom')
  const [periodId, setPeriodId] = useState(periods[0]?.id || '')
  const [customStart, setCustomStart] = useState('08:00')
  const [customEnd, setCustomEnd] = useState('08:40')
  const [classLabel, setClassLabel] = useState(CLASS_OPTIONS[0].value)
  const [subjectId, setSubjectId] = useState('')
  const [teacherId, setTeacherId] = useState('')
  const [room, setRoom] = useState('')
  const [saving, setSaving] = useState(false)

  // Narrow the teacher list to whoever is actually assigned this subject+class, if that's on record
  const suggestedTeachers = assignments.filter((a) => a.subject_id === subjectId && a.class_label === classLabel)

  async function handleSubmit() {
    if (!subjectId || !teacherId) return
    const period = periods.find((p) => p.id === periodId)
    const start_time = timeMode === 'period' ? period?.start_time : customStart
    const end_time = timeMode === 'period' ? period?.end_time : customEnd
    if (!start_time || !end_time) return
    setSaving(true)
    await onSubmit({
      day_of_week: day, period_id: timeMode === 'period' ? periodId : null,
      start_time, end_time, class_label: classLabel, subject_id: subjectId, teacher_id: teacherId, room,
    })
    setSaving(false)
  }

  return (
    <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16, marginBottom: 18 }}>
      <div style={sectionLabel}>Add a timetable entry</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={fieldLabel}>Day
          <select value={day} onChange={(e) => setDay(Number(e.target.value))} style={input}>
            {TIMETABLE_DAYS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </label>
        <label style={fieldLabel}>Time type
          <select value={timeMode} onChange={(e) => setTimeMode(e.target.value)} style={input}>
            <option value="period">Fixed period</option>
            <option value="custom">Custom time block</option>
          </select>
        </label>
        {timeMode === 'period' ? (
          <label style={fieldLabel}>Period
            <select value={periodId} onChange={(e) => setPeriodId(e.target.value)} style={input}>
              {periods.map((p) => <option key={p.id} value={p.id}>{p.label} ({p.start_time}–{p.end_time})</option>)}
            </select>
          </label>
        ) : (
          <>
            <label style={fieldLabel}>Start<input type="time" value={customStart} onChange={(e) => setCustomStart(e.target.value)} style={input} /></label>
            <label style={fieldLabel}>End<input type="time" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} style={input} /></label>
          </>
        )}
        <label style={fieldLabel}>Class
          <select value={classLabel} onChange={(e) => setClassLabel(e.target.value)} style={input}>
            {CLASS_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label style={fieldLabel}>Subject
          <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} style={input}>
            <option value="">Select subject</option>
            {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label style={fieldLabel}>Teacher
          <select value={teacherId} onChange={(e) => setTeacherId(e.target.value)} style={input}>
            <option value="">Select teacher</option>
            {suggestedTeachers.length > 0 && <optgroup label="Assigned to this class/subject">
              {suggestedTeachers.map((a) => <option key={a.teacher_id} value={a.teacher_id}>{a.profiles?.full_name}</option>)}
            </optgroup>}
            <optgroup label="All staff">
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
            </optgroup>
          </select>
        </label>
        <label style={fieldLabel}>Room (optional)<input value={room} onChange={(e) => setRoom(e.target.value)} style={input} placeholder="e.g. Lab 2" /></label>
      </div>
      <button onClick={handleSubmit} disabled={saving || !subjectId || !teacherId} style={btn}>{saving ? 'Saving...' : '+ Add Entry'}</button>
    </div>
  )
}

function TimetablePeriodsManager({ periods, onChanged }) {
  const { notify, confirmAction } = useNotify()
  const [label, setLabel] = useState('')
  const [start, setStart] = useState('08:00')
  const [end, setEnd] = useState('08:40')
  const [saving, setSaving] = useState(false)

  async function addPeriod() {
    if (!label.trim()) return
    setSaving(true)
    const nextOrder = periods.length > 0 ? Math.max(...periods.map((p) => p.order_index)) + 1 : 1
    const { error } = await supabase.from('timetable_periods').insert({ label: label.trim(), start_time: start, end_time: end, order_index: nextOrder })
    setSaving(false)
    if (error) { notify(`Couldn't add: ${error.message}`, 'error'); return }
    setLabel('')
    onChanged()
  }

  async function removePeriod(id) {
    const confirmed = await confirmAction('Remove this period? Any grid entries in it will need a new time.', { danger: true, confirmLabel: 'Remove' })
    if (!confirmed) return
    const { error } = await supabase.from('timetable_periods').delete().eq('id', id)
    if (error) { notify(`Couldn't remove: ${error.message}`, 'error'); return }
    onChanged()
  }

  return (
    <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16, marginBottom: 18 }}>
      <div style={sectionLabel}>Define fixed periods (e.g. Period 1–8)</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={fieldLabel}>Label<input value={label} onChange={(e) => setLabel(e.target.value)} style={input} placeholder="Period 1" /></label>
        <label style={fieldLabel}>Start<input type="time" value={start} onChange={(e) => setStart(e.target.value)} style={input} /></label>
        <label style={fieldLabel}>End<input type="time" value={end} onChange={(e) => setEnd(e.target.value)} style={input} /></label>
      </div>
      <button onClick={addPeriod} disabled={saving} style={secondaryBtn}>{saving ? 'Adding...' : '+ Add Period'}</button>
      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {periods.map((p) => (
          <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, borderTop: `1px solid ${COLORS.ruleLight}`, paddingTop: 6 }}>
            <span>{p.label} — {p.start_time}–{p.end_time}</span>
            <button onClick={() => removePeriod(p.id)} style={{ background: 'none', border: 'none', color: COLORS.warn, cursor: 'pointer', fontSize: 12 }}>Remove</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// Expected CSV columns: day, period_label (or start_time,end_time), class, subject, teacher_username, room
function TimetableImportPanel({ periods, subjects, teachers, existingSlots, onDone }) {
  const { notify } = useNotify()
  const [file, setFile] = useState(null)
  const [importing, setImporting] = useState(false)
  const [summary, setSummary] = useState(null)

  async function handleImport() {
    if (!file) return
    setImporting(true)
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: async (results) => {
        const workingSlots = [...existingSlots]
        let added = 0, adjusted = 0, failed = []
        for (const row of results.data) {
          const dayMatch = TIMETABLE_DAYS.find((d) => d.label.toLowerCase() === (row.day || '').trim().toLowerCase())
          const subject = subjects.find((s) => s.name.toLowerCase() === (row.subject || '').trim().toLowerCase())
          const teacher = teachers.find((t) => t.full_name.toLowerCase() === (row.teacher_username || row.teacher || '').trim().toLowerCase())
          const period = periods.find((p) => p.label.toLowerCase() === (row.period_label || '').trim().toLowerCase())
          const start_time = period?.start_time || row.start_time
          const end_time = period?.end_time || row.end_time
          const classLabel = CLASS_OPTIONS.find((c) => c.value === row.class || c.label.toLowerCase() === (row.class || '').trim().toLowerCase())?.value

          if (!dayMatch || !subject || !teacher || !start_time || !end_time || !classLabel) {
            failed.push(`Row skipped (missing/unmatched data): ${JSON.stringify(row)}`)
            continue
          }
          let candidate = { day_of_week: dayMatch.value, period_id: period?.id || null, start_time, end_time, class_label: classLabel, subject_id: subject.id, teacher_id: teacher.id, room: row.room || null, source: 'import' }
          const conflicts = ttFindConflicts(candidate, workingSlots, null)
          if (conflicts.length > 0) {
            const suggestion = ttSuggestNearestSlot(candidate, workingSlots, periods, null)
            if (!suggestion) { failed.push(`${row.subject} / ${row.class} on ${row.day}: conflict, no free slot found`); continue }
            candidate = suggestion
            adjusted++
          }
          const { data, error } = await supabase.from('timetable_slots').insert({
            day_of_week: candidate.day_of_week, period_id: candidate.period_id, start_time: candidate.start_time,
            end_time: candidate.end_time, class_label: candidate.class_label, subject_id: candidate.subject_id,
            teacher_id: candidate.teacher_id, room: candidate.room, source: 'import',
          }).select().single()
          if (error) { failed.push(`${row.subject} / ${row.class}: ${error.message}`); continue }
          workingSlots.push({ ...candidate, id: data.id })
          added++
        }
        setImporting(false)
        setSummary({ added, adjusted, failed })
        notify(`Imported ${added} entr${added === 1 ? 'y' : 'ies'}${adjusted > 0 ? ` (${adjusted} moved to avoid a conflict)` : ''}.`)
      },
    })
  }

  return (
    <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16, marginBottom: 18 }}>
      <div style={sectionLabel}>Import from CSV</div>
      <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 10 }}>
        Columns: day, period_label (or start_time/end_time), class, subject, teacher_username, room. Teacher must match a staff member's full name exactly.
      </p>
      <input type="file" accept=".csv" onChange={(e) => setFile(e.target.files[0])} style={input} />
      <button onClick={handleImport} disabled={!file || importing} style={btn}>{importing ? 'Importing...' : 'Import CSV'}</button>
      {summary && (
        <div style={{ marginTop: 12, fontSize: 12.5 }}>
          <div style={{ color: COLORS.good }}>{summary.added} added{summary.adjusted > 0 ? `, ${summary.adjusted} auto-adjusted for conflicts` : ''}.</div>
          {summary.failed.length > 0 && (
            <div style={{ color: COLORS.warn, marginTop: 6 }}>
              {summary.failed.length} skipped:
              <ul style={{ margin: '4px 0 0 18px' }}>{summary.failed.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </div>
          )}
          <button onClick={onDone} style={{ ...secondaryBtn, marginTop: 10 }}>Done</button>
        </div>
      )}
    </div>
  )
}

// Heuristic generator: for each teacher assignment, place the requested number
// of periods/week into the first conflict-free day+period slot available.
// The instructions box is stored for reference but is NOT parsed by AI in this
// version — it's a place to note constraints for whoever reviews the draft.
// ---- Dean-facing manager for concurrent subject groups (per curriculum) ----
function TimetableConcurrentGroupsManager({ subjects }) {
  const { notify, confirmAction } = useNotify()
  const { groupsByCurriculum, loading, reload } = useConcurrentGroups()
  const [curriculum, setCurriculum] = useState('844')
  const [label, setLabel] = useState('')
  const [selectedSubjectIds, setSelectedSubjectIds] = useState([])
  const [saving, setSaving] = useState(false)

  const groups = groupsByCurriculum[curriculum] || []

  function toggleSubject(id) {
    setSelectedSubjectIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  async function handleAdd() {
    if (!label.trim()) { notify('Give this group a name, e.g. "Physics / Biology".', 'error'); return }
    if (selectedSubjectIds.length < 2) { notify('Pick at least two subjects that should run at the same time.', 'error'); return }
    setSaving(true)
    const { error } = await supabase.from('timetable_concurrent_groups').insert({
      curriculum, label: label.trim(), subject_ids: selectedSubjectIds,
    })
    setSaving(false)
    if (error) { notify(`Couldn't save: ${error.message}`, 'error'); return }
    setLabel(''); setSelectedSubjectIds([])
    notify('Concurrent group added.')
    reload()
  }

  async function handleRemove(group) {
    const confirmed = await confirmAction(`Remove "${group.label}"? Timetable generation will no longer treat these subjects as concurrent.`, { danger: true, confirmLabel: 'Remove' })
    if (!confirmed) return
    const { error } = await supabase.from('timetable_concurrent_groups').delete().eq('id', group.id)
    if (error) { notify(`Couldn't remove: ${error.message}`, 'error'); return }
    notify('Removed.')
    reload()
  }

  return (
    <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16, marginBottom: 18 }}>
      <div style={sectionLabel}>Concurrent subject groups</div>
      <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 10 }}>
        Subjects placed in the same group are scheduled at the same day + period (e.g. Physics/Biology, or a CBC pathway elective block) instead of getting their own slot. Defined separately for 8-4-4 and CBC since they don't share subjects.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {['844', 'cbc'].map((curr) => (
          <button key={curr} onClick={() => setCurriculum(curr)} style={curriculum === curr ? btn : secondaryBtn}>{CURRICULUM_LABELS[curr]}</button>
        ))}
      </div>

      {loading ? (
        <p style={{ color: COLORS.muted, fontSize: 12.5 }}>Loading...</p>
      ) : (
        <>
          {curriculum === '844' && groups.length === 0 && (
            <p style={{ color: COLORS.muted, fontSize: 12, marginBottom: 10 }}>
              No custom groups yet — the default 8-4-4 groups ({EXCLUSION_PAIRS.map((p) => p.join('/')).join(', ')}, and the Computer Studies/Business Studies/Agriculture elective) are used automatically. Add a group below to override them.
            </p>
          )}
          {groups.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              {groups.map((g) => (
                <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5, borderTop: `1px solid ${COLORS.ruleLight}`, padding: '8px 0' }}>
                  <span>
                    <strong>{g.label}</strong>
                    <span style={{ color: COLORS.muted }}> — {(g.subject_ids || []).map((id) => subjects.find((s) => s.id === id)?.name || '?').join(', ')}</span>
                  </span>
                  <button onClick={() => handleRemove(g)} style={{ background: 'none', border: 'none', color: COLORS.warn, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>Remove</button>
                </div>
              ))}
            </div>
          )}

          <label style={fieldLabel}>New group name
            <input value={label} onChange={(e) => setLabel(e.target.value)} style={input} placeholder="e.g. Physics / Biology" />
          </label>
          <div style={fieldLabel}>Subjects in this group (pick at least two)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, maxHeight: 160, overflowY: 'auto' }}>
            {subjects.map((s) => (
              <label key={s.id} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 6, padding: '4px 8px' }}>
                <input type="checkbox" checked={selectedSubjectIds.includes(s.id)} onChange={() => toggleSubject(s.id)} />
                {s.name}
              </label>
            ))}
          </div>
          <button onClick={handleAdd} disabled={saving} style={btn}>{saving ? 'Saving...' : '+ Add group'}</button>
        </>
      )}
    </div>
  )
}

function TimetableGenerator({ periods, existingSlots, onDone }) {
  const { notify, confirmAction } = useNotify()
  const { groupsByCurriculum } = useConcurrentGroups()
  const [assignments, setAssignments] = useState([])
  const [loadingAssignments, setLoadingAssignments] = useState(true)
  const [perWeek, setPerWeek] = useState({})
  const [instructions, setInstructions] = useState('')
  const [replaceGenerated, setReplaceGenerated] = useState(true)
  const [fillEverySlot, setFillEverySlot] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState(null)

  // Only Dean-approved teacher/subject/class assignments are eligible for
  // generation — a freshly self-assigned teacher won't show up here until
  // the Dean approves them under Approvals.
  useEffect(() => {
    setLoadingAssignments(true)
    supabase
      .from('teacher_assignments')
      .select('*, subjects(name), profiles(full_name)')
      .eq('status', 'approved')
      .then(({ data }) => {
        const approved = data || []
        setAssignments(approved)
        setPerWeek(Object.fromEntries(approved.map((a) => [`${a.teacher_id}-${a.subject_id}-${a.class_label}`, 3])))
        setLoadingAssignments(false)
      })
  }, [])

  async function handleGenerate() {
    if (periods.length === 0) { notify('Add at least one period first, under Manage → Periods.', 'error'); return }
    if (assignments.length === 0) { notify('No Dean-approved teacher assignments yet — approve some under Approvals first.', 'error'); return }
    setGenerating(true)
    let working = replaceGenerated ? existingSlots.filter((s) => s.source !== 'generated') : [...existingSlots]
    if (replaceGenerated) {
      await supabase.from('timetable_slots').delete().eq('source', 'generated')
    }
    const toInsert = []
    const unplacedRequested = []
    const classesFilled = {}
    const classesWithNoAssignments = []

    for (const c of CLASS_OPTIONS) {
      const classAssignments = assignments.filter((a) => a.class_label === c.value)
      const totalSlots = TIMETABLE_DAYS.length * periods.length
      if (classAssignments.length === 0) {
        classesWithNoAssignments.push(c.label)
        classesFilled[c.label] = { filled: 0, total: totalSlots }
        continue
      }

      const curriculum = CURRICULUM_FOR_CLASS[c.value]
      const groups = ttBuildSubjectGroups(classAssignments, groupsByCurriculum[curriculum])

      // Helper: places one occurrence of a group at the given day+period.
      // Returns true if at least one member of the group got placed.
      function placeGroupAt(group, day, p) {
        let anyPlaced = false
        for (const a of group.members) {
          const candidate = { day_of_week: day.value, period_id: p.id, start_time: p.start_time, end_time: p.end_time, class_label: c.value, subject_id: a.subject_id, teacher_id: a.teacher_id, room: null }
          if (ttFindConflictsForGroup(candidate, working, null, group.subjectIds).length === 0) {
            working.push({ ...candidate, id: `pending-${toInsert.length}` })
            toInsert.push({ ...candidate, source: 'generated' })
            anyPlaced = true
          }
        }
        return anyPlaced
      }

      // Pass 1: honor the periods/week requested for each group (elective
      // groups use the highest number set among their members).
      for (const group of groups) {
        const need = Math.max(0, ...group.members.map((a) => perWeek[`${a.teacher_id}-${a.subject_id}-${a.class_label}`] ?? 0))
        let placed = 0
        for (const day of TIMETABLE_DAYS) {
          if (placed >= need) break
          for (const p of periods) {
            if (placed >= need) break
            if (placeGroupAt(group, day, p)) placed++
          }
        }
        if (placed < need) unplacedRequested.push(`${group.label} · ${CLASS_OPTIONS.find((cc) => cc.value === c.value)?.label} (${placed}/${need} placed)`)
      }

      // Pass 2 (fillEverySlot): round-robin through this class's groups to
      // occupy every day+period still completely empty for this class.
      if (fillEverySlot) {
        let rrIndex = 0
        for (const day of TIMETABLE_DAYS) {
          for (const p of periods) {
            const alreadyThere = working.some((s) => s.class_label === c.value && Number(s.day_of_week) === day.value && ttOverlap(s.start_time, s.end_time, p.start_time, p.end_time))
            if (alreadyThere) continue
            let attempts = 0
            while (attempts < groups.length) {
              const group = groups[rrIndex % groups.length]
              rrIndex++
              attempts++
              if (placeGroupAt(group, day, p)) break
            }
          }
        }
      }

      // Count distinct day+period cells now occupied for this class (a
      // concurrent elective block still counts as one filled cell).
      let filledCount = 0
      for (const day of TIMETABLE_DAYS) {
        for (const p of periods) {
          if (working.some((s) => s.class_label === c.value && Number(s.day_of_week) === day.value && ttOverlap(s.start_time, s.end_time, p.start_time, p.end_time))) {
            filledCount++
          }
        }
      }
      classesFilled[c.label] = { filled: filledCount, total: totalSlots }
    }

    if (toInsert.length > 0) {
      const { error } = await supabase.from('timetable_slots').insert(toInsert)
      if (error) { setGenerating(false); notify(`Couldn't save generated slots: ${error.message}`, 'error'); return }
    }
    setGenerating(false)
    setResult({ placed: toInsert.length, unplacedRequested, classesFilled, classesWithNoAssignments })
    notify(`Generated ${toInsert.length} entries.`)
  }

  return (
    <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16, marginBottom: 18 }}>
      <div style={sectionLabel}>Generate a draft timetable</div>
      <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 10 }}>
        Set periods/week per assignment, add any notes for whoever reviews the draft, then generate. It fills conflict-free slots automatically — review and adjust afterward.
      </p>
      <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 12 }}>
        {loadingAssignments ? (
          <p style={{ color: COLORS.muted, fontSize: 12.5 }}>Loading approved assignments...</p>
        ) : assignments.length === 0 ? (
          <p style={{ color: COLORS.muted, fontSize: 12.5 }}>
            No Dean-approved teacher assignments yet. Teachers self-assign subjects/classes on first login, but a Dean of Studies needs to approve each one (under Approvals) before it can be scheduled.
          </p>
        ) : (
          assignments.map((a) => {
            const key = `${a.teacher_id}-${a.subject_id}-${a.class_label}`
            return (
              <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5, borderTop: `1px solid ${COLORS.ruleLight}`, padding: '6px 0' }}>
                <span>{a.subjects?.name} · {CLASS_OPTIONS.find((c) => c.value === a.class_label)?.label} · {a.profiles?.full_name}</span>
                <input type="number" min={0} value={perWeek[key] ?? 0} onChange={(e) => setPerWeek((prev) => ({ ...prev, [key]: Number(e.target.value) }))} style={{ ...input, width: 56, marginBottom: 0, padding: '4px 6px' }} />
              </div>
            )
          })
        )}
      </div>
      <div style={{ background: COLORS.paper, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>Concurrent subject constraints in use</div>
        {['844', 'cbc'].map((curr) => {
          const defs = groupsByCurriculum[curr] || []
          const usingLegacyDefaults = curr === '844' && defs.length === 0
          return (
            <div key={curr} style={{ marginBottom: 6, fontSize: 12 }}>
              <strong style={{ color: COLORS.ink }}>{CURRICULUM_LABELS[curr]}: </strong>
              {defs.length > 0 ? (
                <span style={{ color: COLORS.muted }}>{defs.map((g) => g.label).join(', ')}</span>
              ) : usingLegacyDefaults ? (
                <span style={{ color: COLORS.muted }}>{EXCLUSION_PAIRS.map((p) => p.join('/')).join(', ')}, Elective (one of): {ONE_OF_GROUP.join(', ')} (default)</span>
              ) : (
                <span style={{ color: COLORS.muted }}>None defined — every subject scheduled separately</span>
              )}
            </div>
          )
        })}
        <p style={{ color: COLORS.muted, fontSize: 11, marginTop: 4, marginBottom: 0 }}>
          Manage these under Manage → Concurrency on the Timetable screen.
        </p>
      </div>

      <label style={fieldLabel}>Notes / instructions (kept for reference, not auto-applied)
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} style={{ ...input, minHeight: 60 }} placeholder="e.g. avoid double Maths on Fridays" />
      </label>
      <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <input type="checkbox" checked={replaceGenerated} onChange={(e) => setReplaceGenerated(e.target.checked)} />
        Replace any previously generated entries (manual/imported entries are untouched)
      </label>
      <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
        <input type="checkbox" checked={fillEverySlot} onChange={(e) => setFillEverySlot(e.target.checked)} />
        Fill every period for every class (may exceed the periods/week set above)
      </label>
      <button onClick={handleGenerate} disabled={generating} style={btn}>{generating ? 'Generating...' : 'Generate Timetable'}</button>
      {result && (
        <div style={{ marginTop: 12, fontSize: 12.5 }}>
          <div style={{ color: COLORS.good }}>{result.placed} entries placed.</div>

          {fillEverySlot && Object.keys(result.classesFilled).length > 0 && (
            <div style={{ marginTop: 10 }}>
              {CLASS_OPTIONS.map((c) => {
                const stat = result.classesFilled[c.label]
                if (!stat) return null
                const full = stat.filled >= stat.total
                return (
                  <div key={c.value} style={{ color: full ? COLORS.good : COLORS.warn }}>
                    {c.label}: {stat.filled}/{stat.total} periods filled{full ? '' : ' — some periods left empty'}
                  </div>
                )
              })}
            </div>
          )}

          {result.classesWithNoAssignments.length > 0 && (
            <div style={{ color: COLORS.warn, marginTop: 6 }}>
              No approved assignments at all for: {result.classesWithNoAssignments.join(', ')}. Nothing can be scheduled for {result.classesWithNoAssignments.length === 1 ? 'it' : 'them'} until a teacher self-assigns and the Dean approves.
            </div>
          )}

          {result.unplacedRequested.length > 0 && (
            <div style={{ color: COLORS.warn, marginTop: 6 }}>
              Couldn't fully place the requested periods/week for: <ul style={{ margin: '4px 0 0 18px' }}>{result.unplacedRequested.map((u, i) => <li key={i}>{u}</li>)}</ul>
            </div>
          )}

          <button onClick={onDone} style={{ ...secondaryBtn, marginTop: 10 }}>Done</button>
        </div>
      )}
    </div>
  )
}

// ---- TEACHER: read-only view of their own timetable ----
function TeacherTimetableScreen({ teacherId }) {
  const [loading, setLoading] = useState(true)
  const [periods, setPeriods] = useState([])
  const [slots, setSlots] = useState([])
  const [viewMode, setViewMode] = useState('grid')

  useEffect(() => { loadMine() }, [teacherId])

  async function loadMine() {
    setLoading(true)
    const [{ data: periodData }, { data: slotData }] = await Promise.all([
      supabase.from('timetable_periods').select('*').order('order_index'),
      supabase.from('timetable_slots').select('*, subjects(name), profiles(full_name)').eq('teacher_id', teacherId).order('day_of_week'),
    ])
    setPeriods(periodData || [])
    setSlots(slotData || [])
    setLoading(false)
  }

  if (loading) return <p style={{ color: COLORS.muted }}>Loading...</p>

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button onClick={() => setViewMode('grid')} style={viewMode === 'grid' ? btn : secondaryBtn}>Grid view</button>
        <button onClick={() => setViewMode('list')} style={viewMode === 'list' ? btn : secondaryBtn}>List view</button>
      </div>
      {slots.length === 0 ? (
        <div style={{ textAlign: 'center', color: COLORS.muted, padding: 24, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
          No timetable entries for you yet.
        </div>
      ) : viewMode === 'grid' ? (
        <TimetableGrid
          periods={periods} slots={slots}
          renderCell={(s, inline) => (
            <div key={s.id} style={{ background: COLORS.accentSoft, borderRadius: 6, padding: '4px 8px', marginBottom: inline ? 0 : 4, fontSize: 12, display: inline ? 'inline-block' : 'block' }}>
              <div style={{ fontWeight: 700 }}>{s.subjects?.name}</div>
              <div style={{ color: COLORS.muted }}>{CLASS_OPTIONS.find((c) => c.value === s.class_label)?.label}{s.room ? ` · ${s.room}` : ''}</div>
            </div>
          )}
        />
      ) : (
        <TimetableListView slots={slots} />
      )}
    </div>
  )
}

// ============================================================================
// GATE SCREEN — checks school-wide activation before showing login/app
// ============================================================================
function GateScreen({ children }) {
  const [checking, setChecking] = useState(true)
  const [active, setActive] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [activating, setActivating] = useState(false)

  useEffect(() => { checkActive() }, [])

  async function checkActive() {
    setChecking(true)
    const { data, error } = await supabase.rpc('is_school_active')
    if (error) {
      setError('Could not reach the server. Please try again.')
    } else {
      setActive(!!data)
    }
    setChecking(false)
  }

  async function handleActivate(e) {
    e.preventDefault()
    setError('')
    setActivating(true)
    const { data, error } = await supabase.rpc('activate_school', { p_password: password })
    if (error) {
      setError('Something went wrong. Please try again.')
    } else if (data === true) {
      setActive(true)
    } else {
      setError('Incorrect activation password.')
    }
    setActivating(false)
  }

  if (checking) {
    return (
      <div style={wrap}>
        <p style={{ color: COLORS.muted }}>Loading...</p>
      </div>
    )
  }

  if (!active) {
    return (
      <div style={wrap}>
        <form onSubmit={handleActivate} style={card}>
          <div style={{ textAlign: 'center', marginBottom: 14 }}>
            <img src="/crest.png" alt="Crest" style={{ width: 56, height: 56, borderRadius: '50%' }} />
          </div>
          <h3 style={{ textAlign: 'center' }}>Activate This School</h3>
          <p style={{ fontSize: 12, color: COLORS.muted, textAlign: 'center', marginBottom: 14 }}>
            Enter the activation password provided to unlock access for this school.
          </p>
          <input
            type="password"
            placeholder="Activation password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={input}
          />
          {error && <p style={errorText}>{error}</p>}
          <button type="submit" disabled={activating || !password} style={{ ...btn, width: '100%' }}>
            {activating ? 'Activating...' : 'Activate'}
          </button>
        </form>
      </div>
    )
  }

  return children
}

// Reusable editor for a min-score-ordered scale (label/min_score/points rows) backed by a
// Supabase table. Used for both the KCSE grade_scale and the CBC cbc_scale.
function ScaleEditor({ table, scale, loading, reload, labelPlaceholder, defaultLabel, saveConfirmMsg, resetConfirmMsg, resetButtonLabel, savedNotice, resetNotice }) {
  const { notify, confirmAction } = useNotify()
  const [rows, setRows] = useState([])
  const [saving, setSaving] = useState(false)

  useEffect(() => { setRows(scale.map((r) => ({ ...r }))) }, [scale])

  function updateRow(idx, field, value) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)))
  }

  function addRow() {
    setRows((prev) => [...prev, { label: '', min_score: 0, points: 0 }])
  }

  function removeRow(idx) {
    setRows((prev) => prev.filter((_, i) => i !== idx))
  }

  async function handleSave() {
    const cleaned = rows
      .map((r) => ({ label: r.label.trim(), min_score: Number(r.min_score), points: Number(r.points) }))
      .filter((r) => r.label)
    if (cleaned.length === 0) {
      notify('Add at least one grade before saving.', 'error')
      return
    }
    const confirmed = await confirmAction(saveConfirmMsg, { confirmLabel: 'Save' })
    if (!confirmed) return
    setSaving(true)
    const { error: deleteError } = await supabase.from(table).delete().gte('min_score', -1)
    if (deleteError) { setSaving(false); notify(`Couldn't save: ${deleteError.message}`, 'error'); return }
    const { error: insertError } = await supabase.from(table).insert(cleaned)
    setSaving(false)
    if (insertError) { notify(`Couldn't save: ${insertError.message}`, 'error'); return }
    notify(savedNotice)
    reload()
  }

  async function handleReset() {
    const confirmed = await confirmAction(resetConfirmMsg, { danger: true, confirmLabel: 'Reset' })
    if (!confirmed) return
    setSaving(true)
    const { error: deleteError } = await supabase.from(table).delete().gte('min_score', -1)
    setSaving(false)
    if (deleteError) { notify(`Couldn't reset: ${deleteError.message}`, 'error'); return }
    notify(resetNotice)
    reload()
  }

  if (loading) return <p>Loading...</p>

  return (
    <>
      <div style={{ border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'hidden', marginBottom: 14 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>{defaultLabel}</th>
              <th style={th}>Min score</th>
              <th style={th}>Points</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={idx} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                <td style={td}>
                  <input value={r.label} onChange={(e) => updateRow(idx, 'label', e.target.value)} style={{ ...input, marginBottom: 0, width: 70 }} placeholder={labelPlaceholder} />
                </td>
                <td style={td}>
                  <input type="number" value={r.min_score} onChange={(e) => updateRow(idx, 'min_score', e.target.value)} style={{ ...input, marginBottom: 0, width: 90 }} />
                </td>
                <td style={td}>
                  <input type="number" value={r.points} onChange={(e) => updateRow(idx, 'points', e.target.value)} style={{ ...input, marginBottom: 0, width: 90 }} />
                </td>
                <td style={td}>
                  <button onClick={() => removeRow(idx)} style={{ background: 'none', border: 'none', color: COLORS.warn, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={addRow} style={secondaryBtn}>+ Add row</button>
        <button onClick={handleSave} disabled={saving} style={btn}>{saving ? 'Saving...' : 'Save scale'}</button>
        <button onClick={handleReset} disabled={saving} style={secondaryBtn}>{resetButtonLabel}</button>
      </div>
    </>
  )
}

function SettingsScreen() {
  const { scale: kcseScale, loading: kcseLoading, reload: reloadKcse } = useGradeScale()
  const { scale: cbcScale, loading: cbcLoading, reload: reloadCbc } = useCbcScale()

  return (
    <div style={pageWrap}>
      <h2 style={{ marginBottom: 4 }}>Settings</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 20 }}>
        Customize the grading scales used across the school. Each cohort's scale is independent, so changing one does not affect the other.
      </p>

      <div style={sectionLabel}>KCSE grading scale (Form 1–4)</div>
      <ScaleEditor
        table="grade_scale"
        scale={kcseScale}
        loading={kcseLoading}
        reload={reloadKcse}
        labelPlaceholder="e.g. A"
        defaultLabel="Grade"
        saveConfirmMsg="Save this KCSE grading scale? It will immediately change how grades, points, and rankings are calculated for Form 1–4 subjects."
        resetConfirmMsg="Reset to the standard KNEC grading scale? Any custom scale you saved will be replaced."
        resetButtonLabel="Reset to KNEC default"
        savedNotice="KCSE grading scale updated."
        resetNotice="Reset to KNEC grading scale."
      />
      <p style={{ color: COLORS.muted, fontSize: 12, marginTop: 4, marginBottom: 28 }}>
        A student's grade is the highest row whose minimum score they meet or beat, so keep minimum scores in descending order from top to bottom.
      </p>

      <div style={sectionLabel}>CBC competency-level scale (Grade 10)</div>
      <ScaleEditor
        table="cbc_scale"
        scale={cbcScale}
        loading={cbcLoading}
        reload={reloadCbc}
        labelPlaceholder="e.g. EE1"
        defaultLabel="Level"
        saveConfirmMsg="Save this CBC competency scale? It will immediately change how levels, points, and rankings are calculated for Grade 10 subjects."
        resetConfirmMsg="Reset to the standard CBC competency scale? Any custom scale you saved will be replaced."
        resetButtonLabel="Reset to CBC default"
        savedNotice="CBC competency scale updated."
        resetNotice="Reset to CBC competency scale."
      />
      <p style={{ color: COLORS.muted, fontSize: 12, marginTop: 4 }}>
        A student's level is the highest row whose minimum score they meet or beat, so keep minimum scores in descending order from top to bottom.
      </p>
    </div>
  )
}

export default function App() {
  return (
    <GateScreen>
      <NotificationProvider>
        <GradeScaleProvider>
          <CbcScaleProvider>
            <ConcurrentGroupsProvider>
              <AppContent />
            </ConcurrentGroupsProvider>
          </CbcScaleProvider>
        </GradeScaleProvider>
      </NotificationProvider>
    </GateScreen>
  )
}

function AppContent() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [stage, setStage] = useState('login')
  const [loadingProfile, setLoadingProfile] = useState(false)
  const [tab, setTab] = useState('Dashboard')
  const isNarrow = useIsNarrow()

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) loadProfile(session.user.id)
    })
    const { data: listener } = supabase.auth.onAuthStateChange((_e, session) => {
      setSession(session)
      if (session) loadProfile(session.user.id)
      else setProfile(null)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  async function loadProfile(userId) {
    setLoadingProfile(true)
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single()
    setProfile(data)
    setLoadingProfile(false)
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    setStage('login')
  }

  if (session && loadingProfile) {
    return <div style={wrap}><p>Loading...</p></div>
  }

  if (session && profile) {
    if (profile.role === 'teacher' && profile.status !== 'approved') {
      return <PendingApproval fullName={profile.full_name} onLogout={handleLogout} />
    }
    if (profile.role === 'admin') {
      return (
        <div style={{ background: COLORS.paper, minHeight: '100vh', display: 'flex', flexDirection: isNarrow ? 'column' : 'row' }}>
          <TopBar tab={tab} setTab={setTab} onLogout={handleLogout} fullName={profile.full_name} title={profile.title} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {tab === 'Dashboard' && <DashboardScreen onNavigate={setTab} />}
            {tab === 'Students' && <StudentsScreen />}
            {tab === 'Exams' && <ExamsScreen />}
            {tab === 'Reports' && <ReportsScreen />}
            {tab === 'Performance Track' && <PerformanceTrackScreen />}
            {tab === 'Attendance' && <AdminAttendanceScreen profile={profile} />}
            {tab === 'Timetable' && <TimetableScreen />}
            {tab === 'Profiles' && <TeachersScreen currentUserId={profile.id} />}
            {tab === 'Enter Marks' && LEADERSHIP_TITLES.includes(profile.title) && <AdminMarksEntryScreen profile={profile} />}
            {tab === 'My Teaching' && <AdminTeachingScreen profile={profile} />}
            {tab === 'Approvals' && <ApprovalsScreen currentUserId={profile.id} />}
            {tab === 'Settings' && <SettingsScreen />}
          </div>
        </div>
      )
    }
    return <TeacherHome profile={profile} onLogout={handleLogout} />
  }

  if (stage === 'signup') {
    return <Signup onSwitchToLogin={() => setStage('login')} onSignedUp={() => setStage('login')} />
  }
  return <Login onSwitchToSignup={() => setStage('signup')} />
}