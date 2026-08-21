import { useState, useEffect } from 'react'
import Papa from 'papaparse'
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import JSZip from 'jszip'
import { supabase } from './lib/supabaseClient'

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
// Styles
// ============================================================================
const COLORS = {
  paper: '#F7F5EF', card: '#FFFFFF', ink: '#1E2A24', band: '#2C3E37',
  bandText: '#F4F1E8', rule: '#C9C2AE', ruleLight: '#E4DFD1',
  accent: '#9C6B2E', accentSoft: '#E9DDC6', good: '#3E6B4F', goodSoft: '#E4EEE7',
  warn: '#B0442E', warnSoft: '#F6E4DF', muted: '#6B6558',
}
const wrap = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif', background: COLORS.paper }
const card = { width: 340, padding: 28, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 10, background: COLORS.card }
const input = { width: '100%', padding: 10, marginBottom: 10, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box' }
const btn = { padding: '10px 18px', background: COLORS.band, color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }
const secondaryBtn = { padding: '8px 16px', background: COLORS.card, color: COLORS.ink, border: `1px solid ${COLORS.rule}`, borderRadius: 6, cursor: 'pointer', fontSize: 13 }
const errorText = { color: COLORS.warn, fontSize: 12 }
const link = { color: COLORS.accent, cursor: 'pointer' }
const pageWrap = { maxWidth: 980, margin: '0 auto', padding: 'clamp(14px, 4vw, 28px) clamp(12px, 4vw, 20px)', fontFamily: 'sans-serif' }
const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: COLORS.muted, background: COLORS.paper }
const td = { padding: '10px 14px', fontSize: 13 }
const modalOverlay = { position: 'fixed', inset: 0, background: 'rgba(30,42,36,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 50 }
const modalCard = { background: '#fff', borderRadius: 10, padding: 'clamp(14px, 4vw, 24px)', width: '100%', maxWidth: 'min(560px, 94vw)', maxHeight: '90vh', overflowY: 'auto', fontFamily: 'sans-serif', boxSizing: 'border-box' }
const fieldLabel = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: COLORS.muted, fontWeight: 600 }
const sectionLabel = { fontSize: 12, color: COLORS.muted, fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }
const pillStatic = { padding: '5px 12px', borderRadius: 14, fontSize: 12, fontWeight: 600, background: COLORS.accentSoft, color: COLORS.accent, border: `1px solid ${COLORS.accent}` }
function pillBtn(active) {
  return { padding: '5px 12px', borderRadius: 14, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: active ? COLORS.band : COLORS.paper, color: active ? '#fff' : COLORS.ink, border: `1px solid ${active ? COLORS.band : COLORS.ruleLight}` }
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

const TITLE_LIMITS = { 'Principal': 1, 'Deputy Principal': 2, 'Dean of Studies': 1 }

function Signup({ onSwitchToLogin, onSignedUp }) {
  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [roleChoice, setRoleChoice] = useState('teacher') // 'teacher' | 'Principal' | 'Deputy Principal' | 'Dean of Studies'
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
            <option value="Principal" disabled={isTitleFull('Principal')}>Principal{isTitleFull('Principal') ? ' (taken)' : ''}</option>
            <option value="Deputy Principal" disabled={isTitleFull('Deputy Principal')}>Deputy Principal{isTitleFull('Deputy Principal') ? ' (full)' : ''}</option>
            <option value="Dean of Studies" disabled={isTitleFull('Dean of Studies')}>Dean of Studies{isTitleFull('Dean of Studies') ? ' (taken)' : ''}</option>
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
  const tabs = ['Dashboard', 'Students', 'Exams', 'Reports', 'Performance Track', 'Attendance', 'Teachers', 'My Teaching', 'Approvals']
  const isNarrow = useIsNarrow()
  const [menuOpen, setMenuOpen] = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)

  return (
    <div style={{ background: COLORS.band, color: COLORS.bandText, fontFamily: 'sans-serif' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {isNarrow && (
            <button
              onClick={() => setMenuOpen(true)}
              aria-label="Open menu"
              style={{ background: 'none', border: 'none', color: COLORS.bandText, fontSize: 22, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}
            >
              ☰
            </button>
          )}
          <img src="/crest.png" alt="Crest" style={{ width: isNarrow ? 26 : 32, height: isNarrow ? 26 : 32, borderRadius: '50%', flexShrink: 0 }} />
          <div style={{ fontWeight: 700, fontSize: isNarrow ? 14 : 16 }}>
            {isNarrow ? 'PWA Records' : 'Paul Wanjigi Alpine — Records'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: isNarrow ? 8 : 14 }}>
          {!isNarrow && <span style={{ fontSize: 12 }}>{fullName}{title ? ` · ${title}` : ''}</span>}
          <button onClick={() => setShowChangePw(true)} style={{ ...secondaryBtn, background: 'transparent', color: COLORS.bandText, borderColor: 'rgba(255,255,255,0.3)', padding: isNarrow ? '6px 10px' : '8px 16px', fontSize: 12 }}>
            {isNarrow ? '🔑' : 'Change Password'}
          </button>
          <button onClick={onLogout} style={{ ...secondaryBtn, background: 'transparent', color: COLORS.bandText, borderColor: 'rgba(255,255,255,0.3)', padding: isNarrow ? '6px 10px' : '8px 16px', fontSize: 12 }}>
            Log out
          </button>
        </div>
      </div>

      {!isNarrow && (
        <div style={{ maxWidth: 980, margin: '0 auto', padding: '0 12px', display: 'flex', gap: 4, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: '10px 16px', background: tab === t ? COLORS.paper : 'transparent',
                color: tab === t ? COLORS.ink : COLORS.bandText, border: 'none',
                borderTopLeftRadius: 6, borderTopRightRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
              }}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {isNarrow && menuOpen && (
        <div
          onClick={() => setMenuOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 60 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute', top: 0, left: 0, bottom: 0, width: '72vw', maxWidth: 280,
              background: COLORS.paper, boxShadow: '2px 0 12px rgba(0,0,0,0.2)',
              display: 'flex', flexDirection: 'column', padding: '18px 0',
            }}
          >
            <div style={{ padding: '0 20px 14px', borderBottom: `1px solid ${COLORS.ruleLight}`, marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: COLORS.ink }}>{fullName}</div>
              <div style={{ fontSize: 11, color: COLORS.muted }}>{title || 'Paul Wanjigi Alpine — Records'}</div>
            </div>
            {tabs.map((t) => (
              <button
                key={t}
                onClick={() => { setTab(t); setMenuOpen(false) }}
                style={{
                  textAlign: 'left', padding: '14px 20px', background: tab === t ? COLORS.accentSoft : 'transparent',
                  color: COLORS.ink, border: 'none', fontSize: 14, fontWeight: tab === t ? 700 : 500, cursor: 'pointer',
                }}
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
      supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'teacher').eq('status', 'approved'),
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
          <StatCard label="Total teachers" value={counts.teachers} onClick={() => onNavigate('Teachers')} />
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
  const [pending, setPending] = useState([])
  const [loading, setLoading] = useState(true)
  const [actioningId, setActioningId] = useState(null)

  useEffect(() => { loadPending() }, [])

  async function loadPending() {
    setLoading(true)
    const { data, error } = await supabase
      .from('profiles').select('*').eq('status', 'pending')
      .order('created_at', { ascending: true })
    if (!error) setPending(data)
    setLoading(false)
  }

  async function approve(id) {
    const person = pending.find((p) => p.id === id)
    if (person?.role === 'admin' && person.title) {
      const limit = { 'Principal': 1, 'Deputy Principal': 2, 'Dean of Studies': 1 }[person.title]
      const { count } = await supabase
        .from('profiles').select('*', { count: 'exact', head: true })
        .eq('role', 'admin').eq('title', person.title).eq('status', 'approved')
      if ((count ?? 0) >= limit) {
        alert(`Can't approve — ${person.title} already has the maximum of ${limit} approved. Reject this request or remove/reassign the existing one first.`)
        return
      }
    }
    setActioningId(id)
    await supabase.from('profiles').update({ status: 'approved', approved_by: currentUserId, approved_at: new Date().toISOString() }).eq('id', id)
    setActioningId(null)
    loadPending()
  }

  async function reject(id) {
    setActioningId(id)
    await supabase.from('profiles').update({ status: 'rejected', approved_by: currentUserId, approved_at: new Date().toISOString() }).eq('id', id)
    setActioningId(null)
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
// ADMIN: Edit Student modal (core fields only — subject enrollment editing
// is not covered here to keep scope contained; delete + re-add if a
// student's whole subject combination needs to change)
// ============================================================================
function EditStudentModal({ student, onClose, onSaved }) {
  const [fullName, setFullName] = useState(student.full_name)
  const [admissionNo, setAdmissionNo] = useState(student.admission_no)
  const [entranceScore, setEntranceScore] = useState(student.entrance_score ?? '')
  const [entranceMax, setEntranceMax] = useState(student.entrance_max ?? '')
  const [parentName, setParentName] = useState(student.parent_name ?? '')
  const [parentPhone, setParentPhone] = useState(student.parent_phone ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    setSaving(true)
    setError('')
    const { error } = await supabase.from('students').update({
      full_name: fullName.trim(),
      admission_no: admissionNo.trim(),
      entrance_score: entranceScore === '' ? null : Number(entranceScore),
      entrance_max: entranceMax === '' ? null : Number(entranceMax),
      parent_name: parentName.trim() || null,
      parent_phone: parentPhone.trim() || null,
    }).eq('id', student.id)
    if (error) { setError(error.message); setSaving(false); return }
    setSaving(false)
    onSaved()
    onClose()
  }

  return (
    <div style={modalOverlay}>
      <div style={{ ...modalCard, maxWidth: 'min(460px, 94vw)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3>Edit Student</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <p style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14 }}>
          Cohort and subjects can't be changed here — delete and re-add the student if those need to change.
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
        {error && <p style={errorText}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={btn}>{saving ? 'Saving...' : 'Save Changes'}</button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// STUDENTS SCREEN
// ============================================================================
function StudentsScreen() {
  const [students, setStudents] = useState([])
  const [allSubjects, setAllSubjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editingStudent, setEditingStudent] = useState(null)
  const [deletingId, setDeletingId] = useState(null)
  const isNarrow = useIsNarrow()

  useEffect(() => {
    loadStudents()
    supabase.from('subjects').select('*').then(({ data }) => setAllSubjects(data || []))
  }, [])

  async function loadStudents() {
    setLoading(true)
    const { data } = await supabase.from('students').select('*').order('created_at', { ascending: false })
    setStudents(data || [])
    setLoading(false)
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this student? This also removes their marks, subjects, and report history. This cannot be undone.')) return
    setDeletingId(id)
    await supabase.from('students').delete().eq('id', id)
    setDeletingId(null)
    loadStudents()
  }

  return (
    <div style={pageWrap}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2>Students</h2>
          <p style={{ color: COLORS.muted, fontSize: 13, margin: 0 }}>{students.length} students in the system.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowImport(true)} style={secondaryBtn}>Bulk import CSV</button>
          <button onClick={() => setShowAdd(true)} style={btn}>+ Add Student</button>
        </div>
      </div>

      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : isNarrow ? (
        // ---- Card layout for phones: no horizontal scrolling needed ----
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {students.map((s) => (
            <div key={s.id} style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>{s.full_name}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 12.5, marginBottom: 10 }}>
                <div><span style={{ color: COLORS.muted }}>Adm. No.</span><br/>{s.admission_no}</div>
                <div><span style={{ color: COLORS.muted }}>Cohort</span><br/>{s.cohort}{s.pathway ? ` · ${s.pathway}` : ''}</div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <span style={{ color: COLORS.muted }}>Entrance</span><br/>
                  {s.entrance_type ? `${s.entrance_score}/${s.entrance_max}` : '—'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16, borderTop: `1px solid ${COLORS.ruleLight}`, paddingTop: 8 }}>
                <button onClick={() => setEditingStudent(s)} style={{ fontSize: 12.5, color: COLORS.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}>Edit</button>
                <button onClick={() => handleDelete(s.id)} disabled={deletingId === s.id} style={{ fontSize: 12.5, color: COLORS.warn, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}>
                  {deletingId === s.id ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
          {students.length === 0 && (
            <div style={{ textAlign: 'center', color: COLORS.muted, padding: 24, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
              No students yet.
            </div>
          )}
        </div>
      ) : (
        // ---- Table layout for desktop ----
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
          <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Name</th><th style={th}>Adm. No.</th><th style={th}>Cohort</th><th style={th}>Entrance</th><th style={th}></th></tr></thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                  <td style={td}>{s.full_name}</td>
                  <td style={{ ...td, color: COLORS.muted }}>{s.admission_no}</td>
                  <td style={td}>{s.cohort}{s.pathway ? ` · ${s.pathway}` : ''}</td>
                  <td style={{ ...td, color: COLORS.muted }}>{s.entrance_type ? `${s.entrance_score}/${s.entrance_max}` : '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                      <button onClick={() => setEditingStudent(s)} style={{ fontSize: 12, color: COLORS.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Edit</button>
                      <button onClick={() => handleDelete(s.id)} disabled={deletingId === s.id} style={{ fontSize: 12, color: COLORS.warn, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        {deletingId === s.id ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {students.length === 0 && (
                <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 24 }}>No students yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && <AddStudentModal onClose={() => setShowAdd(false)} onSaved={loadStudents} />}
      {showImport && <BulkImportModal onClose={() => setShowImport(false)} onImported={loadStudents} allSubjects={allSubjects} />}
      {editingStudent && <EditStudentModal student={editingStudent} onClose={() => setEditingStudent(null)} onSaved={loadStudents} />}
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
  const [marksGrid, setMarksGrid] = useState({}) // { studentId: { subjectId: score } }
  const [rankings, setRankings] = useState({}) // { studentId: { rnk, total_points, max_points } }
  const [loading, setLoading] = useState(true)
  const isNarrow = useIsNarrow()

  const cohortOptions = [
    { value: 'form_3', label: 'Form 3' },
    { value: 'form_4', label: 'Form 4' },
    { value: 'grade_10', label: 'Grade 10' },
  ]

  useEffect(() => { loadOverview() }, [cohort])

  async function loadOverview() {
    setLoading(true)
    const { data: studentData } = await supabase.from('students').select('id, full_name, admission_no').eq('cohort', cohort).order('full_name')
    setStudents(studentData || [])
    const studentIds = (studentData || []).map((s) => s.id)

    if (studentIds.length === 0) {
      setSubjectColumns([])
      setMarksGrid({})
      setRankings({})
      setLoading(false)
      return
    }

    const { data: enrollments } = await supabase
      .from('student_subjects').select('subject_id, subjects(id, name)').in('student_id', studentIds)
    const subjectMap = {}
    ;(enrollments || []).forEach((e) => { if (e.subjects) subjectMap[e.subjects.id] = e.subjects.name })
    const columns = Object.entries(subjectMap).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
    setSubjectColumns(columns)

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
    </div>
  )
}

function ExamsScreen() {
  const [exams, setExams] = useState([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [term, setTerm] = useState('Term 1')
  const [year, setYear] = useState(2026)
  const [resumeDate, setResumeDate] = useState('')
  const [saving, setSaving] = useState(false)
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
                <input value={principalName} onChange={(e) => setPrincipalName(e.target.value)} style={input} placeholder="e.g. Samuel Mburu" />
              </label>
              <label style={fieldLabel}>Principal's signature (image)
                <input type="file" accept="image/*" onChange={(e) => setPrincipalSigFile(e.target.files[0])} style={input} />
              </label>
              <label style={fieldLabel}>School Manager's name
                <input value={managerName} onChange={(e) => setManagerName(e.target.value)} style={input} placeholder="e.g. Andrias Hammer" />
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
                    <button onClick={() => setViewingExam(e)} style={{ fontSize: 12, color: COLORS.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                      📊 View Marks
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
          Tell us what you teach so you only see the right classes when entering marks.
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
function MarksEntryContent({ teacherId }) {
  const [showManage, setShowManage] = useState(false)
  const [myAssignments, setMyAssignments] = useState([])
  const [selectedAssignment, setSelectedAssignment] = useState('')
  const [exams, setExams] = useState([])
  const [selectedExamId, setSelectedExamId] = useState('')
  const [students, setStudents] = useState([])
  const [marksByStudent, setMarksByStudent] = useState({})
  const [drafts, setDrafts] = useState({})
  const [remarkDrafts, setRemarkDrafts] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const isNarrow = useIsNarrow()

  useEffect(() => { loadAssignmentsAndExams() }, [teacherId])
  useEffect(() => { if (selectedAssignment && selectedExamId) loadStudentsAndMarks() }, [selectedAssignment, selectedExamId])

  async function loadAssignmentsAndExams() {
    setLoading(true)
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
    const assignment = myAssignments.find((a) => a.id === selectedAssignment)
    if (!assignment) { setLoading(false); return }

    const { data: studentData } = await supabase
      .from('students').select('*').eq('cohort', assignment.class_label).order('full_name')
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
    setLoading(false)
  }

  function updateDraft(studentId, value) {
    setDrafts((prev) => ({ ...prev, [studentId]: value }))
  }

  function updateRemarkDraft(studentId, value) {
    setRemarkDrafts((prev) => ({ ...prev, [studentId]: value }))
  }

  async function saveAll() {
    setSaving(true)
    setSavedMsg('')
    const assignment = myAssignments.find((a) => a.id === selectedAssignment)
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

  const assignment = myAssignments.find((a) => a.id === selectedAssignment)
  const enteredCount = students.filter((s) => marksByStudent[s.id] || drafts[s.id] !== undefined).length

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
        <h2>Marks Entry</h2>
        <button onClick={() => setShowManage(true)} style={secondaryBtn}>+ Add another subject/class</button>
      </div>

      {myAssignments.length === 0 ? (
        <p style={{ color: COLORS.muted }}>No subjects assigned yet.</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
            <label style={fieldLabel}>Subject / Class
              <select value={selectedAssignment} onChange={(e) => setSelectedAssignment(e.target.value)} style={{ ...input, minWidth: 220 }}>
                {myAssignments.map((a) => (
                  <option key={a.id} value={a.id}>{a.subjects?.name} — {CLASS_OPTIONS.find((c) => c.value === a.class_label)?.label}</option>
                ))}
              </select>
            </label>
            <label style={fieldLabel}>Exam
              <select value={selectedExamId} onChange={(e) => setSelectedExamId(e.target.value)} style={{ ...input, minWidth: 220 }}>
                {exams.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.term} {e.year}</option>)}
              </select>
            </label>
            <div style={{ marginLeft: 'auto', fontSize: 12, color: COLORS.muted, alignSelf: 'flex-end', paddingBottom: 10 }}>
              {enteredCount} / {students.length} entered
            </div>
          </div>

          {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : isNarrow ? (
            // ---- Card layout for phones ----
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {students.map((s) => {
                const existing = marksByStudent[s.id]
                const draft = drafts[s.id]
                const hasValue = draft !== undefined ? draft !== '' : !!existing
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
                        <input
                          type="text" placeholder="Optional…"
                          defaultValue={existing ? existing.remark || '' : ''}
                          onChange={(e) => updateRemarkDraft(s.id, e.target.value)}
                          style={{ width: '100%', padding: '8px', border: `1px solid ${COLORS.rule}`, borderRadius: 4, boxSizing: 'border-box' }}
                        />
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
                          <input
                            type="text" placeholder="Optional remark…"
                            defaultValue={existing ? existing.remark || '' : ''}
                            onChange={(e) => updateRemarkDraft(s.id, e.target.value)}
                            style={{ width: '100%', minWidth: 140, padding: '6px 8px', border: `1px solid ${COLORS.rule}`, borderRadius: 4, boxSizing: 'border-box' }}
                          />
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
  const [view, setView] = useState('marks') // 'marks' | 'attendance'
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
        </div>
        {view === 'marks' ? <MarksEntryContent teacherId={teacherId} /> : <TeacherAttendanceScreen teacherId={teacherId} />}
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
// GRADING LOGIC (mirrors the SQL functions — kept in sync manually)
// ============================================================================
function kcseGrade(score) {
  if (score >= 80) return 'A'
  if (score >= 75) return 'A-'
  if (score >= 70) return 'B+'
  if (score >= 65) return 'B'
  if (score >= 60) return 'B-'
  if (score >= 55) return 'C+'
  if (score >= 50) return 'C'
  if (score >= 45) return 'C-'
  if (score >= 40) return 'D+'
  if (score >= 35) return 'D'
  if (score >= 30) return 'D-'
  return 'E'
}
const KCSE_POINTS = { A: 12, 'A-': 11, 'B+': 10, B: 9, 'B-': 8, 'C+': 7, C: 6, 'C-': 5, 'D+': 4, D: 3, 'D-': 2, E: 1 }

function cbcLevel(score) {
  if (score >= 90) return 'EE1'
  if (score >= 75) return 'EE2'
  if (score >= 58) return 'ME1'
  if (score >= 41) return 'ME2'
  if (score >= 31) return 'AE1'
  if (score >= 21) return 'AE2'
  if (score >= 11) return 'BE1'
  return 'BE2'
}
const CBC_POINTS = { EE1: 8, EE2: 7, ME1: 6, ME2: 5, AE1: 4, AE2: 3, BE1: 2, BE2: 1 }

// Best-7 aggregate for KCSE: compulsory always count, best electives fill the rest
function computeKcseAggregate(subjectScores) {
  const withScores = subjectScores.filter((s) => s.score !== null && s.score !== undefined)
  const compulsory = withScores.filter((s) => s.is_compulsory)
  const electives = withScores
    .filter((s) => !s.is_compulsory)
    .sort((a, b) => KCSE_POINTS[kcseGrade(b.score)] - KCSE_POINTS[kcseGrade(a.score)])
  const slotsLeft = Math.max(7 - compulsory.length, 0)
  const counted = [...compulsory, ...electives.slice(0, slotsLeft)]
  const total = counted.reduce((sum, s) => sum + KCSE_POINTS[kcseGrade(s.score)], 0)
  const maxTotal = counted.length * 12
  return { total, maxTotal, subjectCount: counted.length }
}

function computeCbcTotal(subjectScores) {
  const withScores = subjectScores.filter((s) => s.score !== null && s.score !== undefined)
  const total = withScores.reduce((sum, s) => sum + CBC_POINTS[cbcLevel(s.score)], 0)
  const maxTotal = withScores.length * 8
  return { total, maxTotal, subjectCount: withScores.length }
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
    .map((r) => `<div style="page-break-after: always; padding: 24px; font-family: sans-serif;">${buildReportHtml(r.report)}</div>`)
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

  useEffect(() => {
    supabase.from('exams').select('*').order('order_index', { ascending: false }).then(({ data }) => {
      setExams(data || [])
      if (data && data.length > 0) setSelectedExamId(data[0].id)
    })
    supabase.from('students').select('*').order('full_name').then(({ data }) => setStudents(data || []))
  }, [])

  // Core computation for a single student — reused by both single & batch modes
  async function computeReportFor(student, examId) {
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
        grade: now ? (isCbc ? cbcLevel(now.score) : kcseGrade(now.score)) : null,
        prevGrade: prev ? (isCbc ? cbcLevel(prev.score) : kcseGrade(prev.score)) : null,
        remark: now ? now.remark : null,
      }
    })

    const aggregate = isCbc
      ? computeCbcTotal(subjectRows.map((r) => ({ score: r.score })))
      : computeKcseAggregate(subjectRows.map((r) => ({ score: r.score, is_compulsory: r.is_compulsory })))

    const { data: rankings } = await supabase.rpc('compute_cohort_rankings', { p_cohort: student.cohort, p_exam_id: examId })
    const sorted = (rankings || []).slice().sort((a, b) => a.rnk - b.rnk)
    const myRanking = sorted.find((r) => r.student_id === student.id)
    const position = myRanking ? Number(myRanking.rnk) : null
    const outOf = sorted.length

    // Previous exam's total + position too, for the "This Term / Last Term" comparison
    let prevAggregate = null, prevPosition = null, prevOutOf = null
    if (prevExam) {
      prevAggregate = isCbc
        ? computeCbcTotal(subjectRows.map((r) => ({ score: r.prevScore })))
        : computeKcseAggregate(subjectRows.map((r) => ({ score: r.prevScore, is_compulsory: r.is_compulsory })))
      const { data: prevRankings } = await supabase.rpc('compute_cohort_rankings', { p_cohort: student.cohort, p_exam_id: prevExam.id })
      const prevSorted = (prevRankings || []).slice().sort((a, b) => a.rnk - b.rnk)
      const prevRanking = prevSorted.find((r) => r.student_id === student.id)
      prevPosition = prevRanking ? Number(prevRanking.rnk) : null
      prevOutOf = prevSorted.length
    }

    // Build the full progress timeline: entrance score -> backfilled
    // historical performance -> every real exam recorded in the system,
    // each converted to a percentage so they all sit on the same 0-100 scale.
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

    const { data: allExams } = await supabase.from('exams').select('*').order('order_index')
    for (const ex of (allExams || [])) {
      const { data: examMarks } = await supabase
        .from('marks').select('score').eq('student_id', student.id).eq('exam_id', ex.id).in('subject_id', subjectIds)
      if (examMarks && examMarks.length > 0) {
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
    const student = students.find((s) => s.id === selectedStudentId)
    const r = await computeReportFor(student, selectedExamId)
    setReport(r)
    setLoading(false)
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
    // Render into a hidden, fixed-width off-screen container rather than
    // capturing the visible on-page element — capturing the live element
    // is unreliable on phones, since it reflows to whatever narrow width
    // the screen gives it and can capture incompletely.
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
    const results = []
    for (const id of selectedBatchIds) {
      const student = students.find((s) => s.id === id)
      const r = await computeReportFor(student, selectedExamId)
      const { error } = await saveReport(r, '', '')
      results.push({ student, ok: !error, report: r })
    }
    setBatchResults(results)
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
                  <textarea value={principalComment} onChange={(e) => setPrincipalComment(e.target.value)} rows={2} style={{ ...input, minWidth: '100%' }} />
                </label>
                <label style={fieldLabel}>Class Teacher's Comments
                  <textarea value={classTeacherComment} onChange={(e) => setClassTeacherComment(e.target.value)} rows={2} style={{ ...input, minWidth: '100%' }} />
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
                  <button onClick={() => window.print()} style={secondaryBtn}>🖨 Print</button>
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
                      <td style={{ ...td, color: r.ok ? COLORS.good : COLORS.warn }}>{r.ok ? '✓ Saved' : '✕ Failed'}</td>
                      <td style={td}>
                        <div style={{ display: 'flex', gap: 10 }}>
                          <button onClick={() => downloadReportAsPdf(r.report)} style={{ fontSize: 12, color: COLORS.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
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
function TeachersScreen() {
  const [teachers, setTeachers] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadTeachers() }, [])

  async function loadTeachers() {
    setLoading(true)
    const { data: teacherProfiles } = await supabase
      .from('profiles')
      .select('*')
      .eq('status', 'approved')
      .order('full_name')

    const withAssignments = await Promise.all(
      (teacherProfiles || []).map(async (t) => {
        const { data: assignments } = await supabase
          .from('teacher_assignments')
          .select('*, subjects(name)')
          .eq('teacher_id', t.id)
        return { ...t, assignments: assignments || [] }
      })
    )
    setTeachers(withAssignments)
    setLoading(false)
  }

  async function removeAssignment(assignmentId) {
    await supabase.from('teacher_assignments').delete().eq('id', assignmentId)
    loadTeachers()
  }

  async function promoteToAdmin(teacherId, name) {
    if (!window.confirm(`Promote ${name} to admin? They will get full access to everything — students, marks, reports, approvals.`)) return
    await supabase.from('profiles').update({ role: 'admin' }).eq('id', teacherId)
    loadTeachers()
  }

  async function removeTeacher(teacherId, name) {
    if (!window.confirm(`Remove ${name}'s access? They will no longer be able to log in or enter marks. This can be reversed by re-approving them.`)) return
    await supabase.from('profiles').update({ status: 'rejected' }).eq('id', teacherId)
    loadTeachers()
  }

  async function setClassTeacher(teacherId, cohort) {
    // Clear anyone else currently appointed to this cohort first —
    // only one class teacher per cohort at a time
    if (cohort) {
      await supabase.from('profiles').update({ class_teacher_of: null }).eq('class_teacher_of', cohort)
    }
    await supabase.from('profiles').update({ class_teacher_of: cohort || null }).eq('id', teacherId)
    loadTeachers()
  }

  return (
    <div style={pageWrap}>
      <h2>Staff</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 20 }}>
        Every teacher (and any admin who also teaches) self-assigns their subjects/classes. Remove an assignment here if it was set up wrong.
      </p>

      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : teachers.length === 0 ? (
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 24, textAlign: 'center', color: COLORS.muted, fontSize: 13 }}>
          No approved staff yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {teachers.map((t) => (
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
                  {t.role !== 'admin' && (
                    <button onClick={() => promoteToAdmin(t.id, t.full_name)} style={{ fontSize: 12, color: COLORS.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                      Promote to Admin
                    </button>
                  )}
                  <button onClick={() => removeTeacher(t.id, t.full_name)} style={{ fontSize: 12, color: COLORS.warn, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    Remove
                  </button>
                </div>
              </div>
              {t.role !== 'admin' && (
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
              )}
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
            </div>
          ))}
        </div>
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
// APP SHELL
// ============================================================================
export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [stage, setStage] = useState('login')
  const [loadingProfile, setLoadingProfile] = useState(false)
  const [tab, setTab] = useState('Dashboard')

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
        <div style={{ background: COLORS.paper, minHeight: '100vh' }}>
          <TopBar tab={tab} setTab={setTab} onLogout={handleLogout} fullName={profile.full_name} title={profile.title} />
          {tab === 'Dashboard' && <DashboardScreen onNavigate={setTab} />}
          {tab === 'Students' && <StudentsScreen />}
          {tab === 'Exams' && <ExamsScreen />}
          {tab === 'Reports' && <ReportsScreen />}
          {tab === 'Performance Track' && <PerformanceTrackScreen />}
          {tab === 'Attendance' && <AdminAttendanceScreen profile={profile} />}
          {tab === 'Teachers' && <TeachersScreen />}
          {tab === 'My Teaching' && <AdminTeachingScreen profile={profile} />}
          {tab === 'Approvals' && <ApprovalsScreen currentUserId={profile.id} />}
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