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
  meanPoints, gradeForMeanPoints,
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
// SCHOOL SETTINGS — logo(s) + custom receipt design, editable by admins in
// Settings, used everywhere the crest currently shows and by receipt/report
// PDFs. Falls back to the bundled /crest.png and the built-in layouts when
// nothing has been uploaded yet.
//
// reportBrandingCache is a plain module-level mirror of the two logo URLs.
// buildReportHtml() below is a plain function (not a component, and it's
// called from several places, some of them outside any component), so it
// can't use the useSchoolSettings() hook directly — it reads this cache
// instead. The provider keeps the cache in sync every time it (re)loads.
// ============================================================================
const SchoolSettingsContext = createContext(null)
// Defaults match what was previously hardcoded in buildReceiptCellHtml / buildReportHtml.
const DEFAULT_RECEIPT_WATERMARK_OPACITY = 0.16
const DEFAULT_REPORT_WATERMARK_OPACITY = 0.05
const reportBrandingCache = {
  logoUrl: '/crest.png', secondaryLogoUrl: '/crest.png',
  watermarkEnabled: true, watermarkOpacity: DEFAULT_REPORT_WATERMARK_OPACITY, watermarkOffsetX: 0, watermarkOffsetY: 0,
}

function useSchoolSettings() {
  const ctx = useContext(SchoolSettingsContext)
  return ctx || {
    logoUrl: '/crest.png', secondaryLogoUrl: '/crest.png', receiptTemplateUrl: null,
    receiptWatermarkEnabled: true, receiptWatermarkOpacity: DEFAULT_RECEIPT_WATERMARK_OPACITY, receiptWatermarkOffsetX: 0, receiptWatermarkOffsetY: 0,
    reportWatermarkEnabled: true, reportWatermarkOpacity: DEFAULT_REPORT_WATERMARK_OPACITY, reportWatermarkOffsetX: 0, reportWatermarkOffsetY: 0,
    loading: false, reload: () => {},
  }
}

function SchoolSettingsProvider({ children }) {
  const [logoUrl, setLogoUrl] = useState('/crest.png')
  const [secondaryLogoUrl, setSecondaryLogoUrl] = useState('/crest.png')
  const [receiptTemplateUrl, setReceiptTemplateUrl] = useState(null)
  const [receiptWatermarkEnabled, setReceiptWatermarkEnabled] = useState(true)
  const [receiptWatermarkOpacity, setReceiptWatermarkOpacity] = useState(DEFAULT_RECEIPT_WATERMARK_OPACITY)
  const [receiptWatermarkOffsetX, setReceiptWatermarkOffsetX] = useState(0)
  const [receiptWatermarkOffsetY, setReceiptWatermarkOffsetY] = useState(0)
  const [reportWatermarkEnabled, setReportWatermarkEnabled] = useState(true)
  const [reportWatermarkOpacity, setReportWatermarkOpacity] = useState(DEFAULT_REPORT_WATERMARK_OPACITY)
  const [reportWatermarkOffsetX, setReportWatermarkOffsetX] = useState(0)
  const [reportWatermarkOffsetY, setReportWatermarkOffsetY] = useState(0)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('school_settings').select('*').eq('id', 1).single()
    const resolvedLogo = data?.logo_url || '/crest.png'
    const resolvedSecondary = data?.secondary_logo_url || '/crest.png'
    const resolvedReceiptEnabled = data?.receipt_watermark_enabled ?? true
    const resolvedReceiptOpacity = data?.receipt_watermark_opacity ?? DEFAULT_RECEIPT_WATERMARK_OPACITY
    const resolvedReceiptOffsetX = data?.receipt_watermark_offset_x ?? 0
    const resolvedReceiptOffsetY = data?.receipt_watermark_offset_y ?? 0
    const resolvedReportEnabled = data?.report_watermark_enabled ?? true
    const resolvedReportOpacity = data?.report_watermark_opacity ?? DEFAULT_REPORT_WATERMARK_OPACITY
    const resolvedReportOffsetX = data?.report_watermark_offset_x ?? 0
    const resolvedReportOffsetY = data?.report_watermark_offset_y ?? 0
    setLogoUrl(resolvedLogo)
    setSecondaryLogoUrl(resolvedSecondary)
    setReceiptTemplateUrl(data?.receipt_template_url || null)
    setReceiptWatermarkEnabled(resolvedReceiptEnabled)
    setReceiptWatermarkOpacity(resolvedReceiptOpacity)
    setReceiptWatermarkOffsetX(resolvedReceiptOffsetX)
    setReceiptWatermarkOffsetY(resolvedReceiptOffsetY)
    setReportWatermarkEnabled(resolvedReportEnabled)
    setReportWatermarkOpacity(resolvedReportOpacity)
    setReportWatermarkOffsetX(resolvedReportOffsetX)
    setReportWatermarkOffsetY(resolvedReportOffsetY)
    reportBrandingCache.logoUrl = resolvedLogo
    reportBrandingCache.secondaryLogoUrl = resolvedSecondary
    reportBrandingCache.watermarkEnabled = resolvedReportEnabled
    reportBrandingCache.watermarkOpacity = resolvedReportOpacity
    reportBrandingCache.watermarkOffsetX = resolvedReportOffsetX
    reportBrandingCache.watermarkOffsetY = resolvedReportOffsetY
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  return (
    <SchoolSettingsContext.Provider value={{
      logoUrl, secondaryLogoUrl, receiptTemplateUrl,
      receiptWatermarkEnabled, receiptWatermarkOpacity, receiptWatermarkOffsetX, receiptWatermarkOffsetY,
      reportWatermarkEnabled, reportWatermarkOpacity, reportWatermarkOffsetX, reportWatermarkOffsetY,
      loading, reload,
    }}>
      {children}
    </SchoolSettingsContext.Provider>
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

  const { logoUrl } = useSchoolSettings()

  return (
    <div style={wrap}>
      <form onSubmit={handleLogin} style={card}>
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <img src={logoUrl} alt="Crest" style={{ width: 56, height: 56, borderRadius: '50%' }} />
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
// Non-teaching-staff (finance) accounts and their approval requests are
// financial/administrative matters. Visible to every leadership title,
// Dean of Studies included.
const FINANCE_VISIBLE_TITLES = ['Principal', 'Deputy Principal', 'Dean of Studies', 'School Manager', 'Director']
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
    const isLeadership = Object.keys(TITLE_LIMITS).includes(roleChoice)
    const isFinance = roleChoice === 'finance'
    // Pass the profile fields as signup metadata instead of a separate
    // insert/update call afterward. The handle_new_user trigger reads this
    // metadata and creates the complete profiles row in the same atomic
    // step as the auth.users insert — no follow-up client call, so there's
    // no RLS policy on `profiles` UPDATE that could silently block it.
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          username: username.trim().toLowerCase(),
          full_name: fullName.trim(),
          role: isLeadership ? 'admin' : (isFinance ? 'finance' : 'teacher'),
          title: isLeadership ? roleChoice : (isFinance ? 'Bursar' : null),
        },
      },
    })
    if (error) { setError(error.message); setLoading(false); return }
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
            <option value="finance">Non-Teaching Staff (Fees & Pocket Money)</option>
            {Object.keys(TITLE_LIMITS).map((title) => (
              <option key={title} value={title} disabled={isTitleFull(title)}>
                {title}{isTitleFull(title) ? ' (taken)' : ''}
              </option>
            ))}
          </select>
        </label>
        {roleChoice !== 'teacher' && roleChoice !== 'finance' && !isTitleFull(roleChoice) && (
          <p style={{ fontSize: 11.5, color: COLORS.accent, marginTop: -4, marginBottom: 10 }}>
            Leadership roles get full admin access once approved — an existing admin will confirm this is genuinely you before it's granted.
          </p>
        )}
        {roleChoice === 'finance' && (
          <p style={{ fontSize: 11.5, color: COLORS.accent, marginTop: -4, marginBottom: 10 }}>
            Non-teaching staff accounts can only see school fees, pocket money, and a basic student list — no marks, timetable, or other admin access.
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
  const canSeeFinance = FINANCE_VISIBLE_TITLES.includes(title)
  const tabs = [
    'Dashboard', 'Students', 'Exams', 'Reports', 'Performance Track', 'Attendance', 'Timetable', 'Profiles',
    ...(isLeadership ? ['Enter Marks'] : []),
    'Graduation',
    ...(canSeeFinance ? ['Finance'] : []),
    'My Teaching', 'Approvals', 'Settings',
  ]
  const isNarrow = useIsNarrow()
  const [menuOpen, setMenuOpen] = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)
  const { logoUrl } = useSchoolSettings()

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
            <img src={logoUrl} alt="Crest" style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0 }} />
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
        <img src={logoUrl} alt="Crest" style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0 }} />
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
    const [{ count: studentCount }, { count: pendingCount }, { count: examCount }, { data: teacherRows }] = await Promise.all([
      supabase.from('students').select('*', { count: 'exact', head: true }).is('graduated_at', null),
      supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('exams').select('*', { count: 'exact', head: true }),
      // Fetched (not head-counted) so we can apply the same "actually
      // teaching" rule used on the Profiles tab: exclude non-teaching admin
      // titles (School Manager, Director) and untitled/system admin accounts.
      supabase.from('profiles').select('role, title').in('role', ['teacher', 'admin']).eq('status', 'approved'),
    ])
    const teacherCount = (teacherRows || []).filter(
      (p) => p.role === 'teacher' || (p.role === 'admin' && p.title && !NON_TEACHING_TITLES.includes(p.title))
    ).length
    setCounts({ students: studentCount ?? 0, pending: pendingCount ?? 0, exams: examCount ?? 0, teachers: teacherCount })
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
function ApprovalsScreen({ currentUserId, viewerTitle }) {
  const { notify } = useNotify()
  const [pending, setPending] = useState([])
  const [loading, setLoading] = useState(true)
  const [actioningId, setActioningId] = useState(null)
  const [pendingAssignments, setPendingAssignments] = useState([])
  const [loadingAssignments, setLoadingAssignments] = useState(true)
  const [actioningAssignmentId, setActioningAssignmentId] = useState(null)
  // Untitled admin accounts (no leadership title) are the top-level system
  // admins, so they must see non-teaching-staff requests too; otherwise those
  // signups are counted on the Dashboard but missing from this list.
  const canSeeFinance = !viewerTitle || FINANCE_VISIBLE_TITLES.includes(viewerTitle)

  useEffect(() => {
    loadPending()
    loadPendingAssignments()
    // Keep every admin's Approvals screen in sync in real time: as soon as
    // one admin approves/rejects a signup or a teacher assignment, it drops
    // off everyone else's pending list too, instead of sitting there until
    // they happen to refresh and risking a duplicate/conflicting action.
    const channel = supabase
      .channel('approvals-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => loadPending())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teacher_assignments' }, () => loadPendingAssignments())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  async function loadPending() {
    setLoading(true)
    const { data, error } = await supabase
      .from('profiles').select('*').eq('status', 'pending')
      .order('created_at', { ascending: true })
    if (!error) setPending(data)
    setLoading(false)
  }

  const visiblePending = canSeeFinance ? pending : pending.filter((p) => p.role !== 'finance')

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

      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : visiblePending.length === 0 ? (
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 24, textAlign: 'center', color: COLORS.muted, fontSize: 13 }}>
          No pending sign-ups right now.
        </div>
      ) : (
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
          <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Full Name</th><th style={th}>Username</th><th style={th}>Requested Role</th><th style={th}>Signed up</th><th style={th}></th></tr></thead>
            <tbody>
              {visiblePending.map((p) => (
                <tr key={p.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                  <td style={td}>{p.full_name}</td>
                  <td style={{ ...td, color: COLORS.muted }}>{p.username}</td>
                  <td style={td}>
                    {p.role === 'admin' ? (
                      <span style={{ color: COLORS.accent, fontWeight: 700 }}>{p.title || 'Admin'}</span>
                    ) : p.role === 'finance' ? (
                      <span style={{ color: COLORS.accent, fontWeight: 700 }}>Non-Teaching Staff</span>
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
  // The technical one-of (Computer Studies/Business Studies/Agriculture) is
  // optional — some students take none of the three — so it's not part of
  // the save gate. Only the Physics/Biology, Geography/History pick is required.
  const canSave = fullName.trim() && admissionNo.trim() && (!isForm34 || electives.length > 0)

  function selectOneOf(subject) {
    setOneOfChoice((prev) => (prev === subject ? '' : subject))
  }

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
            <div style={sectionLabel}>Technical subject (optional) — Computer Studies, Business Studies, or Agriculture; leave unselected if they take none</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              {ONE_OF_GROUP.map((s) => (
                <button key={s} onClick={() => selectOneOf(s)} style={pillBtn(oneOfChoice === s)}>{s}</button>
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
  const [medicalNotes, setMedicalNotes] = useState(student.medical_notes ?? '')
  const [educationalTrack, setEducationalTrack] = useState(student.educational_track ?? '')
  const [extracurricular, setExtracurricular] = useState(student.extracurricular ?? '')
  const [generalNotes, setGeneralNotes] = useState(student.general_notes ?? '')
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

  // Technical one-of is optional here too — see AddStudentModal for why.
  const canSave = fullName.trim() && admissionNo.trim() && (!isForm34 || electives.length > 0)

  async function handleSave() {
    setSaving(true)
    setError('')
    const { error: studentError } = await supabase.from('students').update({
      full_name: fullName.trim(),
      admission_no: admissionNo.trim(),
      entrance_type: entranceScore === '' ? null : (isGrade10 ? 'KJSEA' : 'KCPE'),
      entrance_score: entranceScore === '' ? null : Number(entranceScore),
      entrance_max: entranceMax === '' ? null : Number(entranceMax),
      parent_name: parentName.trim() || null,
      parent_phone: parentPhone.trim() || null,
      medical_notes: medicalNotes.trim() || null,
      educational_track: educationalTrack.trim() || null,
      extracurricular: extracurricular.trim() || null,
      general_notes: generalNotes.trim() || null,
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
      <div style={{ ...modalCard, maxWidth: 'min(560px, 94vw)', maxHeight: '90vh', overflowY: 'auto' }}>
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

        <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${COLORS.ruleLight}` }}>
          <div style={sectionLabel}>Student Details</div>
          <label style={fieldLabel}>Educational track / stream
            <input
              value={educationalTrack} onChange={(e) => setEducationalTrack(e.target.value)} style={input}
              placeholder="e.g. STEM, Arts & Sports Science, Social Sciences"
            />
          </label>
          <label style={fieldLabel}>Medical (conditions / allergies)
            <textarea
              value={medicalNotes} onChange={(e) => setMedicalNotes(e.target.value)}
              style={{ ...input, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="Any conditions, allergies, or medication staff should know about"
            />
          </label>
          <label style={fieldLabel}>Extracurricular activities
            <textarea
              value={extracurricular} onChange={(e) => setExtracurricular(e.target.value)}
              style={{ ...input, minHeight: 50, resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="Clubs, sports, societies, competitions..."
            />
          </label>
          <label style={fieldLabel}>Notes
            <textarea
              value={generalNotes} onChange={(e) => setGeneralNotes(e.target.value)}
              style={{ ...input, minHeight: 50, resize: 'vertical', fontFamily: 'inherit' }}
              placeholder="Anything else worth recording about this student"
            />
          </label>
        </div>

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
                <label style={fieldLabel}>Technical subject (optional) — Computer Studies / Business Studies / Agriculture
                  <select value={oneOfChoice} onChange={(e) => setOneOfChoice(e.target.value)} style={input}>
                    <option value="">None</option>
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
// STUDENT DETAILS — read-only view of a student's full record (medical,
// educational track, extracurricular, notes) surfaced from the Students list.
// ============================================================================
function StudentDetailsModal({ student, onClose, onEdit }) {
  const Field = ({ label, value, multiline }) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: COLORS.muted, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13.5, whiteSpace: multiline ? 'pre-wrap' : 'normal', color: value ? COLORS.ink : COLORS.muted }}>
        {value || 'Not recorded'}
      </div>
    </div>
  )
  return (
    <div style={modalOverlay}>
      <div style={{ ...modalCard, maxWidth: 'min(520px, 94vw)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3>{student.full_name}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
          <Field label="Admission No." value={student.admission_no} />
          <Field label="Cohort" value={`${student.cohort || ''}${student.pathway ? ` · ${student.pathway}` : ''}`} />
          <Field label="Parent / Guardian" value={student.parent_name} />
          <Field label="Parent Phone" value={student.parent_phone} />
        </div>
        <div style={{ paddingTop: 12, borderTop: `1px solid ${COLORS.ruleLight}` }}>
          <Field label="Educational Track / Stream" value={student.educational_track} />
          <Field label="Medical (conditions / allergies)" value={student.medical_notes} multiline />
          <Field label="Extracurricular Activities" value={student.extracurricular} multiline />
          <Field label="Notes" value={student.general_notes} multiline />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          {onEdit && <button onClick={onEdit} style={btn}>Edit details</button>}
          <button onClick={onClose} style={secondaryBtn}>Close</button>
        </div>
      </div>
    </div>
  )
}

// Finance/Bursar edit form: only contact, medical, activities and notes.
// Name, admission number, class and educational track stay read-only here.
// Saves through the finance_update_student_details() database function.
function FinanceEditDetailsModal({ student, onClose, onSaved }) {
  const { notify } = useNotify()
  const [parentName, setParentName] = useState(student.parent_name ?? '')
  const [parentPhone, setParentPhone] = useState(student.parent_phone ?? '')
  const [medicalNotes, setMedicalNotes] = useState(student.medical_notes ?? '')
  const [extracurricular, setExtracurricular] = useState(student.extracurricular ?? '')
  const [generalNotes, setGeneralNotes] = useState(student.general_notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const area = { ...input, minHeight: 70, fontFamily: 'inherit', resize: 'vertical' }

  async function handleSave() {
    setSaving(true)
    setError('')
    const updates = {
      parent_name: parentName.trim() || null,
      parent_phone: parentPhone.trim() || null,
      medical_notes: medicalNotes.trim() || null,
      extracurricular: extracurricular.trim() || null,
      general_notes: generalNotes.trim() || null,
    }
    const { error: rpcError } = await supabase.rpc('finance_update_student_details', {
      p_student_id: student.id,
      p_parent_name: updates.parent_name,
      p_parent_phone: updates.parent_phone,
      p_medical_notes: updates.medical_notes,
      p_extracurricular: updates.extracurricular,
      p_general_notes: updates.general_notes,
    })
    setSaving(false)
    if (rpcError) { setError(rpcError.message); return }
    notify('Student details updated.')
    onSaved({ ...student, ...updates })
  }

  return (
    <div style={modalOverlay}>
      <div style={{ ...modalCard, maxWidth: 'min(520px, 94vw)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3>Edit — {student.full_name}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <p style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14 }}>{student.admission_no}</p>
        <label style={fieldLabel}>Parent / Guardian
          <input value={parentName} onChange={(e) => setParentName(e.target.value)} style={input} />
        </label>
        <label style={fieldLabel}>Parent Phone
          <input value={parentPhone} onChange={(e) => setParentPhone(e.target.value)} style={input} />
        </label>
        <label style={fieldLabel}>Medical (conditions / allergies)
          <textarea value={medicalNotes} onChange={(e) => setMedicalNotes(e.target.value)} style={area} />
        </label>
        <label style={fieldLabel}>Extracurricular Activities
          <textarea value={extracurricular} onChange={(e) => setExtracurricular(e.target.value)} style={area} />
        </label>
        <label style={fieldLabel}>Notes
          <textarea value={generalNotes} onChange={(e) => setGeneralNotes(e.target.value)} style={area} />
        </label>
        {error && <p style={errorText}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={btn}>{saving ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// STUDENT PERFORMANCE — admin view of one student's educational performance
// across exams: overall average trend plus a per-subject trend, both as
// graphs, reusing buildProgressGraphSvg.
// ============================================================================
function StudentPerformanceModal({ student, onClose }) {
  const { scale: gradeScale } = useGradeScale()
  const { scale: cbcScale } = useCbcScale()
  const [exams, setExams] = useState([])
  const [subjects, setSubjects] = useState([]) // [{id, name}]
  const [marksIndex, setMarksIndex] = useState({}) // `${examId}:${subjectId}` -> score
  const [selectedSubjectId, setSelectedSubjectId] = useState('overall')
  const [loading, setLoading] = useState(true)
  const isCbc = student.cohort === 'grade_10'
  const scale = isCbc ? cbcScale : gradeScale
  const gradeLabelFor = (score) => (score === null || score === undefined ? null : (isCbc ? cbcLevel(score, scale) : kcseGrade(score, scale)))

  useEffect(() => { loadPerformance() }, [student.id])

  async function loadPerformance() {
    setLoading(true)
    const [{ data: examData }, { data: subjectRows }] = await Promise.all([
      supabase.from('exams').select('*').order('order_index', { ascending: true }),
      supabase.from('student_subjects').select('subject_id, subjects(name)').eq('student_id', student.id),
    ])
    const subjectList = (subjectRows || [])
      .filter((r) => r.subjects?.name)
      .map((r) => ({ id: r.subject_id, name: r.subjects.name }))
    setExams(examData || [])
    setSubjects(subjectList)
    const subjectIds = subjectList.map((s) => s.id)
    const { data: marksData } = subjectIds.length > 0
      ? await supabase.from('marks').select('score, exam_id, subject_id').eq('student_id', student.id).in('subject_id', subjectIds)
      : { data: [] }
    const index = {}
    ;(marksData || []).forEach((m) => { index[`${m.exam_id}:${m.subject_id}`] = m.score })
    setMarksIndex(index)
    setLoading(false)
  }

  const overallTimeline = exams.map((e) => {
    const scores = subjects.map((s) => marksIndex[`${e.id}:${s.id}`]).filter((v) => v !== undefined && v !== null)
    return { label: e.name, value: scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null }
  }).filter((t) => t.value !== null)

  const subjectTimeline = selectedSubjectId === 'overall' ? overallTimeline : exams.map((e) => ({
    label: e.name,
    value: marksIndex[`${e.id}:${selectedSubjectId}`],
  })).filter((t) => t.value !== undefined && t.value !== null)

  const latestExam = exams.length > 0 ? exams[exams.length - 1] : null
  const latestSubjectRows = latestExam ? subjects.map((s) => ({
    ...s,
    score: marksIndex[`${latestExam.id}:${s.id}`],
  })).filter((r) => r.score !== undefined && r.score !== null) : []

  return (
    <div style={modalOverlay}>
      <div style={{ ...modalCard, maxWidth: 'min(600px, 94vw)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3>{student.full_name} — Performance</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <p style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14 }}>{student.admission_no} · {student.cohort}{student.pathway ? ` · ${student.pathway}` : ''}</p>

        {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={sectionLabel}>Progress</div>
              <select value={selectedSubjectId} onChange={(e) => setSelectedSubjectId(e.target.value)} style={{ ...input, maxWidth: 200 }}>
                <option value="overall">Overall Average</option>
                {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            {subjectTimeline.length === 0 ? (
              <p style={{ fontSize: 12.5, color: COLORS.muted, marginBottom: 16 }}>No marks recorded yet.</p>
            ) : (
              <div style={{ marginBottom: 16 }} dangerouslySetInnerHTML={{ __html: buildProgressGraphSvg(subjectTimeline) }} />
            )}

            <div style={{ paddingTop: 12, borderTop: `1px solid ${COLORS.ruleLight}` }}>
              <div style={sectionLabel}>{latestExam ? `${latestExam.name} — By Subject` : 'By Subject'}</div>
              {latestSubjectRows.length === 0 ? (
                <p style={{ fontSize: 12.5, color: COLORS.muted }}>No marks recorded for the most recent exam.</p>
              ) : (
                <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                    <thead><tr><th style={th}>Subject</th><th style={{ ...th, textAlign: 'center' }}>Score</th><th style={{ ...th, textAlign: 'center' }}>Grade</th></tr></thead>
                    <tbody>
                      {latestSubjectRows.map((r) => (
                        <tr key={r.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                          <td style={td}>{r.name}</td>
                          <td style={{ ...td, textAlign: 'center' }}>{r.score}</td>
                          <td style={{ ...td, textAlign: 'center', fontWeight: 700 }}>{gradeLabelFor(r.score)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={onClose} style={secondaryBtn}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// STUDENTS SCREEN
// (Bulk Class Enrollment screen removed — enrollment is handled per-student
// via Edit Student now.)
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
  const [viewingStudent, setViewingStudent] = useState(null)
  const [analysingStudent, setAnalysingStudent] = useState(null)
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
    let query = supabase.from('students').select('*').is('graduated_at', null).order('created_at', { ascending: false })
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
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8, cursor: 'pointer', color: COLORS.accent }} onClick={() => setAnalysingStudent(s)}>{s.full_name}</div>
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
                <button onClick={() => setViewingStudent(s)} style={{ fontSize: 12.5, color: COLORS.ink, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}>Details</button>
                <button onClick={() => setAnalysingStudent(s)} style={{ fontSize: 12.5, color: COLORS.ink, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}>Performance</button>
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
                  <td style={{ ...td, cursor: 'pointer', color: COLORS.accent, fontWeight: 600 }} onClick={() => setAnalysingStudent(s)}>{s.full_name}</td>
                  <td style={{ ...td, color: COLORS.muted }}>{s.admission_no}</td>
                  <td style={td}>{s.cohort}{s.pathway ? ` · ${s.pathway}` : ''}</td>
                  <td style={{ ...td, maxWidth: 260 }}><SubjectTags studentId={s.id} /></td>
                  <td style={{ ...td, color: COLORS.muted }}>{s.entrance_type ? `${s.entrance_score}/${s.entrance_max}` : '—'}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                      <button onClick={() => setViewingStudent(s)} style={{ fontSize: 12, color: COLORS.ink, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Details</button>
                      <button onClick={() => setAnalysingStudent(s)} style={{ fontSize: 12, color: COLORS.ink, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Performance</button>
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
      {viewingStudent && <StudentDetailsModal student={viewingStudent} onClose={() => setViewingStudent(null)} />}
      {analysingStudent && <StudentPerformanceModal student={analysingStudent} onClose={() => setAnalysingStudent(null)} />}
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
    const { data: studentData } = await supabase.from('students').select('id, full_name, admission_no').eq('cohort', cohort).is('graduated_at', null).order('full_name')
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

// Official KNEC KCSE subject codes. Matched against a subject's name using
// a normalized (lowercased, non-alpha-stripped) comparison, with common
// aliases (e.g. "CRE" / "Christian Religious Education") mapped to the same
// code. Only used on Form 3/4 (KCSE) report cards — Grade 10 (CBC) reports
// don't use KNEC codes. Add more aliases here as needed.
const KCSE_SUBJECT_CODES = {
  english: '101', kiswahili: '102', mathematics: '121', maths: '121',
  biology: '231', physics: '232', chemistry: '233',
  historyandgovernment: '311', history: '311',
  geography: '312',
  christianreligiouseducation: '313', cre: '313',
  islamicreligiouseducation: '314', ire: '314',
  hindureligiouseducation: '315', hre: '315',
  homescience: '441',
  artanddesign: '442', art: '442',
  agriculture: '443',
  computerstudies: '451',
  french: '501', german: '502', arabic: '503', music: '504',
  businessstudies: '505',
  buildingconstruction: '565', powermechanics: '566',
  metalwork: '567', woodwork: '568', electricity: '569',
  drawinganddesign: '570',
}

function getKcseSubjectCode(subjectName) {
  const key = (subjectName || '').toLowerCase().replace(/[^a-z]/g, '')
  return KCSE_SUBJECT_CODES[key] || '—'
}

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
      .from('students').select('*').eq('cohort', assignment.class_label).is('graduated_at', null).order('full_name')
    const classStudentIds = (classStudents || []).map((s) => s.id)
    const { data: allEnrollmentRows } = await supabase
      .from('student_subjects').select('student_id, subject_id').in('student_id', classStudentIds)
    const enrolledForSubject = new Set(
      (allEnrollmentRows || []).filter((r) => r.subject_id === assignment.subject_id).map((r) => r.student_id)
    )
    // Compulsory subjects: every student in the class takes them, so show
    // the whole class regardless of what's (or isn't) in student_subjects —
    // that table only needs to track electives, and relying on "does this
    // student have ANY enrollment row at all" as a signal breaks the moment
    // enrollment gets bulk-populated for other subjects too, silently
    // hiding every compulsory-subject class for every teacher at once.
    // Electives — the ONE_OF_GROUP subjects and either side of an
    // EXCLUSION_PAIRS pair, e.g. Geography/History — must stay strictly
    // filtered to actual enrolledForSubject matches, since an elective
    // teacher should never see a student who doesn't take their subject.
    const subjectName = assignment.subjects?.name
    const isElectiveSubject =
      ONE_OF_GROUP.includes(subjectName) ||
      EXCLUSION_PAIRS.some((pair) => pair.includes(subjectName)) ||
      GRADE10_ELECTIVE_MENU.includes(subjectName)
    const studentData = (classStudents || []).filter(
      (s) => isElectiveSubject ? enrolledForSubject.has(s.id) : true
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
// ============================================================================
// TEACHER/ADMIN: Analysis — class-wide and individual-student performance
// breakdown for a teacher's own subject+class assignment: average trend
// across exams, grade distribution, top/bottom performers, and a per-student
// progress line.
// ============================================================================
function AnalysisScreen({ teacherId, adminMode = false, manualAssignment = null }) {
  const { scale: gradeScale } = useGradeScale()
  const { scale: cbcScale } = useCbcScale()
  const [assignments, setAssignments] = useState([])
  const [selectedAssignment, setSelectedAssignment] = useState('')
  const [exams, setExams] = useState([])
  const [selectedExamId, setSelectedExamId] = useState('')
  const [students, setStudents] = useState([])
  const [marksIndex, setMarksIndex] = useState({}) // `${examId}:${studentId}` -> score
  const [selectedStudentId, setSelectedStudentId] = useState('')
  const [loading, setLoading] = useState(true)

  function currentAssignment() {
    if (adminMode) return manualAssignment
    return assignments.find((a) => a.id === selectedAssignment) || null
  }

  useEffect(() => { loadAssignmentsAndExams() }, [teacherId, adminMode])
  useEffect(() => {
    const ready = adminMode ? manualAssignment : selectedAssignment
    if (ready) loadAnalysis()
  }, [selectedAssignment, adminMode, manualAssignment])

  async function loadAssignmentsAndExams() {
    setLoading(true)
    const { data: examData } = await supabase.from('exams').select('*').order('order_index', { ascending: true })
    setExams(examData || [])
    if (!adminMode) {
      const { data: assignData } = await supabase
        .from('teacher_assignments').select('*, subjects(name)').eq('teacher_id', teacherId).eq('status', 'approved')
      setAssignments(assignData || [])
      if (assignData && assignData.length > 0) setSelectedAssignment(assignData[0].id)
    }
    setLoading(false)
  }

  async function loadAnalysis() {
    setLoading(true)
    const assignment = currentAssignment()
    if (!assignment) { setStudents([]); setMarksIndex({}); setLoading(false); return }
    const { data: classStudents } = await supabase
      .from('students').select('*').eq('cohort', assignment.class_label).is('graduated_at', null).order('full_name')
    const classStudentIds = (classStudents || []).map((s) => s.id)
    const { data: allEnrollmentRows } = await supabase
      .from('student_subjects').select('student_id, subject_id').in('student_id', classStudentIds)
    const enrolledForSubject = new Set(
      (allEnrollmentRows || []).filter((r) => r.subject_id === assignment.subject_id).map((r) => r.student_id)
    )
    const subjectName = assignment.subjects?.name
    const isElectiveSubject =
      ONE_OF_GROUP.includes(subjectName) ||
      EXCLUSION_PAIRS.some((pair) => pair.includes(subjectName)) ||
      GRADE10_ELECTIVE_MENU.includes(subjectName)
    const eligibleStudents = (classStudents || []).filter((s) => (isElectiveSubject ? enrolledForSubject.has(s.id) : true))
    const examIds = exams.map((e) => e.id)
    const { data: marksData } = examIds.length > 0
      ? await supabase.from('marks').select('*').eq('subject_id', assignment.subject_id).in('exam_id', examIds)
      : { data: [] }
    const index = {}
    ;(marksData || []).forEach((m) => { index[`${m.exam_id}:${m.student_id}`] = m.score })
    setStudents(eligibleStudents)
    setMarksIndex(index)
    if (eligibleStudents.length > 0) {
      setSelectedStudentId((prev) => (eligibleStudents.some((s) => s.id === prev) ? prev : eligibleStudents[0].id))
    } else {
      setSelectedStudentId('')
    }
    setLoading(false)
  }

  const assignment = currentAssignment()
  const isCbc = assignment?.class_label === 'grade_10'
  const scale = isCbc ? cbcScale : gradeScale
  const gradeLabelFor = (score) => (score === null || score === undefined ? null : (isCbc ? cbcLevel(score, scale) : kcseGrade(score, scale)))

  const maxScalePoints = Math.max(...scale.map((r) => r.points))
  const classAvgTimeline = exams.map((e) => {
    const scores = students.map((s) => marksIndex[`${e.id}:${s.id}`]).filter((v) => v !== undefined && v !== null)
    const mp = meanPoints(scores, scale, isCbc)
    return { label: e.name, value: mp !== null ? Math.round(mp * 100) / 100 : null, grade: mp !== null ? gradeForMeanPoints(mp, scale) : null }
  }).filter((t) => t.value !== null)

  // Default the exam selector to the most recent exam that actually has marks
  useEffect(() => {
    if (!selectedExamId && exams.length > 0) {
      const withData = [...exams].reverse().find((e) => students.some((s) => marksIndex[`${e.id}:${s.id}`] !== undefined))
      setSelectedExamId((withData || exams[exams.length - 1])?.id || '')
    }
  }, [exams, students, marksIndex])

  const examScores = students
    .map((s) => ({ student: s, score: marksIndex[`${selectedExamId}:${s.id}`] }))
    .filter((r) => r.score !== undefined && r.score !== null)

  const gradeDistribution = scale.map((band) => ({
    label: band.label,
    count: examScores.filter((r) => gradeLabelFor(r.score) === band.label).length,
  })).filter((b) => b.count > 0)
  const maxGradeCount = Math.max(1, ...gradeDistribution.map((b) => b.count))

  const ranked = [...examScores].sort((a, b) => b.score - a.score)
  const topPerformers = ranked.slice(0, 5)
  const bottomPerformers = ranked.slice(-5).reverse()

  const studentTimeline = exams.map((e) => ({
    label: e.name,
    value: marksIndex[`${e.id}:${selectedStudentId}`],
  })).filter((t) => t.value !== undefined && t.value !== null)

  return (
    <div style={pageWrap}>
      <h2>Analysis</h2>
      {!adminMode && (
        <label style={{ ...fieldLabel, maxWidth: 320, marginBottom: 18 }}>Subject / Class
          <select value={selectedAssignment} onChange={(e) => setSelectedAssignment(e.target.value)} style={input}>
            {assignments.length === 0 && <option value="">No approved assignments yet</option>}
            {assignments.map((a) => (
              <option key={a.id} value={a.id}>{a.subjects?.name} — {a.class_label}</option>
            ))}
          </select>
        </label>
      )}

      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : !assignment ? (
        <div style={{ textAlign: 'center', color: COLORS.muted, padding: 24, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
          No approved subject/class assignment selected yet.
        </div>
      ) : (
        <>
          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={sectionLabel}>Class Mean Trend</div>
              {classAvgTimeline.length > 0 && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 11, color: COLORS.muted, fontWeight: 700, textTransform: 'uppercase' }}>Latest Mean</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: COLORS.accent }}>
                    {classAvgTimeline[classAvgTimeline.length - 1].grade} ({classAvgTimeline[classAvgTimeline.length - 1].value})
                  </div>
                </div>
              )}
            </div>
            {classAvgTimeline.length === 0 ? (
              <p style={{ fontSize: 12.5, color: COLORS.muted }}>No marks recorded yet for this class/subject.</p>
            ) : (
              <div dangerouslySetInnerHTML={{ __html: buildProgressGraphSvg(classAvgTimeline, maxScalePoints) }} />
            )}
          </div>

          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <div style={sectionLabel}>Grade Distribution</div>
              <select value={selectedExamId} onChange={(e) => setSelectedExamId(e.target.value)} style={{ ...input, maxWidth: 200 }}>
                {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            {gradeDistribution.length === 0 ? (
              <p style={{ fontSize: 12.5, color: COLORS.muted }}>No marks recorded for this exam.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {gradeDistribution.map((b) => (
                  <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, width: 36, flexShrink: 0, fontWeight: 700 }}>{b.label}</span>
                    <div style={{ flex: 1, background: COLORS.ruleLight, borderRadius: 4, overflow: 'hidden', height: 14 }}>
                      <div style={{ width: `${(b.count / maxGradeCount) * 100}%`, background: COLORS.accent, height: '100%' }} />
                    </div>
                    <span style={{ fontSize: 12, color: COLORS.muted, width: 20, textAlign: 'right', flexShrink: 0 }}>{b.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 16 }}>
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16 }}>
              <div style={sectionLabel}>Top Performers</div>
              {topPerformers.length === 0 ? <p style={{ fontSize: 12.5, color: COLORS.muted }}>No marks yet.</p> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {topPerformers.map((r, i) => (
                    <div key={r.student.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span>{i + 1}. {r.student.full_name}</span>
                      <span style={{ fontWeight: 700 }}>{r.score}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16 }}>
              <div style={sectionLabel}>Needs Attention</div>
              {bottomPerformers.length === 0 ? <p style={{ fontSize: 12.5, color: COLORS.muted }}>No marks yet.</p> : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {bottomPerformers.map((r, i) => (
                    <div key={r.student.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span>{r.student.full_name}</span>
                      <span style={{ fontWeight: 700, color: COLORS.warn }}>{r.score}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <div style={sectionLabel}>Individual Student Progress</div>
              <select value={selectedStudentId} onChange={(e) => setSelectedStudentId(e.target.value)} style={{ ...input, maxWidth: 220 }}>
                {students.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
              </select>
            </div>
            {studentTimeline.length === 0 ? (
              <p style={{ fontSize: 12.5, color: COLORS.muted }}>No marks recorded yet for this student.</p>
            ) : (
              <div dangerouslySetInnerHTML={{ __html: buildProgressGraphSvg(studentTimeline) }} />
            )}
          </div>
        </>
      )}
    </div>
  )
}

function MarksEntryScreen({ teacherId, teacherName, onLogout }) {
  const [showChangePw, setShowChangePw] = useState(false)
  const [view, setView] = useState('marks') // 'marks' | 'attendance' | 'timetable'
  const { logoUrl } = useSchoolSettings()
  return (
    <div style={{ background: COLORS.paper, minHeight: '100vh' }}>
      <div style={{ background: COLORS.band, color: COLORS.bandText, padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={logoUrl} alt="Crest" style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0 }} />
          <div style={{ fontWeight: 700 }}>Paul Wanjigi Alpine — Records</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 12 }}>{teacherName}</span>
          <button onClick={() => setShowChangePw(true)} style={{ ...secondaryBtn, background: 'transparent', color: COLORS.bandText, borderColor: 'rgba(255,255,255,0.3)', fontSize: 12 }}>Change Password</button>
          <button onClick={onLogout} style={{ ...secondaryBtn, background: 'transparent', color: COLORS.bandText, borderColor: 'rgba(255,255,255,0.3)' }}>Log out</button>
        </div>
      </div>
      <div style={pageWrap}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          <button onClick={() => setView('marks')} style={view === 'marks' ? btn : secondaryBtn}>Marks Entry</button>
          <button onClick={() => setView('analysis')} style={view === 'analysis' ? btn : secondaryBtn}>Analysis</button>
          <button onClick={() => setView('quizzes')} style={view === 'quizzes' ? btn : secondaryBtn}>Quizzes</button>
          <button onClick={() => setView('attendance')} style={view === 'attendance' ? btn : secondaryBtn}>Attendance</button>
          <button onClick={() => setView('timetable')} style={view === 'timetable' ? btn : secondaryBtn}>My Timetable</button>
        </div>
        {view === 'marks' && <MarksEntryContent teacherId={teacherId} />}
        {view === 'analysis' && <AnalysisScreen teacherId={teacherId} />}
        {view === 'quizzes' && <QuizzesScreen teacherId={teacherId} />}
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
  const [view, setView] = useState('marks')
  return (
    <div style={pageWrap}>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 12 }}>
        If you also teach a subject, assign it here and enter marks the same way any teacher would.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button onClick={() => setView('marks')} style={view === 'marks' ? btn : secondaryBtn}>Marks Entry</button>
        <button onClick={() => setView('analysis')} style={view === 'analysis' ? btn : secondaryBtn}>Analysis</button>
        <button onClick={() => setView('quizzes')} style={view === 'quizzes' ? btn : secondaryBtn}>Quizzes</button>
      </div>
      {view === 'marks' && <MarksEntryContent teacherId={profile.id} />}
      {view === 'analysis' && <AnalysisScreen teacherId={profile.id} />}
      {view === 'quizzes' && <QuizzesScreen teacherId={profile.id} />}
    </div>
  )
}

// ============================================================================
// FINANCE (Bursar/Accounts): shared student picker used by Fees & Pocket Money
// ============================================================================
function FinanceStudentPicker({ selectedStudent, onSelect }) {
  const [query, setQuery] = useState('')
  const [cohortFilter, setCohortFilter] = useState('all')
  const [students, setStudents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('students').select('id, full_name, admission_no, cohort, parent_name').order('full_name')
      .then(({ data }) => { setStudents(data || []); setLoading(false) })
  }, [])

  const filtered = students.filter((s) => {
    if (cohortFilter !== 'all' && s.cohort !== cohortFilter) return false
    if (!query.trim()) return true
    const q = query.trim().toLowerCase()
    return s.full_name?.toLowerCase().includes(q) || s.admission_no?.toLowerCase().includes(q)
  })

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <select value={cohortFilter} onChange={(e) => setCohortFilter(e.target.value)} style={{ ...input, width: 150, marginBottom: 0 }}>
          <option value="all">All Classes</option>
          {CLASS_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <input
          placeholder="Search student by name or admission no…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ ...input, maxWidth: 340, marginBottom: 0, flex: 1, minWidth: 200 }}
        />
      </div>
      {loading ? <p style={{ color: COLORS.muted, fontSize: 13 }}>Loading students...</p> : (
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, maxHeight: 220, overflow: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: 14, fontSize: 13, color: COLORS.muted }}>No matching students.</div>
          ) : filtered.map((s) => (
            <div
              key={s.id}
              onClick={() => onSelect(s)}
              style={{
                padding: '10px 14px', fontSize: 13, cursor: 'pointer', borderTop: `1px solid ${COLORS.ruleLight}`,
                background: selectedStudent?.id === s.id ? COLORS.accentSoft : 'transparent',
              }}
            >
              <strong>{s.full_name}</strong>
              <span style={{ color: COLORS.muted, marginLeft: 8 }}>{s.admission_no} · {CLASS_OPTIONS.find((c) => c.value === s.cohort)?.label || s.cohort}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// FINANCE: School Fees — itemized invoices per term + a payment ledger,
// with a running balance per student
// ============================================================================
// ============================================================================
// FINANCE: on-demand receipt generation — either the built-in designed
// receipt, or (if the school has uploaded one in Settings) their own receipt
// design used as the page background with the payment details overlaid.
// ============================================================================
function buildReceiptCellHtml({ payment, student, invoices, payments, meta, size = 'compact' }) {
  const totalInvoiced = invoices.reduce((sum, i) => sum + Number(i.amount || 0), 0)
  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0)
  const balance = totalInvoiced - totalPaid
  const paidDate = new Date(payment.paid_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

  // 'compact' is sized for a quarter of an A4 sheet (4-up printing / class
  // batches); 'large' is sized for a single receipt filling most of a page.
  const s = size === 'large'
    ? {
        cardPadding: '30px 34px', logoSize: 64, headerPad: '14px', headerMb: '20px', headerBorder: '3px',
        nameFontSize: '22px', addressFontSize: '13px', titleFontSize: '17px', titleMb: '20px',
        detailsPadding: '20px 24px', detailsFontSize: '15px', detailsLineHeight: '2.05',
        footerFontSize: '13px', footerMt: '26px', footerRowMb: '22px', watermarkWidth: '55%',
        cardRadius: '20px', detailsRadius: '12px',
      }
    : {
        cardPadding: '12px 14px', logoSize: 30, headerPad: '6px', headerMb: '8px', headerBorder: '2px',
        nameFontSize: '11.5px', addressFontSize: '8px', titleFontSize: '10.5px', titleMb: '8px',
        detailsPadding: '8px 10px', detailsFontSize: '10px', detailsLineHeight: '1.65',
        footerFontSize: '8px', footerMt: '10px', footerRowMb: '12px', watermarkWidth: '70%',
        cardRadius: '12px', detailsRadius: '8px',
      }

  const detailsBlock = `
    <div style="font-size:${s.detailsFontSize};line-height:${s.detailsLineHeight};">
      <div><strong>Receipt No:</strong> ${payment.id.slice(0, 8).toUpperCase()}</div>
      <div><strong>Date:</strong> ${paidDate}</div>
      <div><strong>Parent/Guardian:</strong> ${student.parent_name || '—'}</div>
      <div><strong>Student:</strong> ${student.full_name} (${student.admission_no})</div>
      <div><strong>Amount:</strong> KES ${Number(payment.amount).toLocaleString()}</div>
      <div><strong>Method:</strong> ${payment.method}${payment.reference_no ? ` — Ref: ${payment.reference_no}` : ''}</div>
      ${payment.note ? `<div><strong>Note:</strong> ${payment.note}</div>` : ''}
      <div><strong>Balance:</strong> KES ${balance.toLocaleString()}</div>
    </div>
  `

  if (meta.receiptTemplateUrl) {
    // Custom uploaded design used as the cell background; details overlaid
    // in a readable box near the bottom.
    return `
      <div style="position:relative;width:100%;height:100%;overflow:hidden;border-radius:10px;">
        <img src="${meta.receiptTemplateUrl}" style="width:100%;height:100%;object-fit:cover;display:block;" crossorigin="anonymous" />
        <div style="position:absolute;left:8px;right:8px;bottom:8px;background:rgba(255,255,255,0.95);border-radius:6px;padding:${s.detailsPadding};font-family:sans-serif;color:#1E2A24;">
          ${detailsBlock}
          <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:${s.footerFontSize};color:#6B6558;">
            <div>_______________<br/>School Manager</div>
            <div>_______________<br/>Principal</div>
          </div>
        </div>
      </div>
    `
  }

  const receiptWatermarkEnabled = meta.receiptWatermarkEnabled !== false
  const receiptWatermarkOpacity = meta.receiptWatermarkOpacity ?? DEFAULT_RECEIPT_WATERMARK_OPACITY
  const receiptWatermarkOffsetX = meta.receiptWatermarkOffsetX ?? 0
  const receiptWatermarkOffsetY = meta.receiptWatermarkOffsetY ?? 0
  const watermarkImg = receiptWatermarkEnabled
    ? `<img src="${meta.logoUrl}" crossorigin="anonymous" style="position:absolute;top:calc(50% + ${receiptWatermarkOffsetY}px);left:calc(50% + ${receiptWatermarkOffsetX}px);width:${s.watermarkWidth};transform:translate(-50%,-50%);opacity:${receiptWatermarkOpacity};filter:grayscale(1);pointer-events:none;z-index:0;" />`
    : ''

  return `
    <div style="position:relative;width:100%;height:100%;font-family:sans-serif;color:#1E2A24;border-radius:${s.cardRadius};border:1px solid #E4DFD1;overflow:hidden;background:#FFFFFF;box-sizing:border-box;">
      ${watermarkImg}
      <div style="position:relative;z-index:1;padding:${s.cardPadding};height:100%;box-sizing:border-box;display:flex;flex-direction:column;">
        <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:${s.headerBorder} solid #2C3E37;padding-bottom:${s.headerPad};margin-bottom:${s.headerMb};">
          <img src="${meta.logoUrl}" crossorigin="anonymous" style="width:${s.logoSize}px;height:${s.logoSize}px;border-radius:50%;object-fit:cover;flex-shrink:0;" />
          <div style="flex:1;text-align:center;padding:0 6px;">
            <div style="font-size:${s.nameFontSize};font-weight:800;color:#2C3E37;line-height:1.15;">Paul Wanjigi Alpine High School</div>
            <div style="font-size:${s.addressFontSize};color:#6B6558;">P.O. BOX 1801-20117 NAIVASHA</div>
          </div>
          <img src="${meta.secondaryLogoUrl}" crossorigin="anonymous" style="width:${s.logoSize}px;height:${s.logoSize}px;border-radius:50%;object-fit:cover;flex-shrink:0;" />
        </div>
        <div style="text-align:center;font-size:${s.titleFontSize};font-weight:700;letter-spacing:0.6px;color:#2C3E37;margin-bottom:${s.titleMb};">OFFICIAL RECEIPT</div>
        <div style="background:rgba(247,245,239,0.88);border:1px solid #E4DFD1;border-radius:${s.detailsRadius};padding:${s.detailsPadding};flex:1;">
          ${detailsBlock}
        </div>
        <div style="margin-top:${s.footerMt};font-size:${s.footerFontSize};color:#6B6558;">
          <div style="display:flex;justify-content:space-between;margin-bottom:${s.footerRowMb};">
            <div>_______________<br/>Received By</div>
            <div>_______________<br/>Stamp</div>
          </div>
          <div style="display:flex;justify-content:space-between;">
            <div>_______________<br/>School Manager</div>
            <div>_______________<br/>Principal</div>
          </div>
        </div>
      </div>
    </div>
  `
}

// Tiles up to 4 receipt cells on one A4 sheet (2x2, with dashed cut-guides).
// `cells` is an array of up to 4 cellHtml strings — pass the SAME cellHtml
// 4 times to get 4 copies of one receipt (matches the duplicate/triplicate
// paper receipt books schools already use), or 4 DIFFERENT students' cellHtml
// to fit 4 different people's receipts on one printed sheet (used for
// whole-class batches, so you're not burning a full sheet per student).
// Fewer than 4 cells leaves the remaining slots blank.
function buildReceiptSheetHtml(cells) {
  const cellStyle = 'position:relative;'
  const slots = [cells[0] || '', cells[1] || '', cells[2] || '', cells[3] || '']
  const paddings = [
    'padding:14px 10px 10px 14px;border-right:1px dashed #C9C2AE;border-bottom:1px dashed #C9C2AE;',
    'padding:14px 14px 10px 10px;border-bottom:1px dashed #C9C2AE;',
    'padding:10px 10px 14px 14px;border-right:1px dashed #C9C2AE;',
    'padding:10px 14px 14px 10px;',
  ]
  return `
    <div style="width:780px;height:1100px;box-sizing:border-box;background:#fff;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;">
      ${slots.map((cellHtml, i) => `<div style="${cellStyle}${paddings[i]}">${cellHtml}</div>`).join('')}
    </div>
  `
}

// Backward-compatible helper: same receipt 4-up (kept for reference / class sheets).
function buildReceiptPageHtml(cellHtml) {
  return buildReceiptSheetHtml([cellHtml, cellHtml, cellHtml, cellHtml])
}

// Single-receipt download: one receipt, centered and enlarged (at its
// original proportions) to fill the page — not the 4-up sheet used for
// class-wide printing. Pass a cellHtml built with size:'large'.
function buildSingleReceiptPageHtml(cellHtml) {
  return `
    <div style="width:780px;height:1100px;box-sizing:border-box;background:#fff;display:flex;align-items:center;justify-content:center;">
      <div style="width:600px;height:840px;">${cellHtml}</div>
    </div>
  `
}

// Renders one or more full-page sheet HTML strings into a single multi-page PDF.
async function receiptSheetsToPdfBlob(pageHtmls) {
  const pdf = new jsPDF('p', 'mm', 'a4')
  for (let i = 0; i < pageHtmls.length; i++) {
    const container = document.createElement('div')
    container.style.position = 'fixed'
    container.style.left = '-9999px'
    container.style.top = '0'
    container.style.width = '780px'
    container.style.background = '#fff'
    container.style.fontFamily = 'sans-serif'
    container.innerHTML = pageHtmls[i]
    document.body.appendChild(container)
    const canvas = await html2canvas(container, { scale: 2, backgroundColor: '#ffffff', windowWidth: 780, width: 780, useCORS: true })
    document.body.removeChild(container)
    const imgData = canvas.toDataURL('image/png')
    const pageWidth = pdf.internal.pageSize.getWidth()
    const pageHeight = pdf.internal.pageSize.getHeight()
    const imgHeight = Math.min((canvas.height * pageWidth) / canvas.width, pageHeight)
    if (i > 0) pdf.addPage()
    pdf.addImage(imgData, 'PNG', 0, 0, pageWidth, imgHeight)
  }
  return pdf.output('blob')
}

async function receiptToPdfBlob(pageHtml) {
  return receiptSheetsToPdfBlob([pageHtml])
}

async function downloadReceipt({ payment, student, invoices, payments, meta }) {
  const cellHtml = buildReceiptCellHtml({ payment, student, invoices, payments, meta, size: 'large' })
  const pageHtml = buildSingleReceiptPageHtml(cellHtml)
  const blob = await receiptToPdfBlob(pageHtml)
  const fileName = `Receipt_${student.admission_no}_${new Date(payment.paid_at).toISOString().slice(0, 10)}.pdf`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

function FeesScreen({ profile }) {
  const { notify } = useNotify()
  const { logoUrl, secondaryLogoUrl, receiptTemplateUrl, receiptWatermarkEnabled, receiptWatermarkOpacity, receiptWatermarkOffsetX, receiptWatermarkOffsetY } = useSchoolSettings()
  const [student, setStudent] = useState(null)
  const [invoices, setInvoices] = useState([])
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(false)
  const [receiptLoadingId, setReceiptLoadingId] = useState(null)
  const [previewReceipt, setPreviewReceipt] = useState(null) // { pageHtml, payment }
  const [downloadingReceipt, setDownloadingReceipt] = useState(false)

  const [invTerm, setInvTerm] = useState('Term 1')
  const [invYear, setInvYear] = useState(new Date().getFullYear())
  const [invAmount, setInvAmount] = useState('')
  const [savingInvoice, setSavingInvoice] = useState(false)

  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('Cash')
  const [payRef, setPayRef] = useState('')
  const [payNote, setPayNote] = useState('')
  const [savingPayment, setSavingPayment] = useState(false)
  const [paymentSearch, setPaymentSearch] = useState('')

  useEffect(() => { if (student) loadLedger() }, [student])

  async function loadLedger() {
    setLoading(true)
    const [{ data: invData }, { data: payData }] = await Promise.all([
      supabase.from('fee_invoices').select('*').eq('student_id', student.id).order('year', { ascending: false }).order('created_at', { ascending: false }),
      supabase.from('fee_payments').select('*').eq('student_id', student.id).order('paid_at', { ascending: false }),
    ])
    setInvoices(invData || [])
    setPayments(payData || [])
    setLoading(false)
  }

  // "General school fees" — one amount due per student per term, instead of
  // itemized line items. Internally this still uses fee_invoices (item_name
  // fixed to 'School Fees'), so the balance math below (totalInvoiced minus
  // totalPaid) keeps working unchanged. Setting the amount again for a term
  // that already has one updates it in place rather than adding a duplicate.
  async function setFeeAmount() {
    if (!invAmount) { notify('Enter the amount due.', 'error'); return }
    setSavingInvoice(true)
    const existing = invoices.find((i) => i.term === invTerm && i.year === Number(invYear) && i.item_name === 'School Fees')
    const { error } = existing
      ? await supabase.from('fee_invoices').update({ amount: Number(invAmount) }).eq('id', existing.id)
      : await supabase.from('fee_invoices').insert({
          student_id: student.id, term: invTerm, year: Number(invYear),
          item_name: 'School Fees', amount: Number(invAmount), created_by: profile.id,
        })
    setSavingInvoice(false)
    if (error) { notify(`Couldn't set fee amount: ${error.message}`, 'error'); return }
    setInvAmount('')
    notify(existing ? 'Fee amount updated.' : 'Fee amount set.')
    loadLedger()
  }

  async function deleteFeeAmount(id) {
    if (!window.confirm('Delete this fee amount? This cannot be undone.')) return
    // .select() after delete so we get back the rows that were actually
    // removed. Without it, a DELETE blocked by a missing/mismatched RLS
    // policy still returns success with zero rows affected — the UI would
    // say "deleted" while the entry silently stays in the database.
    const { data, error } = await supabase.from('fee_invoices').delete().eq('id', id).select()
    if (error) { notify(`Couldn't delete: ${error.message}`, 'error'); return }
    if (!data || data.length === 0) {
      notify("Delete didn't go through — likely a Supabase RLS policy is blocking DELETE on fee_invoices for this role. Add/check a DELETE policy for finance/admin.", 'error')
      return
    }
    notify('Fee amount deleted.')
    loadLedger()
  }

  async function addPayment() {
    if (!payAmount) { notify('Enter a payment amount.', 'error'); return }
    setSavingPayment(true)
    const { error } = await supabase.from('fee_payments').insert({
      student_id: student.id, amount: Number(payAmount), method: payMethod,
      reference_no: payRef.trim() || null, note: payNote.trim() || null, recorded_by: profile.id,
    })
    setSavingPayment(false)
    if (error) { notify(`Couldn't record payment: ${error.message}`, 'error'); return }
    setPayAmount(''); setPayRef(''); setPayNote('')
    notify('Payment recorded.')
    loadLedger()
  }

  function handlePreviewReceipt(payment) {
    setReceiptLoadingId(payment.id)
    try {
      const meta = { logoUrl, secondaryLogoUrl, receiptTemplateUrl, receiptWatermarkOpacity, receiptWatermarkOffsetX, receiptWatermarkOffsetY, receiptWatermarkEnabled }
      const cellHtml = buildReceiptCellHtml({ payment, student, invoices, payments, meta, size: 'large' })
      const pageHtml = buildSingleReceiptPageHtml(cellHtml)
      setPreviewReceipt({ pageHtml, payment })
    } catch (err) {
      notify(`Couldn't build receipt preview: ${err.message}`, 'error')
    }
    setReceiptLoadingId(null)
  }

  async function confirmDownloadReceipt() {
    if (!previewReceipt) return
    setDownloadingReceipt(true)
    try {
      const blob = await receiptToPdfBlob(previewReceipt.pageHtml)
      const fileName = `Receipt_${student.admission_no}_${new Date(previewReceipt.payment.paid_at).toISOString().slice(0, 10)}.pdf`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      URL.revokeObjectURL(url)
      setPreviewReceipt(null)
    } catch (err) {
      notify(`Couldn't generate receipt: ${err.message}`, 'error')
    }
    setDownloadingReceipt(false)
  }

  const totalInvoiced = invoices.reduce((sum, i) => sum + Number(i.amount || 0), 0)
  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0)
  const balance = totalInvoiced - totalPaid

  const filteredPayments = payments.filter((p) => {
    const q = paymentSearch.trim().toLowerCase()
    if (!q) return true
    return (
      p.method?.toLowerCase().includes(q) ||
      p.reference_no?.toLowerCase().includes(q) ||
      p.note?.toLowerCase().includes(q) ||
      String(p.amount).includes(q)
    )
  })

  return (
    <div style={{ ...pageWrap, maxWidth: 'none', width: '100%' }}>
      <h2>School Fees</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 16 }}>Search for a student to view or update their fee ledger.</p>
      <FinanceStudentPicker selectedStudent={student} onSelect={setStudent} />

      {student && (
        loading ? <p style={{ color: COLORS.muted }}>Loading ledger...</p> : (
          <>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
              <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: '10px 16px' }}>
                <div style={{ fontSize: 11, color: COLORS.muted }}>Total Invoiced</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{totalInvoiced.toLocaleString()}</div>
              </div>
              <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: '10px 16px' }}>
                <div style={{ fontSize: 11, color: COLORS.muted }}>Total Paid</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.good }}>{totalPaid.toLocaleString()}</div>
              </div>
              <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: '10px 16px' }}>
                <div style={{ fontSize: 11, color: COLORS.muted }}>Balance</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: balance > 0 ? COLORS.warn : COLORS.good }}>{balance.toLocaleString()}</div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20 }}>
              <div>
                <h3 style={{ fontSize: 15 }}>School Fees — Amount Due</h3>
                <p style={{ color: COLORS.muted, fontSize: 12, marginBottom: 10 }}>
                  Set the total amount this student owes for a term. Setting it again for the same term updates it — it doesn't add a duplicate.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                  <select value={invTerm} onChange={(e) => setInvTerm(e.target.value)} style={{ ...input, width: 100 }}>
                    <option>Term 1</option><option>Term 2</option><option>Term 3</option>
                  </select>
                  <input type="number" value={invYear} onChange={(e) => setInvYear(e.target.value)} style={{ ...input, width: 90 }} />
                  <input type="number" placeholder="Amount Due" value={invAmount} onChange={(e) => setInvAmount(e.target.value)} style={{ ...input, flex: 1, minWidth: 120 }} />
                  <button onClick={setFeeAmount} disabled={savingInvoice} style={btn}>{savingInvoice ? 'Saving...' : 'Set Amount'}</button>
                </div>
                <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                    <thead><tr><th style={th}>Term/Year</th><th style={{ ...th, textAlign: 'right' }}>Amount Due</th><th style={th}></th></tr></thead>
                    <tbody>
                      {invoices.map((i) => (
                        <tr key={i.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                          <td style={td}>{i.term} {i.year}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{Number(i.amount).toLocaleString()}</td>
                          <td style={td}>
                            <button onClick={() => deleteFeeAmount(i.id)} style={{ ...secondaryBtn, padding: '4px 10px', fontSize: 11.5, color: COLORS.warn, borderColor: COLORS.warn }}>Delete</button>
                          </td>
                        </tr>
                      ))}
                      {invoices.length === 0 && <tr><td colSpan={3} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 16 }}>No fee amount set yet.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <h3 style={{ fontSize: 15 }}>Payments</h3>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                  <input type="number" placeholder="Amount" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} style={{ ...input, width: 110 }} />
                  <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} style={{ ...input, width: 110 }}>
                    <option>Cash</option><option>M-Pesa</option><option>Bank</option><option>Cheque</option>
                  </select>
                  <input placeholder="Reference no. (optional)" value={payRef} onChange={(e) => setPayRef(e.target.value)} style={{ ...input, width: 140 }} />
                  <input placeholder="Note (optional)" value={payNote} onChange={(e) => setPayNote(e.target.value)} style={{ ...input, flex: 1, minWidth: 120 }} />
                  <button onClick={addPayment} disabled={savingPayment} style={btn}>{savingPayment ? 'Recording...' : 'Record'}</button>
                </div>
                <input
                  placeholder="Search payments by method, reference, note, or amount…"
                  value={paymentSearch}
                  onChange={(e) => setPaymentSearch(e.target.value)}
                  style={{ ...input, width: '100%', marginBottom: 10 }}
                />
                <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                    <thead><tr><th style={th}>Date</th><th style={th}>Method</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Note</th><th style={th}></th></tr></thead>
                    <tbody>
                      {filteredPayments.map((p) => (
                        <tr key={p.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                          <td style={td}>{new Date(p.paid_at).toLocaleDateString()}</td>
                          <td style={td}>{p.method}{p.reference_no ? ` (${p.reference_no})` : ''}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{Number(p.amount).toLocaleString()}</td>
                          <td style={{ ...td, color: COLORS.muted }}>{p.note || '—'}</td>
                          <td style={td}>
                            <button
                              onClick={() => handlePreviewReceipt(p)}
                              disabled={receiptLoadingId === p.id}
                              style={{ ...secondaryBtn, padding: '4px 10px', fontSize: 11.5 }}
                            >
                              {receiptLoadingId === p.id ? 'Building...' : 'Receipt'}
                            </button>
                          </td>
                        </tr>
                      ))}
                      {payments.length === 0 && <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 16 }}>No payments recorded yet.</td></tr>}
                      {payments.length > 0 && filteredPayments.length === 0 && <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 16 }}>No payments match your search.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </>
        )
      )}

      {previewReceipt && (() => {
        const previewScale = Math.min((window.innerWidth * 0.94) / 780, (window.innerHeight * 0.72) / 1100)
        return (
        <div style={{ ...modalOverlay, alignItems: 'stretch', justifyContent: 'stretch', padding: 0 }}>
          <div style={{ ...modalCard, width: '100vw', height: '100vh', maxWidth: 'none', maxHeight: 'none', margin: 0, borderRadius: 0, display: 'flex', flexDirection: 'column', padding: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: `1px solid ${COLORS.ruleLight}` }}>
              <h3 style={{ fontSize: 15, margin: 0 }}>Receipt Preview</h3>
              <button onClick={() => setPreviewReceipt(null)} style={{ ...secondaryBtn, padding: '4px 12px' }} disabled={downloadingReceipt}>✕ Close</button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center', padding: 16 }}>
              <div style={{ width: 780 * previewScale, height: 1100 * previewScale, flexShrink: 0 }}>
                <div style={{ width: 780, height: 1100, transform: `scale(${previewScale})`, transformOrigin: 'top left' }} dangerouslySetInnerHTML={{ __html: previewReceipt.pageHtml }} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '14px 18px', borderTop: `1px solid ${COLORS.ruleLight}` }}>
              <button onClick={() => setPreviewReceipt(null)} style={secondaryBtn} disabled={downloadingReceipt}>Cancel</button>
              <button onClick={confirmDownloadReceipt} style={btn} disabled={downloadingReceipt}>
                {downloadingReceipt ? 'Preparing PDF...' : '⬇ Download Receipt'}
              </button>
            </div>
          </div>
        </div>
        )
      })()}
    </div>
  )
}

// ============================================================================
// FINANCE: Class Receipts — batch-generate receipts for a whole class.
// Only students with a payment that hasn't been included in a receipt yet
// are eligible by default, so re-running this for a class that had no new
// payments since the last run produces nothing — new payments make a
// student eligible again. Always shows a preview before anything downloads.
// Different students' receipts are tiled 4-to-a-sheet (not 4 copies of the
// same one) so a class run doesn't burn a full sheet per student.
//
// Requires a `receipted_at timestamptz` column on `fee_payments`:
//   alter table fee_payments add column receipted_at timestamptz;
// ============================================================================
function ClassReceiptsScreen({ profile }) {
  const { notify } = useNotify()
  const { logoUrl, secondaryLogoUrl, receiptTemplateUrl, receiptWatermarkEnabled, receiptWatermarkOpacity, receiptWatermarkOffsetX, receiptWatermarkOffsetY } = useSchoolSettings()
  const [cohort, setCohort] = useState(CLASS_OPTIONS[0].value)
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState([]) // { student, invoices, payments, unreceiptedPayments, balance }
  const [selectedIds, setSelectedIds] = useState(new Set()) // payment ids selected for this run
  const [includeAllPaid, setIncludeAllPaid] = useState(false)
  const [previewSheets, setPreviewSheets] = useState(null)
  const [previewPaymentIds, setPreviewPaymentIds] = useState([])
  const [generating, setGenerating] = useState(false)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => { loadClass() }, [cohort])

  async function loadClass() {
    setLoading(true)
    setPreviewSheets(null)
    const { data: students } = await supabase.from('students').select('id, full_name, admission_no, cohort, parent_name').eq('cohort', cohort).order('full_name')
    const studentIds = (students || []).map((s) => s.id)
    const [{ data: allInvoices }, { data: allPayments }] = await Promise.all([
      studentIds.length ? supabase.from('fee_invoices').select('*').in('student_id', studentIds) : Promise.resolve({ data: [] }),
      studentIds.length ? supabase.from('fee_payments').select('*').in('student_id', studentIds) : Promise.resolve({ data: [] }),
    ])
    const built = (students || []).map((student) => {
      const invoices = (allInvoices || []).filter((i) => i.student_id === student.id)
      const payments = (allPayments || []).filter((p) => p.student_id === student.id)
      const unreceiptedPayments = payments.filter((p) => !p.receipted_at)
      const totalInvoiced = invoices.reduce((sum, i) => sum + Number(i.amount || 0), 0)
      const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0)
      return { student, invoices, payments, unreceiptedPayments, balance: totalInvoiced - totalPaid }
    })
    setRows(built)
    const defaultIds = new Set()
    built.forEach((r) => r.unreceiptedPayments.forEach((p) => defaultIds.add(p.id)))
    setSelectedIds(defaultIds)
    setLoading(false)
  }

  const eligibleRows = rows.filter((r) => (includeAllPaid ? r.payments.length > 0 : r.unreceiptedPayments.length > 0))

  function selectedPaymentsList() {
    const list = []
    rows.forEach((r) => {
      const pool = includeAllPaid ? r.payments : r.unreceiptedPayments
      pool.forEach((p) => { if (selectedIds.has(p.id)) list.push({ row: r, payment: p }) })
    })
    return list
  }

  async function generatePreview() {
    const list = selectedPaymentsList()
    if (list.length === 0) { notify('No students selected — nothing to generate.', 'error'); return }
    setGenerating(true)
    const meta = { logoUrl, secondaryLogoUrl, receiptTemplateUrl, receiptWatermarkEnabled, receiptWatermarkOpacity, receiptWatermarkOffsetX, receiptWatermarkOffsetY }
    const cells = list.map(({ row, payment }) =>
      buildReceiptCellHtml({ payment, student: row.student, invoices: row.invoices, payments: row.payments, meta })
    )
    const sheets = []
    for (let i = 0; i < cells.length; i += 4) sheets.push(buildReceiptSheetHtml(cells.slice(i, i + 4)))
    setPreviewSheets(sheets)
    setPreviewPaymentIds(list.map(({ payment }) => payment.id))
    setGenerating(false)
  }

  async function confirmDownload() {
    if (!previewSheets || previewSheets.length === 0) return
    setDownloading(true)
    try {
      const blob = await receiptSheetsToPdfBlob(previewSheets)
      const label = CLASS_OPTIONS.find((c) => c.value === cohort)?.label.replace(/\s+/g, '_') || cohort
      const fileName = `Receipts_${label}_${new Date().toISOString().slice(0, 10)}.pdf`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      URL.revokeObjectURL(url)
      const { error } = await supabase.from('fee_payments').update({ receipted_at: new Date().toISOString() }).in('id', previewPaymentIds)
      if (error) notify(`Downloaded, but couldn't mark payments as receipted: ${error.message}`, 'error')
      else notify(`Downloaded ${previewPaymentIds.length} receipt(s).`)
      setPreviewSheets(null)
      loadClass()
    } catch (err) {
      notify(`Couldn't generate PDF: ${err.message}`, 'error')
    }
    setDownloading(false)
  }

  return (
    <div style={{ ...pageWrap, maxWidth: 'none', width: '100%' }}>
      <h2>Class Receipts</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 16 }}>
        Batch-generate receipts for a class. Only students with a payment made since their last receipt run are included by
        default — re-running this for the same class won't re-generate anyone whose payment status hasn't changed.
      </p>
      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={fieldLabel}>Class
          <select value={cohort} onChange={(e) => setCohort(e.target.value)} style={{ ...input, minWidth: 160 }}>
            {CLASS_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: COLORS.muted, cursor: 'pointer' }}>
          <input type="checkbox" checked={includeAllPaid} onChange={(e) => { setIncludeAllPaid(e.target.checked); setPreviewSheets(null) }} />
          Include everyone who has paid (not just new/un-receipted payments)
        </label>
      </div>

      {loading ? <p style={{ color: COLORS.muted }}>Loading class...</p> : (
        <>
          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto', marginBottom: 16 }}>
            <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead><tr><th style={th}></th><th style={th}>Name</th><th style={th}>Adm. No.</th><th style={{ ...th, textAlign: 'right' }}>Balance</th><th style={th}>Payments to receipt</th></tr></thead>
              <tbody>
                {eligibleRows.map((r) => {
                  const pool = includeAllPaid ? r.payments : r.unreceiptedPayments
                  const allChecked = pool.length > 0 && pool.every((p) => selectedIds.has(p.id))
                  return (
                    <tr key={r.student.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                      <td style={{ ...td, width: 34 }}>
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={(e) => {
                            setSelectedIds((prev) => {
                              const next = new Set(prev)
                              pool.forEach((p) => { if (e.target.checked) next.add(p.id); else next.delete(p.id) })
                              return next
                            })
                          }}
                        />
                      </td>
                      <td style={td}>{r.student.full_name}</td>
                      <td style={{ ...td, color: COLORS.muted }}>{r.student.admission_no}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{r.balance.toLocaleString()}</td>
                      <td style={td}>{pool.length} payment{pool.length === 1 ? '' : 's'}</td>
                    </tr>
                  )
                })}
                {eligibleRows.length === 0 && (
                  <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 24 }}>
                    No students with {includeAllPaid ? 'payments' : 'new, un-receipted payments'} in this class.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          <button onClick={generatePreview} disabled={generating || eligibleRows.length === 0} style={{ ...btn, marginBottom: 16 }}>
            {generating ? 'Building preview...' : 'Generate Preview'}
          </button>

          {previewSheets && (
            <>
              <h3 style={{ fontSize: 15, marginBottom: 8 }}>
                Preview — {previewPaymentIds.length} receipt{previewPaymentIds.length === 1 ? '' : 's'} on {previewSheets.length} sheet{previewSheets.length === 1 ? '' : 's'}
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 16, maxHeight: 600, overflow: 'auto', border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 12 }}>
                {previewSheets.map((sheetHtml, i) => (
                  <div key={i} style={{ width: 330, height: 465, overflow: 'hidden', margin: '0 auto', border: `1px solid ${COLORS.ruleLight}`, borderRadius: 6 }}>
                    <div style={{ width: 780, height: 1100, transform: 'scale(0.423)', transformOrigin: 'top left' }} dangerouslySetInnerHTML={{ __html: sheetHtml }} />
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={confirmDownload} disabled={downloading} style={btn}>
                  {downloading ? 'Preparing PDF...' : `⬇ Download ${previewSheets.length} sheet${previewSheets.length === 1 ? '' : 's'}`}
                </button>
                <button onClick={() => setPreviewSheets(null)} style={secondaryBtn}>Discard preview</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ============================================================================
// FINANCE: Pocket Money — full transaction history (deposits/withdrawals)
// per student, with a running balance
// ============================================================================
function PocketMoneyScreen({ profile }) {
  const { notify } = useNotify()
  const [student, setStudent] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(false)

  const [txType, setTxType] = useState('deposit')
  const [txAmount, setTxAmount] = useState('')
  const [txNote, setTxNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [txSearch, setTxSearch] = useState('')

  useEffect(() => { if (student) loadTransactions() }, [student])

  async function loadTransactions() {
    setLoading(true)
    const { data } = await supabase
      .from('pocket_money_transactions').select('*').eq('student_id', student.id).order('created_at', { ascending: false })
    setTransactions(data || [])
    setLoading(false)
  }

  async function addTransaction() {
    if (!txAmount || Number(txAmount) <= 0) { notify('Enter a valid amount.', 'error'); return }
    setSaving(true)
    const { error } = await supabase.from('pocket_money_transactions').insert({
      student_id: student.id, type: txType, amount: Number(txAmount), note: txNote.trim() || null, recorded_by: profile.id,
    })
    setSaving(false)
    if (error) { notify(`Couldn't save transaction: ${error.message}`, 'error'); return }
    setTxAmount(''); setTxNote('')
    notify(`${txType === 'deposit' ? 'Deposit' : 'Withdrawal'} recorded.`)
    loadTransactions()
  }

  async function deleteTransaction(id) {
    if (!window.confirm('Delete this transaction? This cannot be undone.')) return
    const { error } = await supabase.from('pocket_money_transactions').delete().eq('id', id)
    if (error) { notify(`Couldn't delete: ${error.message}`, 'error'); return }
    notify('Transaction deleted.')
    loadTransactions()
  }

  const balance = transactions.reduce((sum, t) => sum + (t.type === 'deposit' ? Number(t.amount) : -Number(t.amount)), 0)

  const filteredTransactions = transactions.filter((t) => {
    const q = txSearch.trim().toLowerCase()
    if (!q) return true
    return (
      t.type?.toLowerCase().includes(q) ||
      t.note?.toLowerCase().includes(q) ||
      String(t.amount).includes(q)
    )
  })

  return (
    <div style={pageWrap}>
      <h2>Pocket Money</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 16 }}>Search for a student to view or update their pocket money balance.</p>
      <FinanceStudentPicker selectedStudent={student} onSelect={setStudent} />

      {student && (
        loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : (
          <>
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: '10px 16px', marginBottom: 16, maxWidth: 220 }}>
              <div style={{ fontSize: 11, color: COLORS.muted }}>Current Balance</div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{balance.toLocaleString()}</div>
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              <select value={txType} onChange={(e) => setTxType(e.target.value)} style={{ ...input, width: 130 }}>
                <option value="deposit">Deposit</option>
                <option value="withdrawal">Withdrawal</option>
              </select>
              <input type="number" placeholder="Amount" value={txAmount} onChange={(e) => setTxAmount(e.target.value)} style={{ ...input, width: 110 }} />
              <input placeholder="Note (optional)" value={txNote} onChange={(e) => setTxNote(e.target.value)} style={{ ...input, flex: 1, minWidth: 160 }} />
              <button onClick={addTransaction} disabled={saving} style={btn}>{saving ? 'Saving...' : 'Add'}</button>
            </div>

            <input
              placeholder="Search transactions by type, note, or amount…"
              value={txSearch}
              onChange={(e) => setTxSearch(e.target.value)}
              style={{ ...input, width: '100%', marginBottom: 10 }}
            />

            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead><tr><th style={th}>Date</th><th style={th}>Type</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Note</th><th style={th}></th></tr></thead>
                <tbody>
                  {filteredTransactions.map((t) => (
                    <tr key={t.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                      <td style={td}>{new Date(t.created_at).toLocaleDateString()}</td>
                      <td style={{ ...td, color: t.type === 'deposit' ? COLORS.good : COLORS.warn, fontWeight: 600 }}>
                        {t.type === 'deposit' ? 'Deposit' : 'Withdrawal'}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>{Number(t.amount).toLocaleString()}</td>
                      <td style={{ ...td, color: COLORS.muted }}>{t.note || '—'}</td>
                      <td style={td}>
                        <button onClick={() => deleteTransaction(t.id)} style={{ ...secondaryBtn, padding: '4px 10px', fontSize: 11.5, color: COLORS.warn, borderColor: COLORS.warn }}>Delete</button>
                      </td>
                    </tr>
                  ))}
                  {transactions.length === 0 && <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 16 }}>No transactions yet.</td></tr>}
                  {transactions.length > 0 && filteredTransactions.length === 0 && <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 16 }}>No transactions match your search.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )
      )}
    </div>
  )
}

// ============================================================================
// FINANCE: student lookup with a read-only details view (parent contact,
// medical conditions/allergies, notes) — no marks or performance data.
// ============================================================================
function FinanceStudentLookup() {
  const [query, setQuery] = useState('')
  const [cohortFilter, setCohortFilter] = useState('all')
  const [students, setStudents] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [viewingStudent, setViewingStudent] = useState(null)
  const [editingStudent, setEditingStudent] = useState(null)

  const cohortOptions = [
    { value: 'all', label: 'All Classes' },
    { value: 'form_3', label: 'Form 3' },
    { value: 'form_4', label: 'Form 4' },
    { value: 'grade_10', label: 'Grade 10' },
  ]

  useEffect(() => {
    supabase.from('students')
      .select('id, full_name, admission_no, cohort, pathway, parent_name, parent_phone, educational_track, medical_notes, extracurricular, general_notes')
      .order('full_name')
      .then(({ data, error }) => {
        if (error) setLoadError(`Couldn't load students: ${error.message}`)
        setStudents(data || [])
        setLoading(false)
      })
  }, [])

  const filtered = students.filter((s) => {
    if (cohortFilter !== 'all' && s.cohort !== cohortFilter) return false
    if (!query.trim()) return true
    const q = query.trim().toLowerCase()
    return s.full_name?.toLowerCase().includes(q) || s.admission_no?.toLowerCase().includes(q)
  })

  return (
    <div style={pageWrap}>
      <h2>Students</h2>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <input placeholder="Search by name or admission no…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ ...input, maxWidth: 260 }} />
        <select value={cohortFilter} onChange={(e) => setCohortFilter(e.target.value)} style={{ ...input, maxWidth: 160 }}>
          {cohortOptions.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>
      {loadError && <p style={errorText}>{loadError}</p>}
      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : (
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
          <table style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr><th style={th}>Full Name</th><th style={th}>Admission No.</th><th style={th}>Class</th><th style={th}>Medical / Allergies</th></tr></thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} onClick={() => setViewingStudent(s)} style={{ borderTop: `1px solid ${COLORS.ruleLight}`, cursor: 'pointer' }}>
                  <td style={td}>{s.full_name}</td>
                  <td style={{ ...td, color: COLORS.muted }}>{s.admission_no}</td>
                  <td style={td}>{CLASS_OPTIONS.find((c) => c.value === s.cohort)?.label || s.cohort}</td>
                  <td style={{ ...td, color: s.medical_notes ? COLORS.ink : COLORS.muted, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.medical_notes || ''}>
                    {s.medical_notes || '—'}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={4} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 16 }}>No students found.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {viewingStudent && (
        <StudentDetailsModal
          student={viewingStudent}
          onClose={() => setViewingStudent(null)}
          onEdit={() => { setEditingStudent(viewingStudent); setViewingStudent(null) }}
        />
      )}
      {editingStudent && (
        <FinanceEditDetailsModal
          student={editingStudent}
          onClose={() => setEditingStudent(null)}
          onSaved={(updated) => {
            setStudents((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
            setEditingStudent(null)
            setViewingStudent(updated)
          }}
        />
      )}
    </div>
  )
}

// ============================================================================
// FINANCE: full-page home (own header + logout), parallel to MarksEntryScreen
// but scoped to Fees, Pocket Money, and a basic student lookup only
// ============================================================================
function FinanceHome({ profile, onLogout }) {
  const [showChangePw, setShowChangePw] = useState(false)
  const [view, setView] = useState('fees') // 'fees' | 'class-receipts' | 'pocket' | 'students'
  const { logoUrl } = useSchoolSettings()
  return (
    <div style={{ background: COLORS.paper, minHeight: '100vh' }}>
      <div style={{ background: COLORS.band, color: COLORS.bandText, padding: '14px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img src={logoUrl} alt="Crest" style={{ width: 30, height: 30, borderRadius: '50%', flexShrink: 0 }} />
          <div style={{ fontWeight: 700 }}>Paul Wanjigi Alpine — Records</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 12 }}>{profile.full_name}</span>
          <button onClick={() => setShowChangePw(true)} style={{ ...secondaryBtn, background: 'transparent', color: COLORS.bandText, borderColor: 'rgba(255,255,255,0.3)', fontSize: 12 }}>Change Password</button>
          <button onClick={onLogout} style={{ ...secondaryBtn, background: 'transparent', color: COLORS.bandText, borderColor: 'rgba(255,255,255,0.3)' }}>Log out</button>
        </div>
      </div>
      <div style={pageWrap}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <button onClick={() => setView('fees')} style={view === 'fees' ? btn : secondaryBtn}>School Fees</button>
          <button onClick={() => setView('class-receipts')} style={view === 'class-receipts' ? btn : secondaryBtn}>Class Receipts</button>
          <button onClick={() => setView('pocket')} style={view === 'pocket' ? btn : secondaryBtn}>Pocket Money</button>
          <button onClick={() => setView('students')} style={view === 'students' ? btn : secondaryBtn}>Students</button>
        </div>
        {view === 'fees' && <FeesScreen profile={profile} />}
        {view === 'class-receipts' && <ClassReceiptsScreen profile={profile} />}
        {view === 'pocket' && <PocketMoneyScreen profile={profile} />}
        {view === 'students' && <FinanceStudentLookup />}
      </div>
      {showChangePw && <ChangePasswordModal onClose={() => setShowChangePw(false)} />}
    </div>
  )
}

// ============================================================================
// ADMIN (Finance-visible titles only): Finance tab — reuses the same Fees,
// Class Receipts, Pocket Money, and Student Lookup screens the Bursar/finance
// role uses, so leadership doesn't need a separate finance login to check on
// fees, receipts, or pocket money.
// ============================================================================
function AdminFinanceScreen({ profile }) {
  const [view, setView] = useState('fees') // 'fees' | 'class-receipts' | 'pocket' | 'students'
  return (
    <div style={pageWrap}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <button onClick={() => setView('fees')} style={view === 'fees' ? btn : secondaryBtn}>School Fees</button>
        <button onClick={() => setView('class-receipts')} style={view === 'class-receipts' ? btn : secondaryBtn}>Class Receipts</button>
        <button onClick={() => setView('pocket')} style={view === 'pocket' ? btn : secondaryBtn}>Pocket Money</button>
        <button onClick={() => setView('students')} style={view === 'students' ? btn : secondaryBtn}>Students</button>
      </div>
      {view === 'fees' && <FeesScreen profile={profile} />}
      {view === 'class-receipts' && <ClassReceiptsScreen profile={profile} />}
      {view === 'pocket' && <PocketMoneyScreen profile={profile} />}
      {view === 'students' && <FinanceStudentLookup />}
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
// WEEKLY QUIZZES — lightweight, separate from the Exams/Reports system.
// Quizzes are scored out of a per-quiz max (not necessarily 100), tracked
// per subject+class, and used ONLY for trend/analysis — they never feed the
// KCSE/CBC aggregate, ranking, or report cards.
//
// Requires two Supabase tables (create via the SQL editor):
//
// create table quizzes (
//   id uuid primary key default gen_random_uuid(),
//   subject_id uuid references subjects(id),
//   class_label text not null,
//   title text not null,
//   quiz_date date not null default current_date,
//   max_score numeric not null default 10,
//   order_index int not null default 1,
//   created_by uuid references profiles(id),
//   created_at timestamptz default now()
// );
//
// create table quiz_scores (
//   id uuid primary key default gen_random_uuid(),
//   quiz_id uuid references quizzes(id) on delete cascade,
//   student_id uuid references students(id) on delete cascade,
//   score numeric not null,
//   entered_by uuid references profiles(id),
//   created_at timestamptz default now(),
//   unique (quiz_id, student_id)
// );
// ============================================================================
function NewQuizModal({ assignment, teacherId, onClose, onCreated }) {
  const { notify } = useNotify()
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [maxScore, setMaxScore] = useState('10')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    if (!title.trim()) { setError('Give the quiz a name.'); return }
    setSaving(true)
    setError('')
    const { data: existing } = await supabase
      .from('quizzes').select('order_index')
      .eq('subject_id', assignment.subject_id).eq('class_label', assignment.class_label)
      .order('order_index', { ascending: false }).limit(1)
    const nextOrder = existing && existing.length > 0 ? existing[0].order_index + 1 : 1
    const { data, error: insertError } = await supabase.from('quizzes').insert({
      subject_id: assignment.subject_id, class_label: assignment.class_label,
      title: title.trim(), quiz_date: date, max_score: Number(maxScore) || 10,
      order_index: nextOrder, created_by: teacherId,
    }).select().single()
    setSaving(false)
    if (insertError) { setError(insertError.message); return }
    notify('Quiz created.')
    onCreated(data.id)
  }

  return (
    <div style={modalOverlay}>
      <div style={{ ...modalCard, maxWidth: 'min(380px, 94vw)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3>New Quiz</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <label style={fieldLabel}>Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} style={input} placeholder="e.g. Week 3 Quiz" />
        </label>
        <label style={fieldLabel}>Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={input} />
        </label>
        <label style={fieldLabel}>Out of (max score)
          <input type="number" min={1} value={maxScore} onChange={(e) => setMaxScore(e.target.value)} style={input} />
        </label>
        {error && <p style={errorText}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={btn}>{saving ? 'Saving...' : 'Create'}</button>
        </div>
      </div>
    </div>
  )
}

function QuizEntryPanel({ assignment, teacherId }) {
  const { notify } = useNotify()
  const [quizzes, setQuizzes] = useState([])
  const [selectedQuizId, setSelectedQuizId] = useState('')
  const [students, setStudents] = useState([])
  const [scoresByStudent, setScoresByStudent] = useState({})
  const [drafts, setDrafts] = useState({})
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const isNarrow = useIsNarrow()

  useEffect(() => { loadQuizzes() }, [assignment.subject_id, assignment.class_label])
  useEffect(() => { if (selectedQuizId) loadStudentsAndScores() }, [selectedQuizId])

  async function loadQuizzes() {
    setLoading(true)
    const { data } = await supabase
      .from('quizzes').select('*')
      .eq('subject_id', assignment.subject_id).eq('class_label', assignment.class_label)
      .order('quiz_date', { ascending: false })
    setQuizzes(data || [])
    if (data && data.length > 0) setSelectedQuizId(data[0].id)
    else { setSelectedQuizId(''); setStudents([]); setScoresByStudent({}); setLoading(false) }
  }

  async function loadStudentsAndScores() {
    setLoading(true)
    const { data: classStudents } = await supabase.from('students').select('*').eq('cohort', assignment.class_label).is('graduated_at', null).order('full_name')
    const classStudentIds = (classStudents || []).map((s) => s.id)
    const { data: allEnrollmentRows } = await supabase
      .from('student_subjects').select('student_id, subject_id').in('student_id', classStudentIds)
    const enrolledForSubject = new Set(
      (allEnrollmentRows || []).filter((r) => r.subject_id === assignment.subject_id).map((r) => r.student_id)
    )
    const subjectName = assignment.subjects?.name
    const isElectiveSubject =
      ONE_OF_GROUP.includes(subjectName) ||
      EXCLUSION_PAIRS.some((pair) => pair.includes(subjectName)) ||
      GRADE10_ELECTIVE_MENU.includes(subjectName)
    const studentData = (classStudents || []).filter((s) => (isElectiveSubject ? enrolledForSubject.has(s.id) : true))
    setStudents(studentData)

    const { data: scoreData } = await supabase.from('quiz_scores').select('*').eq('quiz_id', selectedQuizId)
    const byStudent = {}
    ;(scoreData || []).forEach((s) => { byStudent[s.student_id] = s })
    setScoresByStudent(byStudent)
    setDrafts({})
    setLoading(false)
  }

  function updateDraft(studentId, value) {
    setDrafts((prev) => ({ ...prev, [studentId]: value }))
  }

  async function saveAll() {
    setSaving(true)
    setSavedMsg('')
    const rows = Object.entries(drafts)
      .filter(([, v]) => v !== '' && v !== undefined)
      .map(([studentId, value]) => ({
        quiz_id: selectedQuizId, student_id: studentId, score: Number(value), entered_by: teacherId,
      }))
    if (rows.length === 0) { setSaving(false); return }
    const { error } = await supabase.from('quiz_scores').upsert(rows, { onConflict: 'quiz_id,student_id' })
    if (error) { notify(`Couldn't save: ${error.message}`, 'error') }
    else {
      setSavedMsg(`Saved ${rows.length} score${rows.length === 1 ? '' : 's'} at ${new Date().toLocaleTimeString()}`)
      loadStudentsAndScores()
    }
    setSaving(false)
  }

  const selectedQuiz = quizzes.find((q) => q.id === selectedQuizId)
  const enteredCount = students.filter((s) => scoresByStudent[s.id] || drafts[s.id] !== undefined).length

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <label style={fieldLabel}>Quiz
          <select value={selectedQuizId} onChange={(e) => setSelectedQuizId(e.target.value)} style={{ ...input, minWidth: 220 }}>
            {quizzes.length === 0 && <option value="">No quizzes yet</option>}
            {quizzes.map((q) => <option key={q.id} value={q.id}>{q.title} — {new Date(q.quiz_date).toLocaleDateString()} (/{q.max_score})</option>)}
          </select>
        </label>
        <button onClick={() => setShowNew(true)} style={secondaryBtn}>+ New Quiz</button>
      </div>

      {!selectedQuiz ? (
        <div style={{ textAlign: 'center', color: COLORS.muted, padding: 24, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
          No quizzes yet for this subject/class — create one to start entering scores.
        </div>
      ) : loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : (
        <>
          <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 10 }}>{enteredCount} / {students.length} entered · out of {selectedQuiz.max_score}</div>
          {isNarrow ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {students.map((s) => {
                const existing = scoresByStudent[s.id]
                return (
                  <div key={s.id} style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13.5 }}>{s.full_name}</div>
                      <div style={{ fontSize: 11, color: COLORS.muted }}>{s.admission_no}</div>
                    </div>
                    <input
                      type="number" min={0} max={selectedQuiz.max_score}
                      defaultValue={existing ? existing.score : ''}
                      onChange={(e) => updateDraft(s.id, e.target.value)}
                      style={{ width: 70, padding: '8px', textAlign: 'center', border: `1px solid ${COLORS.rule}`, borderRadius: 4 }}
                    />
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
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
              <table style={{ width: '100%', minWidth: 400, borderCollapse: 'collapse' }}>
                <thead><tr><th style={th}>Student</th><th style={th}>Adm. No.</th><th style={{ ...th, textAlign: 'center' }}>Score (/{selectedQuiz.max_score})</th></tr></thead>
                <tbody>
                  {students.map((s) => {
                    const existing = scoresByStudent[s.id]
                    return (
                      <tr key={s.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                        <td style={td}>{s.full_name}</td>
                        <td style={{ ...td, color: COLORS.muted }}>{s.admission_no}</td>
                        <td style={{ ...td, textAlign: 'center' }}>
                          <input
                            type="number" min={0} max={selectedQuiz.max_score}
                            defaultValue={existing ? existing.score : ''}
                            onChange={(e) => updateDraft(s.id, e.target.value)}
                            style={{ width: 64, padding: '6px 8px', textAlign: 'center', border: `1px solid ${COLORS.rule}`, borderRadius: 4 }}
                          />
                        </td>
                      </tr>
                    )
                  })}
                  {students.length === 0 && <tr><td colSpan={3} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 24 }}>No students in this class yet.</td></tr>}
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

      {showNew && (
        <NewQuizModal
          assignment={assignment} teacherId={teacherId}
          onClose={() => setShowNew(false)}
          onCreated={(id) => { setShowNew(false); loadQuizzes(); setSelectedQuizId(id) }}
        />
      )}
    </>
  )
}

function QuizAnalysisPanel({ assignment }) {
  const [quizzes, setQuizzes] = useState([])
  const [students, setStudents] = useState([])
  const [scoresIndex, setScoresIndex] = useState({}) // `${quizId}:${studentId}` -> { score, max }
  const [selectedStudentId, setSelectedStudentId] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadData() }, [assignment.subject_id, assignment.class_label])

  async function loadData() {
    setLoading(true)
    const { data: quizData } = await supabase
      .from('quizzes').select('*')
      .eq('subject_id', assignment.subject_id).eq('class_label', assignment.class_label)
      .order('quiz_date', { ascending: true })
    const quizList = quizData || []
    setQuizzes(quizList)

    const { data: classStudents } = await supabase.from('students').select('*').eq('cohort', assignment.class_label).is('graduated_at', null).order('full_name')
    const classStudentIds = (classStudents || []).map((s) => s.id)
    const { data: allEnrollmentRows } = await supabase
      .from('student_subjects').select('student_id, subject_id').in('student_id', classStudentIds)
    const enrolledForSubject = new Set(
      (allEnrollmentRows || []).filter((r) => r.subject_id === assignment.subject_id).map((r) => r.student_id)
    )
    const subjectName = assignment.subjects?.name
    const isElectiveSubject =
      ONE_OF_GROUP.includes(subjectName) ||
      EXCLUSION_PAIRS.some((pair) => pair.includes(subjectName)) ||
      GRADE10_ELECTIVE_MENU.includes(subjectName)
    const eligibleStudents = (classStudents || []).filter((s) => (isElectiveSubject ? enrolledForSubject.has(s.id) : true))
    setStudents(eligibleStudents)
    if (eligibleStudents.length > 0) {
      setSelectedStudentId((prev) => (eligibleStudents.some((s) => s.id === prev) ? prev : eligibleStudents[0].id))
    } else {
      setSelectedStudentId('')
    }

    const quizIds = quizList.map((q) => q.id)
    const { data: scoreData } = quizIds.length > 0
      ? await supabase.from('quiz_scores').select('*').in('quiz_id', quizIds)
      : { data: [] }
    const maxByQuiz = Object.fromEntries(quizList.map((q) => [q.id, q.max_score]))
    const index = {}
    ;(scoreData || []).forEach((s) => { index[`${s.quiz_id}:${s.student_id}`] = { score: s.score, max: maxByQuiz[s.quiz_id] } })
    setScoresIndex(index)
    setLoading(false)
  }

  const classTrend = quizzes.map((q) => {
    const pcts = students
      .map((s) => scoresIndex[`${q.id}:${s.id}`])
      .filter((v) => v !== undefined && v.max)
      .map((v) => (v.score / v.max) * 100)
    return { label: q.title, value: pcts.length > 0 ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10 : null }
  }).filter((t) => t.value !== null)

  const latestQuiz = quizzes.length > 0 ? quizzes[quizzes.length - 1] : null
  const latestScores = latestQuiz
    ? students
        .map((s) => ({ student: s, entry: scoresIndex[`${latestQuiz.id}:${s.id}`] }))
        .filter((r) => r.entry)
        .map((r) => ({ student: r.student, score: r.entry.score, max: r.entry.max, pct: (r.entry.score / r.entry.max) * 100 }))
    : []
  const ranked = [...latestScores].sort((a, b) => b.pct - a.pct)
  const topPerformers = ranked.slice(0, 5)
  const bottomPerformers = ranked.slice(-5).reverse()

  const studentTrend = quizzes
    .map((q) => {
      const entry = scoresIndex[`${q.id}:${selectedStudentId}`]
      return { label: q.title, value: entry ? Math.round((entry.score / entry.max) * 1000) / 10 : undefined }
    })
    .filter((t) => t.value !== undefined)

  if (loading) return <p style={{ color: COLORS.muted }}>Loading...</p>

  return (
    <>
      <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={sectionLabel}>Quiz Average Trend</div>
          {classTrend.length > 0 && (
            <div style={{ fontSize: 18, fontWeight: 800, color: COLORS.accent }}>{classTrend[classTrend.length - 1].value}%</div>
          )}
        </div>
        {classTrend.length === 0 ? (
          <p style={{ fontSize: 12.5, color: COLORS.muted }}>No quiz scores recorded yet.</p>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: buildProgressGraphSvg(classTrend) }} />
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 16 }}>
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16 }}>
          <div style={sectionLabel}>Top Performers{latestQuiz ? ` — ${latestQuiz.title}` : ''}</div>
          {topPerformers.length === 0 ? <p style={{ fontSize: 12.5, color: COLORS.muted }}>No scores yet.</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {topPerformers.map((r, i) => (
                <div key={r.student.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span>{i + 1}. {r.student.full_name}</span>
                  <span style={{ fontWeight: 700 }}>{r.score}/{r.max}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16 }}>
          <div style={sectionLabel}>Needs Attention{latestQuiz ? ` — ${latestQuiz.title}` : ''}</div>
          {bottomPerformers.length === 0 ? <p style={{ fontSize: 12.5, color: COLORS.muted }}>No scores yet.</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {bottomPerformers.map((r) => (
                <div key={r.student.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span>{r.student.full_name}</span>
                  <span style={{ fontWeight: 700, color: COLORS.warn }}>{r.score}/{r.max}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          <div style={sectionLabel}>Individual Student Progress</div>
          <select value={selectedStudentId} onChange={(e) => setSelectedStudentId(e.target.value)} style={{ ...input, maxWidth: 220 }}>
            {students.map((s) => <option key={s.id} value={s.id}>{s.full_name}</option>)}
          </select>
        </div>
        {studentTrend.length === 0 ? (
          <p style={{ fontSize: 12.5, color: COLORS.muted }}>No quiz scores recorded yet for this student.</p>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: buildProgressGraphSvg(studentTrend) }} />
        )}
      </div>
    </>
  )
}

// Main Quizzes screen: subject/class picker limited to the subjects THIS
// teacher teaches (their approved assignments), then an Enter Scores /
// Analysis toggle. Does NOT wrap itself in pageWrap — callers embed it
// (see MarksEntryScreen, AdminTeachingScreen).
function QuizzesScreen({ teacherId }) {
  const [view, setView] = useState('entry') // 'entry' | 'analysis'
  const [myAssignments, setMyAssignments] = useState([])
  const [selectedAssignment, setSelectedAssignment] = useState('')
  const [loadingAssignments, setLoadingAssignments] = useState(true)

  function currentAssignment() {
    return myAssignments.find((a) => a.id === selectedAssignment) || null
  }

  useEffect(() => { loadAssignments() }, [teacherId])

  async function loadAssignments() {
    setLoadingAssignments(true)
    const { data } = await supabase
      .from('teacher_assignments').select('*, subjects(name)').eq('teacher_id', teacherId).eq('status', 'approved')
    setMyAssignments(data || [])
    if (data && data.length > 0) setSelectedAssignment(data[0].id)
    setLoadingAssignments(false)
  }

  const assignment = currentAssignment()

  return (
    <>
      <h2>Weekly Quizzes</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 16 }}>
        Quick, informal quizzes tracked separately from full exams — for trend analysis only, they don't count toward the term aggregate or report cards.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        <button onClick={() => setView('entry')} style={view === 'entry' ? btn : secondaryBtn}>Enter Scores</button>
        <button onClick={() => setView('analysis')} style={view === 'analysis' ? btn : secondaryBtn}>Analysis</button>
      </div>

      {loadingAssignments ? <p style={{ color: COLORS.muted }}>Loading...</p> : (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
            {myAssignments.length === 0 ? (
              <p style={{ color: COLORS.muted }}>No subjects assigned yet.</p>
            ) : (
              <label style={fieldLabel}>Subject / Class
                <select value={selectedAssignment} onChange={(e) => setSelectedAssignment(e.target.value)} style={{ ...input, minWidth: 220 }}>
                  {myAssignments.map((a) => (
                    <option key={a.id} value={a.id}>{a.subjects?.name} — {CLASS_OPTIONS.find((c) => c.value === a.class_label)?.label}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {!assignment ? (
            <div style={{ textAlign: 'center', color: COLORS.muted, padding: 24, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
              No approved subject/class assignment selected yet.
            </div>
          ) : view === 'entry' ? (
            <QuizEntryPanel assignment={assignment} teacherId={teacherId} />
          ) : (
            <QuizAnalysisPanel assignment={assignment} />
          )}
        </>
      )}
    </>
  )
}

// ============================================================================
// GRADUATION — any admin can graduate a class (Form 4 by default).
//
// Graduating freezes a snapshot of each student's final result into
// `graduation_records` (final-exam subject marks + grades, total points,
// mean grade, class position, and the full track-record timeline), then
// stamps `students.graduated_at`. Graduated students disappear from every
// active-class screen (marks entry, exams, reports, performance track,
// attendance, Students list) but stay in the database, and their snapshot
// survives even if an exam is later deleted.
//
// Requires the SQL in graduation.sql (run it BEFORE deploying this file).
// ============================================================================
const GRADUATING_COHORTS = ['form_4']

// Builds one student's frozen graduation snapshot from live data.
async function buildGraduationSnapshot(student, finalExam, examsUpToFinal, scale, rankMap) {
  const isCbc = student.cohort === 'grade_10'
  const { data: enrol } = await supabase
    .from('student_subjects').select('subject_id, is_compulsory, subjects(name)').eq('student_id', student.id)
  const enrolled = (enrol || []).filter((r) => r.subjects?.name)
  const subjectIds = enrolled.map((r) => r.subject_id)
  const examIds = examsUpToFinal.map((e) => e.id)

  const [{ data: marks }, { data: historical }] = await Promise.all([
    subjectIds.length > 0
      ? supabase.from('marks').select('score, exam_id, subject_id')
          .eq('student_id', student.id).in('subject_id', subjectIds).in('exam_id', examIds)
      : Promise.resolve({ data: [] }),
    supabase.from('historical_performance').select('*').eq('student_id', student.id).order('order_index'),
  ])

  const subjectRows = enrolled.map((r) => {
    const m = (marks || []).find((x) => x.exam_id === finalExam.id && x.subject_id === r.subject_id)
    const score = m ? m.score : null
    return {
      name: r.subjects.name,
      is_compulsory: r.is_compulsory,
      score,
      grade: score === null ? null : (isCbc ? cbcLevel(score, scale) : kcseGrade(score, scale)),
    }
  })

  const aggregate = isCbc
    ? computeCbcTotal(subjectRows.map((r) => ({ score: r.score })), scale)
    : computeKcseAggregate(subjectRows.map((r) => ({ score: r.score, is_compulsory: r.is_compulsory })), scale)

  const scored = subjectRows.map((r) => r.score).filter((v) => v !== null && v !== undefined)
  const mp = scored.length > 0 ? meanPoints(scored, scale, isCbc) : null
  const meanScore = scored.length > 0 ? scored.reduce((a, b) => a + b, 0) / scored.length : null

  // Track record: entrance exam -> historical results -> every exam up to the final one.
  // `o` is a sort key so class-wide averaging keeps the points in time order.
  const timeline = []
  const entrancePoint = entranceTimelinePoint(student)
  if (entrancePoint) timeline.push({ o: 0, ...entrancePoint })
  ;(historical || []).forEach((h) => {
    timeline.push({ o: 1 + Number(h.order_index || 0), label: h.label, value: Math.round((h.points / h.max_points) * 100) })
  })
  examsUpToFinal.forEach((ex) => {
    const exMarks = (marks || []).filter((m) => m.exam_id === ex.id)
    if (exMarks.length > 0) {
      const avg = exMarks.reduce((s, m) => s + m.score, 0) / exMarks.length
      timeline.push({ o: 1000 + ex.order_index, label: ex.name, value: Math.round(avg) })
    }
  })

  const ranking = rankMap[student.id]
  return {
    student_id: student.id,
    class_label: student.cohort,
    final_exam_name: finalExam.name,
    total_points: aggregate?.total ?? null,
    max_points: aggregate?.maxTotal ?? null,
    mean_points: mp !== null ? Math.round(mp * 100) / 100 : null,
    mean_grade: mp !== null ? gradeForMeanPoints(mp, scale) : null,
    mean_score: meanScore !== null ? Math.round(meanScore * 10) / 10 : null,
    position: ranking ? Number(ranking.rnk) : null,
    subject_results: subjectRows,
    timeline,
  }
}

function GraduationScreen({ profile }) {
  const [mode, setMode] = useState('graduate') // 'graduate' | 'alumni'
  return (
    <div style={pageWrap}>
      <h2>Graduation</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 16 }}>
        Any admin can graduate a class. Graduated students keep their final results and track record here permanently.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button onClick={() => setMode('graduate')} style={mode === 'graduate' ? btn : secondaryBtn}>Graduate a Class</button>
        <button onClick={() => setMode('alumni')} style={mode === 'alumni' ? btn : secondaryBtn}>Graduated Classes</button>
      </div>
      {mode === 'graduate'
        ? <GraduateClassPanel profile={profile} onDone={() => setMode('alumni')} />
        : <AlumniPanel />}
    </div>
  )
}

function GraduateClassPanel({ profile, onDone }) {
  const { notify, confirmAction } = useNotify()
  const { scale: gradeScale } = useGradeScale()
  const { scale: cbcScale } = useCbcScale()
  const [classLabel, setClassLabel] = useState(GRADUATING_COHORTS[0])
  const [exams, setExams] = useState([])
  const [finalExamId, setFinalExamId] = useState('')
  const [year, setYear] = useState(String(new Date().getFullYear()))
  const [progress, setProgress] = useState(null) // { done, total }
  const [preview, setPreview] = useState(null)   // { rows, nameById }
  const [saving, setSaving] = useState(false)
  const isCbc = classLabel === 'grade_10'
  const scale = isCbc ? cbcScale : gradeScale

  useEffect(() => {
    supabase.from('exams').select('*').order('order_index', { ascending: false }).then(({ data }) => {
      setExams(data || [])
      if (data && data.length > 0) setFinalExamId(data[0].id)
    })
  }, [])

  useEffect(() => { setPreview(null) }, [classLabel, finalExamId, year])

  async function handlePreview() {
    const finalExam = exams.find((e) => e.id === finalExamId)
    if (!finalExam) { notify('Choose the final exam first.', 'error'); return }
    if (!/^\d{4}$/.test(year)) { notify('Enter a 4-digit graduation year.', 'error'); return }
    setPreview(null)
    setProgress({ done: 0, total: 0 })

    const { data: students, error } = await supabase
      .from('students').select('*').eq('cohort', classLabel).is('graduated_at', null).order('full_name')
    if (error) { setProgress(null); notify(`Couldn't load students: ${error.message}`, 'error'); return }
    if (!students || students.length === 0) { setProgress(null); notify('No active students in that class.', 'error'); return }

    const { data: rankData } = await supabase.rpc('compute_cohort_rankings', { p_cohort: classLabel, p_exam_id: finalExam.id })
    const rankMap = {}
    ;(rankData || []).forEach((r) => { rankMap[r.student_id] = r })

    const examsUpToFinal = exams.filter((e) => e.order_index <= finalExam.order_index).sort((a, b) => a.order_index - b.order_index)
    const rows = []
    const CHUNK = 6
    setProgress({ done: 0, total: students.length })
    for (let i = 0; i < students.length; i += CHUNK) {
      const batch = students.slice(i, i + CHUNK)
      const built = await Promise.all(batch.map((s) => buildGraduationSnapshot(s, finalExam, examsUpToFinal, scale, rankMap)))
      rows.push(...built)
      setProgress({ done: Math.min(i + CHUNK, students.length), total: students.length })
    }
    rows.sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9))
    const nameById = Object.fromEntries(students.map((s) => [s.id, s]))
    const outOf = rows.length
    rows.forEach((r) => { r.out_of = outOf })
    setPreview({ rows, nameById })
    setProgress(null)
  }

  async function handleGraduate() {
    if (!preview) return
    const label = CLASS_OPTIONS.find((c) => c.value === classLabel)?.label || classLabel
    const noResult = preview.rows.filter((r) => r.mean_grade === null).length
    const confirmed = await confirmAction(
      `Graduate ${label} (${preview.rows.length} students) as the Class of ${year}? They will leave all active-class screens and their results will be frozen.${noResult > 0 ? ` ${noResult} student(s) have no marks for the final exam and will graduate without a result.` : ''}`,
      { danger: true, confirmLabel: 'Graduate class' }
    )
    if (!confirmed) return
    setSaving(true)
    const records = preview.rows.map((r) => ({ ...r, graduation_year: Number(year), graduated_by: profile.id }))
    const { error: recError } = await supabase.from('graduation_records').upsert(records, { onConflict: 'student_id' })
    if (recError) { setSaving(false); notify(`Couldn't save graduation records: ${recError.message}`, 'error'); return }

    const ids = preview.rows.map((r) => r.student_id)
    const { error: stuError } = await supabase
      .from('students').update({ graduated_at: new Date().toISOString(), graduation_year: Number(year) }).in('id', ids)
    setSaving(false)
    if (stuError) { notify(`Records saved but couldn't mark students graduated: ${stuError.message}`, 'error'); return }

    notify(`${label} graduated — Class of ${year}.`)
    setPreview(null)
    onDone()
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14, alignItems: 'flex-end' }}>
        <label style={fieldLabel}>Class
          <select value={classLabel} onChange={(e) => setClassLabel(e.target.value)} style={{ ...input, minWidth: 140 }}>
            {CLASS_OPTIONS.filter((c) => GRADUATING_COHORTS.includes(c.value)).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label style={fieldLabel}>Final exam
          <select value={finalExamId} onChange={(e) => setFinalExamId(e.target.value)} style={{ ...input, minWidth: 200 }}>
            {exams.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label style={fieldLabel}>Graduation year
          <input value={year} onChange={(e) => setYear(e.target.value)} style={{ ...input, width: 100 }} inputMode="numeric" />
        </label>
        <button onClick={handlePreview} disabled={!!progress} style={btn}>{progress ? 'Working…' : 'Preview results'}</button>
      </div>
      <p style={{ fontSize: 12, color: COLORS.muted, marginBottom: 16 }}>
        Graduating marks and grade come from the final exam you pick; the track record covers entrance results and every exam up to it.
      </p>

      {progress && progress.total > 0 && (
        <p style={{ color: COLORS.muted, fontSize: 13 }}>Computing results… {progress.done} / {progress.total}</p>
      )}

      {preview && (
        <>
          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto', marginBottom: 14 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'center' }}>Pos.</th><th style={th}>Student</th><th style={th}>Adm. No.</th>
                  <th style={{ ...th, textAlign: 'center' }}>Total</th><th style={{ ...th, textAlign: 'center' }}>Mean Grade</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.student_id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                    <td style={{ ...td, textAlign: 'center' }}>{r.position ?? '—'}</td>
                    <td style={td}>{preview.nameById[r.student_id]?.full_name}</td>
                    <td style={td}>{preview.nameById[r.student_id]?.admission_no}</td>
                    <td style={{ ...td, textAlign: 'center' }}>{r.total_points != null ? `${r.total_points} / ${r.max_points}` : '—'}</td>
                    <td style={{ ...td, textAlign: 'center', fontWeight: 700, color: r.mean_grade ? COLORS.ink : COLORS.muted }}>{r.mean_grade || 'No marks'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={handleGraduate} disabled={saving} style={btn}>
            {saving ? 'Graduating…' : `Graduate ${preview.rows.length} students`}
          </button>
        </>
      )}
    </>
  )
}

function AlumniPanel() {
  const { notify, confirmAction } = useNotify()
  const [years, setYears] = useState([])
  const [year, setYear] = useState('')
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [openRecord, setOpenRecord] = useState(null)

  useEffect(() => { loadYears() }, [])
  useEffect(() => { if (year) loadRecords() }, [year])

  async function loadYears() {
    setLoading(true)
    const { data } = await supabase.from('graduation_records').select('graduation_year').order('graduation_year', { ascending: false })
    const list = [...new Set((data || []).map((r) => r.graduation_year))]
    setYears(list)
    if (list.length > 0) setYear((prev) => (list.includes(Number(prev)) ? prev : String(list[0])))
    else { setYear(''); setRecords([]) }
    setLoading(false)
  }

  async function loadRecords() {
    setLoading(true)
    const { data } = await supabase
      .from('graduation_records').select('*, students(full_name, admission_no)').eq('graduation_year', Number(year))
    const list = (data || []).sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9))
    setRecords(list)
    setLoading(false)
  }

  async function handleReverse() {
    const confirmed = await confirmAction(
      `Reverse the Class of ${year} graduation? Students return to their class as active students and the frozen graduation records for that year are permanently deleted.`,
      { danger: true, confirmLabel: 'Reverse graduation' }
    )
    if (!confirmed) return
    const ids = records.map((r) => r.student_id)
    const { error: stuError } = await supabase.from('students').update({ graduated_at: null, graduation_year: null }).in('id', ids)
    if (stuError) { notify(`Couldn't reinstate students: ${stuError.message}`, 'error'); return }
    const { error: recError } = await supabase.from('graduation_records').delete().eq('graduation_year', Number(year))
    if (recError) { notify(`Students reinstated, but couldn't delete records: ${recError.message}`, 'error'); return }
    notify(`Class of ${year} graduation reversed.`)
    loadYears()
  }

  // Class-wide summary
  const graded = records.filter((r) => r.mean_points != null)
  const classMeanPoints = graded.length > 0 ? graded.reduce((s, r) => s + Number(r.mean_points), 0) / graded.length : null
  const gradeGroups = {}
  graded.forEach((r) => {
    if (!gradeGroups[r.mean_grade]) gradeGroups[r.mean_grade] = { count: 0, pts: 0 }
    gradeGroups[r.mean_grade].count += 1
    gradeGroups[r.mean_grade].pts += Number(r.mean_points)
  })
  const gradeDist = Object.entries(gradeGroups)
    .map(([grade, g]) => ({ grade, count: g.count, avg: g.pts / g.count }))
    .sort((a, b) => b.avg - a.avg)
  const maxCount = Math.max(1, ...gradeDist.map((g) => g.count))

  const byLabel = new Map()
  records.forEach((r) => (r.timeline || []).forEach((t) => {
    if (!byLabel.has(t.label)) byLabel.set(t.label, { o: 0, values: [] })
    const entry = byLabel.get(t.label)
    entry.o += t.o
    entry.values.push(t.value)
  }))
  const classTimeline = [...byLabel.entries()]
    .map(([label, e]) => ({ label, o: e.o / e.values.length, value: Math.round((e.values.reduce((a, b) => a + b, 0) / e.values.length) * 10) / 10 }))
    .sort((a, b) => a.o - b.o)

  if (loading && years.length === 0) return <p style={{ color: COLORS.muted }}>Loading...</p>
  if (years.length === 0) {
    return (
      <div style={{ textAlign: 'center', color: COLORS.muted, padding: 24, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
        No class has graduated yet.
      </div>
    )
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
        <label style={fieldLabel}>Class of
          <select value={year} onChange={(e) => setYear(e.target.value)} style={{ ...input, minWidth: 120 }}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        {records.length > 0 && <button onClick={handleReverse} style={secondaryBtn}>Reverse graduation</button>}
      </div>

      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: '10px 16px' }}>
              <div style={{ fontSize: 11, color: COLORS.muted }}>Graduates</div>
              <div style={{ fontSize: 20, fontWeight: 800 }}>{records.length}</div>
            </div>
            <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: '10px 16px' }}>
              <div style={{ fontSize: 11, color: COLORS.muted }}>Class mean</div>
              <div style={{ fontSize: 20, fontWeight: 800 }}>
                {classMeanPoints !== null ? `${(Math.round(classMeanPoints * 100) / 100)} pts` : '—'}
              </div>
            </div>
          </div>

          <div style={sectionLabel}>Class Track Record (average across the class)</div>
          {classTimeline.length === 0
            ? <p style={{ fontSize: 12.5, color: COLORS.muted, marginBottom: 16 }}>No track record captured.</p>
            : <div style={{ marginBottom: 18 }} dangerouslySetInnerHTML={{ __html: buildProgressGraphSvg(classTimeline) }} />}

          <div style={sectionLabel}>Graduating Grade Distribution</div>
          <div style={{ marginBottom: 18 }}>
            {gradeDist.length === 0 && <p style={{ fontSize: 12.5, color: COLORS.muted }}>No graded results.</p>}
            {gradeDist.map((g) => (
              <div key={g.grade} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                <span style={{ width: 34, fontSize: 12.5, fontWeight: 700 }}>{g.grade}</span>
                <div style={{ flex: 1, background: COLORS.ruleLight, borderRadius: 4, height: 14 }}>
                  <div style={{ width: `${(g.count / maxCount) * 100}%`, background: COLORS.band, height: '100%', borderRadius: 4 }} />
                </div>
                <span style={{ width: 28, fontSize: 12, color: COLORS.muted, textAlign: 'right' }}>{g.count}</span>
              </div>
            ))}
          </div>

          <div style={sectionLabel}>Graduates</div>
          <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={{ ...th, textAlign: 'center' }}>Pos.</th><th style={th}>Student</th>
                  <th style={{ ...th, textAlign: 'center' }}>Total</th><th style={{ ...th, textAlign: 'center' }}>Grade</th><th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${COLORS.ruleLight}`, cursor: 'pointer' }} onClick={() => setOpenRecord(r)}>
                    <td style={{ ...td, textAlign: 'center' }}>{r.position ?? '—'}</td>
                    <td style={td}>{r.students?.full_name}<span style={{ color: COLORS.muted, marginLeft: 8 }}>{r.students?.admission_no}</span></td>
                    <td style={{ ...td, textAlign: 'center' }}>{r.total_points != null ? `${r.total_points} / ${r.max_points}` : '—'}</td>
                    <td style={{ ...td, textAlign: 'center', fontWeight: 700 }}>{r.mean_grade || '—'}</td>
                    <td style={{ ...td, color: COLORS.muted }}>View ›</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {openRecord && <GraduateRecordModal record={openRecord} onClose={() => setOpenRecord(null)} />}
    </>
  )
}

function GraduateRecordModal({ record, onClose }) {
  const subjects = [...(record.subject_results || [])].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
  const timeline = (record.timeline || []).slice().sort((a, b) => a.o - b.o)
  const stat = (label, value) => (
    <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: '8px 14px' }}>
      <div style={{ fontSize: 11, color: COLORS.muted }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800 }}>{value}</div>
    </div>
  )
  return (
    <div style={modalOverlay}>
      <div style={{ ...modalCard, maxWidth: 'min(640px, 94vw)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <h3>{record.students?.full_name} — Class of {record.graduation_year}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <p style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14 }}>{record.students?.admission_no} · Final exam: {record.final_exam_name}</p>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
          {stat('Graduating grade', record.mean_grade || '—')}
          {stat('Total points', record.total_points != null ? `${record.total_points} / ${record.max_points}` : '—')}
          {stat('Mean score', record.mean_score != null ? `${record.mean_score}%` : '—')}
          {stat('Position', record.position != null ? `${record.position} of ${record.out_of ?? '—'}` : '—')}
        </div>

        <div style={sectionLabel}>Track Record</div>
        {timeline.length === 0
          ? <p style={{ fontSize: 12.5, color: COLORS.muted, marginBottom: 16 }}>No track record captured.</p>
          : <div style={{ marginBottom: 16 }} dangerouslySetInnerHTML={{ __html: buildProgressGraphSvg(timeline) }} />}

        <div style={sectionLabel}>Graduating Marks — {record.final_exam_name}</div>
        <div style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead><tr><th style={th}>Subject</th><th style={{ ...th, textAlign: 'center' }}>Score</th><th style={{ ...th, textAlign: 'center' }}>Grade</th></tr></thead>
            <tbody>
              {subjects.map((s) => (
                <tr key={s.name} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                  <td style={td}>{s.name}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{s.score ?? '—'}</td>
                  <td style={{ ...td, textAlign: 'center', fontWeight: 700 }}>{s.grade ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={onClose} style={secondaryBtn}>Close</button>
        </div>
      </div>
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
// First point of a student's track record: their KCPE (Form 3/4) or KJSEA
// (Grade 10) entry marks as a percentage. Works even if entrance_type was never
// saved (falls back to the cohort's exam) or entrance_max is missing.
function entranceTimelinePoint(student) {
  if (student.entrance_score === null || student.entrance_score === undefined || student.entrance_score === '') return null
  const isCbc = student.cohort === 'grade_10'
  const max = Number(student.entrance_max) || (isCbc ? 72 : 500)
  return {
    label: student.entrance_type || (isCbc ? 'KJSEA' : 'KCPE'),
    value: Math.round((Number(student.entrance_score) / max) * 100),
  }
}

function buildProgressGraphSvg(timeline, maxValue = 100, svgHeight = 140) {
  if (!timeline || timeline.length === 0) return ''
  const width = 700, height = svgHeight, padding = { top: 10, right: 16, bottom: 24, left: 30 }
  const chartW = width - padding.left - padding.right
  const chartH = height - padding.top - padding.bottom
  const n = timeline.length
  const xFor = (i) => padding.left + (n === 1 ? chartW / 2 : (i / (n - 1)) * chartW)
  const yFor = (v) => padding.top + chartH - (v / maxValue) * chartH

  const points = timeline.map((t, i) => `${xFor(i)},${yFor(t.value)}`).join(' ')
  const dots = timeline.map((t, i) => `
    <circle cx="${xFor(i)}" cy="${yFor(t.value)}" r="${i === 0 ? 4 : 3}" fill="${i === 0 ? '#9C6B2E' : '#2C3E37'}" stroke="#fff" stroke-width="1.2" />
  `).join('')
  const labels = timeline.map((t, i) => `
    <text x="${xFor(i)}" y="${height - 6}" font-size="9" fill="#6B6558" text-anchor="middle">${t.label}</text>
  `).join('')
  // Value printed next to each point (above it, or below if it's near the top edge)
  const valueLabels = timeline.map((t, i) => {
    const y = yFor(t.value)
    const ly = y - 7 < padding.top - 1 ? y + 13 : y - 7
    const shown = Math.round(t.value * 10) / 10
    return `<text x="${xFor(i)}" y="${ly}" font-size="9" font-weight="700" fill="#1E2A24" text-anchor="middle">${shown}</text>`
  }).join('')
  const gridStep = maxValue / 4
  const gridLines = [0, 1, 2, 3, 4].map((i) => Math.round(i * gridStep * 10) / 10).map((v) => `
    <line x1="${padding.left}" y1="${yFor(v)}" x2="${width - padding.right}" y2="${yFor(v)}" stroke="#E4DFD1" stroke-width="1" />
    <text x="${padding.left - 6}" y="${yFor(v) + 3}" font-size="8" fill="#6B6558" text-anchor="end">${v}</text>
  `).join('')

  return `
    <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="background:#fff;">
      ${gridLines}
      <line x1="${xFor(0)}" y1="${padding.top}" x2="${xFor(0)}" y2="${height - padding.bottom}" stroke="#9C6B2E" stroke-dasharray="3,3" />
      <polyline points="${points}" fill="none" stroke="#2C3E37" stroke-width="2" />
      ${dots}
      ${valueLabels}
      ${labels}
    </svg>
  `
}

function buildReportHtml(report, watermarkOverride) {
  const reportWatermarkEnabled = (watermarkOverride?.enabled ?? reportBrandingCache.watermarkEnabled) !== false
  const reportWatermarkOpacity = watermarkOverride?.opacity ?? reportBrandingCache.watermarkOpacity ?? DEFAULT_REPORT_WATERMARK_OPACITY
  const reportWatermarkOffsetX = watermarkOverride?.offsetX ?? reportBrandingCache.watermarkOffsetX ?? 0
  const reportWatermarkOffsetY = watermarkOverride?.offsetY ?? reportBrandingCache.watermarkOffsetY ?? 0
  const isKcse = !report.isCbc
  // KCSE reports: order subjects by their official KNEC code (ascending).
  // Subjects with no matching code (getKcseSubjectCode returns '—') sort
  // after all coded ones, keeping their original relative order.
  const orderedSubjectRows = isKcse
    ? [...report.subjectRows].sort((a, b) => {
        const codeA = getKcseSubjectCode(a.name)
        const codeB = getKcseSubjectCode(b.name)
        if (codeA === '—' && codeB === '—') return 0
        if (codeA === '—') return 1
        if (codeB === '—') return -1
        return codeA.localeCompare(codeB)
      })
    : report.subjectRows

  const rowsHtml = orderedSubjectRows.map((r) => `
    <tr style="border-top:1px solid #E4DFD1;">
      <td style="padding:5px 10px;">${r.name}${r.is_compulsory ? ' *' : ''}</td>
      <td style="padding:5px 10px;">${r.prevGrade || '—'}</td>
      <td style="padding:5px 10px;"><strong>${r.grade || '—'}</strong></td>
      <td style="padding:5px 10px;color:#6B6558;">${r.remark || ''}</td>
    </tr>`).join('')

  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })

  const gradeOrLevelWord = report.isCbc ? 'Level' : 'Grade'

  return `
    <div style="position:relative;max-width:760px;margin:0 auto;font-family:sans-serif;color:#1E2A24;">
      ${reportWatermarkEnabled ? `<img src="${reportBrandingCache.logoUrl}" crossorigin="anonymous" style="position:absolute;top:calc(280px + ${reportWatermarkOffsetY}px);left:calc(50% + ${reportWatermarkOffsetX}px);width:480px;transform:translate(-50%,0);opacity:${reportWatermarkOpacity};pointer-events:none;z-index:0;" />` : ''}
      <div style="position:relative;z-index:1;">
      <!-- Letterhead: logo left, school details centered, second logo right -->
      <div style="border-bottom:3px solid #2C3E37;padding-bottom:8px;margin-bottom:6px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <img src="${reportBrandingCache.logoUrl}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;flex-shrink:0;box-shadow:0 1px 3px rgba(0,0,0,0.15);" crossorigin="anonymous" />
          <div style="flex:1;text-align:center;">
            <div style="font-size:24px;font-weight:800;color:#2C3E37;line-height:1.15;">Paul Wanjigi Alpine High School</div>
            <div style="font-size:11.5px;color:#6B6558;margin-top:2px;">P.O. BOX 1801-20117 NAIVASHA &nbsp;·&nbsp; www.pwahigh.com</div>
            <div style="font-size:11.5px;color:#9C6B2E;font-weight:700;margin-top:2px;">Mission: To graduate leaders with integrity</div>
          </div>
          <img src="${reportBrandingCache.secondaryLogoUrl}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;flex-shrink:0;box-shadow:0 1px 3px rgba(0,0,0,0.15);" crossorigin="anonymous" />
        </div>
      </div>

      <!-- Title bar -->
      <div style="display:flex;justify-content:space-between;align-items:center;background:#2C3E37;color:#F4F1E8;padding:7px 16px;margin-bottom:12px;font-size:12.5px;border-radius:8px;">
        <div><strong>${report.exam.name}</strong> &nbsp;·&nbsp; ${report.exam.term} ${report.exam.year}</div>
        <div>Issue Date: ${new Date().toLocaleDateString('en-GB')}</div>
      </div>

      <!-- Student info -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;background:#F7F5EF;border:1px solid #E4DFD1;padding:9px 16px;margin-bottom:12px;font-size:13px;border-radius:10px;">
        <div><span style="color:#6B6558;font-size:11px;">Student</span><br/><strong>${report.student.full_name}</strong></div>
        <div><span style="color:#6B6558;font-size:11px;">Adm. No.</span><br/><strong>${report.student.admission_no}</strong></div>
        <div><span style="color:#6B6558;font-size:11px;">${report.student.cohort === 'grade_10' ? 'Grade' : 'Form'}</span><br/><strong>${report.student.cohort}</strong></div>
      </div>

      <!-- Subject table -->
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:4px;border-radius:10px;overflow:hidden;">
        <thead>
          <tr style="background:#2C3E37;color:#F4F1E8;">
            <th style="text-align:left;padding:6px 10px;">Subject</th>
            <th style="text-align:left;padding:6px 10px;">Previous</th>
            <th style="text-align:left;padding:6px 10px;">This Exam</th>
            <th style="text-align:left;padding:6px 10px;">Remarks</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>

      <!-- Summary: This Term vs Last Term -->
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:12px;border-radius:10px;overflow:hidden;">
        <thead>
          <tr style="background:#2C3E37;color:#F4F1E8;">
            <th style="text-align:left;padding:5px 10px;"></th>
            <th style="text-align:left;padding:5px 10px;">Total Points</th>
            <th style="text-align:left;padding:5px 10px;">Mean ${gradeOrLevelWord}</th>
            <th style="text-align:left;padding:5px 10px;">Position</th>
          </tr>
        </thead>
        <tbody>
          <tr style="background:#E9DDC6;">
            <td style="padding:5px 10px;font-weight:700;">This Term</td>
            <td style="padding:5px 10px;font-weight:700;">${report.aggregate.total} / ${report.aggregate.maxTotal}</td>
            <td style="padding:5px 10px;font-weight:700;">${report.meanGrade ? `${report.meanGrade.grade} (${report.meanGrade.points})` : '—'}</td>
            <td style="padding:5px 10px;font-weight:700;">${report.position ?? '—'} of ${report.outOf ?? '—'}</td>
          </tr>
          <tr style="border-top:1px solid #E4DFD1;">
            <td style="padding:5px 10px;color:#6B6558;">Last Term</td>
            <td style="padding:5px 10px;color:#6B6558;">${report.prevAggregate ? `${report.prevAggregate.total} / ${report.prevAggregate.maxTotal}` : '—'}</td>
            <td style="padding:5px 10px;color:#6B6558;">${report.prevMeanGrade ? `${report.prevMeanGrade.grade} (${report.prevMeanGrade.points})` : '—'}</td>
            <td style="padding:5px 10px;color:#6B6558;">${report.prevPosition ? `${report.prevPosition} of ${report.prevOutOf}` : '—'}</td>
          </tr>
        </tbody>
      </table>

      ${report.timeline && report.timeline.length > 0 ? `
      <!-- Progress graph -->
      <div style="margin-bottom:12px;">
        <div style="font-size:10.5px;letter-spacing:1px;color:#6B6558;text-transform:uppercase;margin-bottom:4px;">Progress</div>
        <div style="border:1px solid #E4DFD1;padding:6px 4px 0;border-radius:10px;">
          ${buildProgressGraphSvg(report.timeline, 100, 105)}
        </div>
      </div>
      ` : ''}

      <!-- Comments -->
      <div style="font-size:12.5px;margin-bottom:12px;line-height:1.45;">
        <div><strong>Principal's Comments:</strong> ${report.principalComment || '—'}</div>
        <div><strong>Class Teacher's Comments:</strong> ${report.classTeacherComment || '—'}</div>
        <div style="color:#6B6558;margin-top:6px;">Date: ${today}</div>
      </div>

      <!-- Signatures -->
      <div style="display:flex;justify-content:space-between;margin-top:22px;font-size:12px;">
        <div style="width:45%;text-align:center;">
          <div style="border-top:1px solid #1E2A24;padding-top:4px;">School Manager</div>
        </div>
        <div style="width:45%;text-align:center;">
          <div style="border-top:1px solid #1E2A24;padding-top:4px;">School Principal</div>
        </div>
      </div>

      <!-- Parent / Guardian sign-off -->
      <div style="margin-top:14px;border-top:1px solid #E4DFD1;padding-top:10px;font-size:12px;">
        <div style="margin-bottom:8px;">Report seen by Parent / Guardian / Sponsor:</div>
        <div style="display:flex;justify-content:space-between;">
          <div style="width:45%;">Date: <span style="display:inline-block;border-bottom:1px solid #1E2A24;width:70%;">&nbsp;</span></div>
          <div style="width:45%;">Signature: <span style="display:inline-block;border-bottom:1px solid #1E2A24;width:60%;">&nbsp;</span></div>
        </div>
      </div>

      <!-- Term resumes -->
      <div style="margin-top:10px;font-size:12.5px;font-weight:700;color:#2C3E37;">
        The Term Resumes on: ${report.exam.term_resumes_on ? new Date(report.exam.term_resumes_on).toLocaleDateString('en-GB') : '— (not yet set by admin)'}
      </div>
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
  const canvas = await html2canvas(container, { scale: 2, backgroundColor: '#ffffff', windowWidth: 800, width: 800, useCORS: true })
  document.body.removeChild(container)

  const imgData = canvas.toDataURL('image/png')
  const pdf = new jsPDF('p', 'mm', 'a4')
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  // Fit inside the page: shrink (keeping proportions) if the card is taller
  // than one A4 page, instead of letting it run off the bottom.
  let imgWidth = pageWidth - 20
  let imgHeight = (canvas.height * imgWidth) / canvas.width
  if (imgHeight > pageHeight - 20) {
    imgHeight = pageHeight - 20
    imgWidth = (canvas.width * imgHeight) / canvas.height
  }
  pdf.addImage(imgData, 'PNG', (pageWidth - imgWidth) / 2, 10, imgWidth, imgHeight)
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

// Printing: every report card must fit on exactly one A4 page. The card is
// measured off-screen at its normal width, then shrunk (CSS zoom) just enough
// to fit the printable height, so long comments or many subjects don't spill
// onto a second page.
const PRINT_FIT_HEIGHT_PX = 1040 // A4 (297mm) minus 6mm margins, with a little spare

function reportPrintZoom(html) {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:760px;visibility:hidden;'
  probe.innerHTML = html
  document.body.appendChild(probe)
  const card = probe.firstElementChild
  const height = card ? card.getBoundingClientRect().height : 0
  document.body.removeChild(probe)
  if (!height) return 0.9
  return Math.max(0.5, Math.min(0.98, PRINT_FIT_HEIGHT_PX / height))
}

function printAllReports(results) {
  const container = document.createElement('div')
  container.id = 'print-all-container'
  container.innerHTML = results
    .map((r) => {
      const html = buildReportHtml(r.report)
      return `<div class="report-print-page" style="padding:0;font-family:sans-serif;zoom:${reportPrintZoom(html)};">${html}</div>`
    })
    .join('')

  const style = document.createElement('style')
  style.id = 'print-all-style'
  style.innerHTML = `
    @media print {
      @page { size: A4; margin: 6mm; }
      body > *:not(#print-all-container) { display: none !important; }
      #print-all-container { display: block !important; }
      #print-all-container .report-print-page { page-break-after: always; break-after: page; page-break-inside: avoid; break-inside: avoid; }
      #print-all-container .report-print-page:last-child { page-break-after: auto; break-after: auto; }
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
  const html = buildReportHtml(report)
  container.innerHTML = `<div style="font-family:sans-serif;zoom:${reportPrintZoom(html)};">${html}</div>`
  const style = document.createElement('style')
  style.id = 'print-single-style'
  style.innerHTML = `
    @page { size: A4; margin: 6mm; }
    @media print {
      body > *:not(#print-single-container) { display: none !important; }
      #print-single-container { display: block !important; padding: 0 !important; }
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

// Normalises Kenyan numbers to +254XXXXXXXXX for SMS. Returns null if invalid.
function normalizeKenyanPhone(phone) {
  const d = (phone || '').replace(/\D/g, '')
  if (/^254[17]\d{8}$/.test(d)) return `+${d}`
  if (/^0[17]\d{8}$/.test(d)) return `+254${d.slice(1)}`
  if (/^[17]\d{8}$/.test(d)) return `+254${d}`
  return null
}

// Same layout as the WhatsApp message (name, exam, each subject's grade,
// then totals), but kept to plain ASCII. Symbols like the em dash or "|"
// would switch the whole SMS to Unicode, which fits only 70 characters per
// segment instead of 160 and costs about double.
function buildBulkSmsText(report) {
  const lines = [
    `${report.student.full_name} (${report.student.admission_no}) - ${report.exam.name}`,
    ...report.subjectRows.map((r) => `${r.name}: ${r.grade || '-'}`),
    `Total: ${report.aggregate.total}/${report.aggregate.maxTotal}${report.meanGrade ? `, Mean: ${report.meanGrade.grade}` : ''}, Position: ${report.position}/${report.outOf}`,
  ]
  return lines.join('\n').normalize('NFKD').replace(/[^\x20-\x7E\n]/g, '')
}

// How many SMS credits one message uses (160 chars single, 153 per part if longer).
function smsSegments(text) {
  return text.length <= 160 ? 1 : Math.ceil(text.length / 153)
}

function buildSmsMessage(report) {
  const lines = [
    `${report.student.full_name} (${report.student.admission_no}) - ${report.exam.name}`,
    ...report.subjectRows.map((r) => `${r.name}: ${r.grade || '—'}`),
    `Total: ${report.aggregate.total}/${report.aggregate.maxTotal}${report.meanGrade ? ` | Mean: ${report.meanGrade.grade}` : ''} | Position: ${report.position}/${report.outOf}`,
  ]
  return lines.join('\n')
}

  function ReportsScreen() {
  const { notify, confirmAction } = useNotify()
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
  const [smsStatus, setSmsStatus] = useState({}) // studentId -> 'sent' | 'failed' | 'no_phone'
  const [smsSending, setSmsSending] = useState(false)
  useEffect(() => {
    supabase.from('exams').select('*').order('order_index', { ascending: false }).then(({ data }) => {
      setExams(data || [])
      if (data && data.length > 0) setSelectedExamId(data[0].id)
    })
    supabase.from('students').select('*').is('graduated_at', null).order('full_name').then(({ data }) => setStudents(data || []))
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
    const meanGradeFor = (key) => {
      const sc = subjectRows.map((r) => r[key]).filter((v) => v !== null && v !== undefined)
      if (sc.length === 0) return null
      const activeScale = isCbc ? cbcScale : gradeScale
      const mp = meanPoints(sc, activeScale, isCbc)
      return mp === null ? null : { points: Math.round(mp * 100) / 100, grade: gradeForMeanPoints(mp, activeScale) }
    }
    const meanGrade = meanGradeFor('score')
    const prevMeanGrade = prevExam ? meanGradeFor('prevScore') : null
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
    const entrancePoint = entranceTimelinePoint(student)
    if (entrancePoint) timeline.push(entrancePoint)
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
    return { student, exam, prevExam, subjectRows, aggregate, meanGrade, prevMeanGrade, position, outOf, isCbc, timeline, prevAggregate, prevPosition, prevOutOf }
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
  async function handleSendSms({ onlyFailed = false } = {}) {
    const eligible = batchResults.filter((r) => r.ok && (onlyFailed ? smsStatus[r.student.id] === 'failed' : smsStatus[r.student.id] !== 'sent'))
    const toSend = []
    const noPhone = {}
    eligible.forEach((r) => {
      const to = normalizeKenyanPhone(r.student.parent_phone)
      if (to) toSend.push({ id: r.student.id, to, message: buildBulkSmsText(r.report) })
      else noPhone[r.student.id] = 'no_phone'
    })
    const skipped = Object.keys(noPhone).length
    if (toSend.length === 0) {
      setSmsStatus((prev) => ({ ...prev, ...noPhone }))
      notify('No valid parent phone numbers to send to.', 'error')
      return
    }
    const totalSegments = toSend.reduce((sum, m) => sum + smsSegments(m.message), 0)
    const ok = await confirmAction(
      `Send results by SMS to ${toSend.length} parent${toSend.length === 1 ? '' : 's'}?${skipped ? ` ${skipped} student${skipped === 1 ? ' has' : 's have'} no valid phone number and will be skipped.` : ''} This will use about ${totalSegments} SMS credits, and messages can't be recalled.`,
      { confirmLabel: 'Send SMS' }
    )
    if (!ok) return
    setSmsSending(true)
    setSmsStatus((prev) => ({ ...prev, ...noPhone }))
    const CHUNK = 50
    let sent = 0
    let failed = 0
    let firstError = ''
    for (let i = 0; i < toSend.length; i += CHUNK) {
      const chunk = toSend.slice(i, i + CHUNK)
      const { data, error } = await supabase.functions.invoke('send-results-sms', { body: { messages: chunk } })
      const byId = {}
      if (error || !data?.results) {
        chunk.forEach((m) => { byId[m.id] = 'failed' })
        failed += chunk.length
        firstError = firstError || data?.error || error?.message || 'No response from the SMS function'
      } else {
        data.results.forEach((r) => {
          byId[r.id] = r.ok ? 'sent' : 'failed'
          if (r.ok) sent++
          else { failed++; firstError = firstError || r.error || 'Send failed' }
        })
      }
      setSmsStatus((prev) => ({ ...prev, ...byId }))
    }
    setSmsSending(false)
    if (failed === 0) notify(`SMS sent to ${sent} parent${sent === 1 ? '' : 's'}.`)
    else notify(`${sent} sent, ${failed} failed${firstError ? ` — ${firstError}` : ''}. Use "Retry failed SMS" to resend those.`, 'error')
  }

  async function handleBatchGenerate() {
    if (selectedBatchIds.size === 0 || !selectedExamId) return
    setLoading(true)
    setBatchResults([])
    setSmsStatus({})
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
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {Object.values(smsStatus).includes('failed') && (
                    <button onClick={() => handleSendSms({ onlyFailed: true })} disabled={smsSending} style={{ ...secondaryBtn, color: COLORS.warn, borderColor: COLORS.warn }}>
                      ↻ Retry failed SMS
                    </button>
                  )}
                  <button onClick={() => handleSendSms()} disabled={smsSending || batchResults.length === 0} style={secondaryBtn}>
                    {smsSending ? 'Sending SMS...' : '📱 SMS Parents'}
                  </button>
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
                <thead><tr><th style={th}>Student</th><th style={th}>Total</th><th style={th}>Position</th><th style={th}>Status</th><th style={th}>SMS</th><th style={th}></th></tr></thead>
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
                      <td style={{ ...td, fontSize: 12, color: smsStatus[r.student.id] === 'sent' ? COLORS.good : smsStatus[r.student.id] ? COLORS.warn : COLORS.muted }}>
                        {smsStatus[r.student.id] === 'sent' ? '✓ Sent' : smsStatus[r.student.id] === 'failed' ? '✕ Failed' : smsStatus[r.student.id] === 'no_phone' ? 'No valid phone' : '—'}
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

    // Teachers always show; admins only show if they hold a real teaching
    // leadership title (Dean/Principal/Deputy). Non-teaching admin titles
    // (School Manager, Director) and untitled/system admin accounts (e.g. a
    // personal monitoring login) stay hidden here.
    const teacherProfiles = (allApproved || []).filter(
      (p) => p.role === 'teacher' || (p.role === 'admin' && p.title && !NON_TEACHING_TITLES.includes(p.title))
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
// A student is flagged as "needs help" when their average mark is below the
// threshold chosen on the screen, or when they dropped this many places (or
// more) compared with the previous exam.
const PT_NEEDS_HELP_RANK_DROP = 5
const PT_ROWS_PER_PAGE = 28
const PT_HELP_ROWS_PER_PAGE = 16

function ptEsc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function ptFindNeedsHelp(studentStats, belowScore) {
  return studentStats
    .map((s) => {
      const reasons = []
      if (s.meanScore !== null && s.meanScore < belowScore) reasons.push(`Average ${Math.round(s.meanScore)}%`)
      if (s.rankChange !== null && s.rankChange <= -PT_NEEDS_HELP_RANK_DROP) reasons.push(`Dropped ${Math.abs(s.rankChange)} places`)
      const weakSubjects = s.subjects.filter((x) => x.score < belowScore).sort((a, b) => a.score - b.score)
      return { ...s, reasons, weakSubjects }
    })
    .filter((s) => s.reasons.length > 0)
    .sort((a, b) => (a.meanScore ?? 0) - (b.meanScore ?? 0))
}

function ptTrendHtml(change) {
  if (change === null || change === undefined) return '<span style="color:#8A8474;">New</span>'
  if (change > 0) return `<span style="color:#3E6B4F;font-weight:700;">▲ ${change}</span>`
  if (change < 0) return `<span style="color:#B23A3A;font-weight:700;">▼ ${Math.abs(change)}</span>`
  return '<span style="color:#8A8474;">–</span>'
}

// Returns one HTML string per A4 page:
//   1. Class analysis   2. Grade of every student (as many pages as needed)
//   3. Most improved    4. Students who need help
function buildPerformanceTrackPages(d) {
  const { cohortLabel, examLabel, prevExamLabel, classMean, prevClassMean, subjectMeans, studentStats, mostImproved, needsHelp, helpBelow, maxScalePoints } = d
  const n = studentStats.length
  const thS = 'text-align:left;padding:7px 10px;'
  const tdS = 'padding:6px 10px;vertical-align:top;'
  const table = (cols, rows) => `<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:#2C3E37;color:#F4F1E8;">${cols.map((c) => `<th style="${thS}">${c}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
  const row = (cells, i) => `<tr style="border-top:1px solid #E4DFD1;${i % 2 ? 'background:#FBFAF6;' : ''}">${cells.map((c) => `<td style="${tdS}">${c}</td>`).join('')}</tr>`
  const title = (t, sub) => `<div style="font-size:18px;font-weight:800;color:#2C3E37;">${t}</div><div style="font-size:11.5px;color:#6B6558;margin:3px 0 14px;">${sub || ''}</div>`
  const sub2 = (t) => `<div style="font-size:13px;font-weight:700;color:#2C3E37;margin:18px 0 8px;">${t}</div>`
  const tile = (label, value, note) => `<div style="flex:1;min-width:150px;border:1px solid #E4DFD1;border-radius:8px;padding:10px 12px;background:#F7F5EF;"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6B6558;">${label}</div><div style="font-size:19px;font-weight:800;color:#2C3E37;margin-top:2px;">${value}</div>${note ? `<div style="font-size:11px;color:#6B6558;margin-top:2px;">${note}</div>` : ''}</div>`
  const delta = (v) => (v === null || v === undefined) ? '–' : v > 0.004 ? `<span style="color:#3E6B4F;font-weight:700;">▲ ${v.toFixed(2)}</span>` : v < -0.004 ? `<span style="color:#B23A3A;font-weight:700;">▼ ${Math.abs(v).toFixed(2)}</span>` : '<span style="color:#8A8474;">–</span>'
  const bar = (pct, color) => `<div style="background:#E4DFD1;border-radius:4px;height:12px;overflow:hidden;"><div style="width:${Math.max(0, Math.min(100, pct))}%;background:${color};height:100%;"></div></div>`
  const empty = (msg) => `<div style="padding:18px;text-align:center;color:#6B6558;background:#F7F5EF;border:1px solid #E4DFD1;border-radius:8px;font-size:12.5px;">${msg}</div>`
  const chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out }
  const bodies = []

  // ---- Page 1: class analysis ----
  const top = studentStats[0]
  const classDelta = classMean && prevClassMean ? delta(classMean.points - prevClassMean.points) : ''
  const dist = {}
  studentStats.forEach((s) => {
    if (!s.grade) return
    if (!dist[s.grade]) dist[s.grade] = { grade: s.grade, count: 0, pts: s.meanPoints }
    dist[s.grade].count += 1
    dist[s.grade].pts = Math.max(dist[s.grade].pts, s.meanPoints)
  })
  const distRows = Object.values(dist).sort((a, b) => b.pts - a.pts)
  const maxCount = Math.max(1, ...distRows.map((x) => x.count))
  const subjectRowsHtml = subjectMeans.map((s, i) => row([
    `${ptEsc(s.name)}${subjectMeans.length > 1 && i === 0 ? ' <span style="color:#3E6B4F;font-size:10px;">★ strongest</span>' : ''}${subjectMeans.length > 1 && i === subjectMeans.length - 1 ? ' <span style="color:#B23A3A;font-size:10px;">weakest</span>' : ''}`,
    s.grade || '–',
    s.meanPoints,
    s.count,
    s.prevMeanPoints !== null && s.prevMeanPoints !== undefined ? delta(s.meanPoints - s.prevMeanPoints) : '–',
    `<div style="width:110px;">${bar(maxScalePoints > 0 ? (s.meanPoints / maxScalePoints) * 100 : 0, '#3E6B4F')}</div>`,
  ], i))
  bodies.push(`
    ${title('Class Analysis', `${ptEsc(cohortLabel)} · ${ptEsc(examLabel)}${prevExamLabel ? ` · compared with ${ptEsc(prevExamLabel)}` : ''}`)}
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      ${tile('Students', n)}
      ${tile('Class mean', classMean ? `${classMean.grade} (${classMean.points})` : '–', classDelta && classDelta !== '–' ? `${classDelta} vs previous` : '')}
      ${tile('Top student', top ? ptEsc(top.student.full_name) : '–', top ? `${top.totalPoints} / ${top.maxPoints} points` : '')}
      ${tile('Need help', needsHelp.length, `average below ${helpBelow}%`)}
    </div>
    ${sub2('Grade distribution (each student\'s mean grade)')}
    ${distRows.length === 0 ? empty('No marks recorded yet.') : table(['Grade', 'Students', ''], distRows.map((x, i) => row([`<strong>${ptEsc(x.grade)}</strong>`, x.count, `<div style="width:260px;">${bar((x.count / maxCount) * 100, '#2C3E37')}</div>`], i)))}
    ${sub2('Subject performance')}
    ${subjectMeans.length === 0 ? empty('No marks recorded yet.') : table(['Subject', 'Mean grade', 'Mean points', 'Entries', 'Change', ''], subjectRowsHtml)}
  `)

  // ---- Pages 2+: grade of every student ----
  if (n === 0) {
    bodies.push(`${title('Student Grades', 'All students, ranked')}${empty('No marks recorded for this cohort/exam yet.')}`)
  } else {
    chunk(studentStats, PT_ROWS_PER_PAGE).forEach((part, pi) => {
      bodies.push(`
        ${title('Student Grades', pi === 0 ? `All ${n} students ranked, with mean grade and movement since the previous exam` : 'continued')}
        ${table(['Pos', 'Student', 'Adm. No.', 'Total Points', 'Mean %', 'Mean Grade', 'vs Previous'], part.map((s, i) => row([
          `<strong>${s.rank}</strong>`,
          ptEsc(s.student.full_name),
          `<span style="color:#6B6558;">${ptEsc(s.student.admission_no)}</span>`,
          `${s.totalPoints} / ${s.maxPoints}`,
          s.meanScore !== null ? (Math.round(s.meanScore * 10) / 10) : '–',
          `<strong>${ptEsc(s.grade || '–')}</strong>`,
          ptTrendHtml(s.rankChange),
        ], i)))}
      `)
    })
  }

  // ---- Most improved ----
  let improvedBody
  if (!prevExamLabel) improvedBody = empty('There is no earlier exam to compare with.')
  else if (mostImproved.length === 0) improvedBody = empty('No student moved up compared with the previous exam.')
  else improvedBody = table(['#', 'Student', 'Adm. No.', 'Position', 'Mean Grade', 'Mean % change'], mostImproved.map((m, i) => row([
    i + 1,
    ptEsc(m.student.full_name),
    `<span style="color:#6B6558;">${ptEsc(m.student.admission_no)}</span>`,
    `${m.previousRank} → <strong>${m.currentRank}</strong> <span style="color:#3E6B4F;font-weight:700;">▲ ${m.change}</span>`,
    `${ptEsc(m.prevGrade || '–')} → <strong>${ptEsc(m.grade || '–')}</strong>`,
    m.scoreChange !== null && m.scoreChange !== undefined ? `${m.scoreChange > 0 ? '+' : ''}${m.scoreChange.toFixed(1)}` : '–',
  ], i)))
  bodies.push(`${title('Most Improved', prevExamLabel ? `Biggest climbs in class position since ${ptEsc(prevExamLabel)}` : '')}${improvedBody}`)

  // ---- Students who need help ----
  const helpSub = `Average below ${helpBelow}%, or dropped ${PT_NEEDS_HELP_RANK_DROP}+ places since the previous exam. Weak subjects are those scored below ${helpBelow}%.`
  if (needsHelp.length === 0) {
    bodies.push(`${title('Students Who Need Help', helpSub)}${empty('No student meets these criteria.')}`)
  } else {
    chunk(needsHelp, PT_HELP_ROWS_PER_PAGE).forEach((part, pi) => {
      bodies.push(`
        ${title('Students Who Need Help', pi === 0 ? helpSub : 'continued')}
        ${table(['Student', 'Adm. No.', 'Pos', 'Mean %', 'Grade', 'Why flagged', 'Weak subjects'], part.map((s, i) => row([
          `<strong>${ptEsc(s.student.full_name)}</strong>`,
          `<span style="color:#6B6558;">${ptEsc(s.student.admission_no)}</span>`,
          s.rank,
          s.meanScore !== null ? Math.round(s.meanScore) : '–',
          ptEsc(s.grade || '–'),
          `<span style="color:#B23A3A;">${s.reasons.map(ptEsc).join('<br/>')}</span>`,
          s.weakSubjects.length > 0 ? s.weakSubjects.map((w) => `${ptEsc(w.subject)} ${Math.round(w.score)}`).join(', ') : '–',
        ], i)))}
      `)
    })
  }

  const total = bodies.length
  return bodies.map((body, i) => `
    <div class="pt-page" style="width:794px;min-height:1120px;box-sizing:border-box;padding:34px 40px 60px;background:#fff;font-family:Arial,Helvetica,sans-serif;color:#1E2A24;position:relative;">
      <div style="border-bottom:2px solid #2C3E37;padding-bottom:8px;margin-bottom:18px;display:flex;justify-content:space-between;align-items:flex-end;">
        <div style="font-size:16px;font-weight:800;color:#2C3E37;">Performance Track — ${ptEsc(cohortLabel)}</div>
        <div style="font-size:11px;color:#6B6558;">${ptEsc(examLabel)}</div>
      </div>
      ${body}
      <div style="position:absolute;left:40px;right:40px;bottom:22px;font-size:10.5px;color:#8A8474;text-align:right;">Page ${i + 1} of ${total}</div>
    </div>`)
}

function buildPerformanceTrackWhatsAppText(cohortLabel, examLabel, mostImproved, rankings, needsHelp = []) {
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
  if (needsHelp.length > 0) {
    lines.push('')
    lines.push(`⚠ Need help (${needsHelp.length}):`)
    needsHelp.slice(0, 5).forEach((s) => lines.push(`• ${s.student.full_name} — ${s.reasons.join(', ')}`))
  }
  return lines.join('\n')
}

function PerformanceTrackScreen() {
  const { scale: gradeScale } = useGradeScale()
  const { scale: cbcScale } = useCbcScale()
  const [cohort, setCohort] = useState('form_4')
  const [exams, setExams] = useState([])
  const [selectedExamId, setSelectedExamId] = useState('')
  const [rankings, setRankings] = useState([])
  const [mostImproved, setMostImproved] = useState([])
  const [subjectMeans, setSubjectMeans] = useState([]) // [{ subjectId, name, meanPoints, grade, count }]
  const [classMean, setClassMean] = useState(null) // { points, grade }
  const [prevClassMean, setPrevClassMean] = useState(null) // same shape, previous exam
  const [studentStats, setStudentStats] = useState([]) // one entry per ranked student, see loadRankings
  const [helpBelow, setHelpBelow] = useState(40) // "needs help" if average mark is below this %
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const isNarrow = useIsNarrow()
  const isCbc = cohort === 'grade_10'
  const scale = isCbc ? cbcScale : gradeScale
  const maxScalePoints = Math.max(...scale.map((r) => r.points))

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

    const [{ data: current, error: rankError }, { data: students, error: studentsError }] = await Promise.all([
      supabase.rpc('compute_cohort_rankings', { p_cohort: cohort, p_exam_id: selectedExamId }),
      supabase.from('students').select('id, full_name, admission_no').eq('cohort', cohort).is('graduated_at', null),
    ])
    setLoadError(rankError ? `Ranking failed: ${rankError.message}` : studentsError ? `Couldn't load students: ${studentsError.message}` : '')
    const studentById = Object.fromEntries((students || []).map((s) => [s.id, s]))

    const currentRanked = (current || [])
      .map((r) => ({ ...r, student: studentById[r.student_id] }))
      .filter((r) => r.student)
      .sort((a, b) => a.rnk - b.rnk)
    setRankings(currentRanked)

    // Marks for this exam and the previous one, plus the previous ranking.
    const cohortStudentIds = (students || []).map((s) => s.id)
    let examMarks = [], prevMarks = [], previous = []
    if (cohortStudentIds.length > 0) {
      const marksFor = (examId) => supabase
        .from('marks').select('score, subject_id, student_id, subjects(name)')
        .eq('exam_id', examId).in('student_id', cohortStudentIds)
      const [cur, prv, prk] = await Promise.all([
        marksFor(selectedExamId),
        prevExam ? marksFor(prevExam.id) : Promise.resolve({ data: [] }),
        prevExam ? supabase.rpc('compute_cohort_rankings', { p_cohort: cohort, p_exam_id: prevExam.id }) : Promise.resolve({ data: [] }),
      ])
      examMarks = cur.data || []
      prevMarks = prv.data || []
      previous = prk.data || []
    }

    const usable = (m) => m.score !== null && m.score !== undefined && m.subjects?.name
    const groupBySubject = (rows) => {
      const out = {}
      rows.filter(usable).forEach((m) => {
        if (!out[m.subject_id]) out[m.subject_id] = { name: m.subjects.name, scores: [] }
        out[m.subject_id].scores.push(m.score)
      })
      return out
    }
    const groupByStudent = (rows) => {
      const out = {}
      rows.filter(usable).forEach((m) => {
        if (!out[m.student_id]) out[m.student_id] = []
        out[m.student_id].push({ subject: m.subjects.name, score: m.score })
      })
      return out
    }
    const round2 = (v) => Math.round(v * 100) / 100

    // Compiled subject means + overall class mean: every subject actually
    // marked for this cohort/exam, averaged, then averaged again across
    // subjects — "all the subject performance compiled into a class mean".
    const bySubject = groupBySubject(examMarks)
    const prevBySubject = groupBySubject(prevMarks)
    const means = Object.entries(bySubject).map(([subjectId, v]) => {
      const mp = meanPoints(v.scores, scale, isCbc)
      const pv = prevBySubject[subjectId] ? meanPoints(prevBySubject[subjectId].scores, scale, isCbc) : null
      return {
        subjectId,
        name: v.name,
        meanPoints: mp !== null ? round2(mp) : 0,
        grade: mp !== null ? gradeForMeanPoints(mp, scale) : null,
        count: v.scores.length,
        prevMeanPoints: pv !== null ? round2(pv) : null,
      }
    }).sort((a, b) => b.meanPoints - a.meanPoints)
    setSubjectMeans(means)
    if (means.length > 0) {
      const classMp = means.reduce((a, b) => a + b.meanPoints, 0) / means.length
      setClassMean({ points: round2(classMp), grade: gradeForMeanPoints(classMp, scale) })
    } else {
      setClassMean(null)
    }
    const prevPoints = Object.values(prevBySubject).map((v) => meanPoints(v.scores, scale, isCbc)).filter((v) => v !== null)
    if (prevPoints.length > 0) {
      const pm = prevPoints.reduce((a, b) => a + b, 0) / prevPoints.length
      setPrevClassMean({ points: round2(pm), grade: gradeForMeanPoints(pm, scale) })
    } else {
      setPrevClassMean(null)
    }

    // Per-student grade + movement since the previous exam.
    const curByStudent = groupByStudent(examMarks)
    const prevByStudentMarks = groupByStudent(prevMarks)
    const prevRankByStudent = Object.fromEntries(previous.map((r) => [r.student_id, r]))
    const summarize = (list) => {
      if (!list || list.length === 0) return null
      const scores = list.map((x) => x.score)
      const mp = meanPoints(scores, scale, isCbc)
      return {
        meanScore: scores.reduce((a, b) => a + b, 0) / scores.length,
        meanPoints: mp,
        grade: mp !== null ? gradeForMeanPoints(mp, scale) : null,
      }
    }
    const stats = currentRanked.map((r) => {
      const cur = summarize(curByStudent[r.student_id])
      const prv = summarize(prevByStudentMarks[r.student_id])
      const prevRank = prevRankByStudent[r.student_id] ? Number(prevRankByStudent[r.student_id].rnk) : null
      return {
        student: r.student,
        rank: Number(r.rnk),
        totalPoints: r.total_points,
        maxPoints: r.max_points,
        meanScore: cur ? cur.meanScore : null,
        meanPoints: cur ? cur.meanPoints : null,
        grade: cur ? cur.grade : null,
        subjects: curByStudent[r.student_id] || [],
        prevRank,
        rankChange: prevRank !== null ? prevRank - Number(r.rnk) : null, // positive = moved up
        prevMeanScore: prv ? prv.meanScore : null,
        prevGrade: prv ? prv.grade : null,
        scoreChange: cur && prv ? cur.meanScore - prv.meanScore : null,
      }
    })
    setStudentStats(stats)

    if (prevExam) {
      const improved = stats
        .filter((s) => s.rankChange !== null && s.rankChange > 0)
        .sort((a, b) => b.rankChange - a.rankChange)
        .slice(0, 10)
        .map((s) => ({
          student: s.student,
          currentRank: s.rank,
          previousRank: s.prevRank,
          change: s.rankChange,
          currentPoints: s.totalPoints,
          grade: s.grade,
          prevGrade: s.prevGrade,
          scoreChange: s.scoreChange,
        }))
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

  const prevExam = currentExam
    ? exams.filter((e) => e.order_index < currentExam.order_index).sort((a, b) => b.order_index - a.order_index)[0]
    : null
  const prevExamLabel = prevExam ? `${prevExam.name} — ${prevExam.term} ${prevExam.year}` : ''
  const needsHelp = ptFindNeedsHelp(studentStats, helpBelow)
  const statsById = Object.fromEntries(studentStats.map((s) => [s.student.id, s]))
  const trackData = { cohortLabel, examLabel, prevExamLabel, classMean, prevClassMean, subjectMeans, studentStats, mostImproved, needsHelp, helpBelow, maxScalePoints }

  // One A4 page per section chunk: class analysis, every student's grade,
  // most improved, students who need help.
  async function downloadPdf() {
    const pages = buildPerformanceTrackPages(trackData)
    const pdf = new jsPDF('p', 'mm', 'a4')
    const pageW = pdf.internal.pageSize.getWidth()
    const pageH = pdf.internal.pageSize.getHeight()
    for (let i = 0; i < pages.length; i++) {
      const container = document.createElement('div')
      container.style.position = 'fixed'
      container.style.left = '-9999px'
      container.style.top = '0'
      container.style.background = '#fff'
      container.innerHTML = pages[i]
      document.body.appendChild(container)
      const canvas = await html2canvas(container.firstElementChild, { scale: 2, backgroundColor: '#ffffff' })
      document.body.removeChild(container)
      if (i > 0) pdf.addPage()
      let w = pageW
      let h = (canvas.height * w) / canvas.width
      if (h > pageH) { h = pageH; w = (canvas.width * h) / canvas.height }
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, w, h)
    }
    pdf.save(`${cohortLabel.replace(/\s+/g, '_')}_${examLabel.replace(/[^\w]+/g, '_')}_Performance_Track.pdf`)
  }

  function printTrack() {
    const container = document.createElement('div')
    container.id = 'print-pt-container'
    container.innerHTML = buildPerformanceTrackPages(trackData).join('')
    const style = document.createElement('style')
    style.id = 'print-pt-style'
    style.innerHTML = `
      @media print {
        @page { size: A4; margin: 0; }
        body > *:not(#print-pt-container) { display: none !important; }
        #print-pt-container { display: block !important; }
        #print-pt-container .pt-page { page-break-after: always; break-after: page; }
        #print-pt-container .pt-page:last-child { page-break-after: auto; break-after: auto; }
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

  const whatsAppText = buildPerformanceTrackWhatsAppText(cohortLabel, examLabel, mostImproved, rankings, needsHelp)
  const whatsAppShareLink = `https://wa.me/?text=${encodeURIComponent(whatsAppText)}`

  return (
    <div style={pageWrap}>
      <h2>Performance Track</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginBottom: 20 }}>
        Class analysis, every student's grade, most-improved students and students who need help, compared against the previous exam. The PDF has several pages.
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

      {loadError && <p style={{ ...errorText, marginBottom: 16 }}>{loadError}</p>}
      {loading ? <p style={{ color: COLORS.muted }}>Loading...</p> : (
        <>
          <div style={{ marginBottom: 28 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={sectionLabel}>Subject Means</div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, color: COLORS.muted, fontWeight: 700, textTransform: 'uppercase' }}>Class Mean</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: COLORS.accent }}>{classMean !== null ? `${classMean.grade} (${classMean.points})` : '—'}</div>
              </div>
            </div>
            {subjectMeans.length === 0 ? (
              <div style={{ textAlign: 'center', color: COLORS.muted, padding: 20, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
                No marks recorded for this cohort/exam yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {subjectMeans.map((sm) => {
                  const pct = maxScalePoints > 0 ? Math.max(0, Math.min(100, (sm.meanPoints / maxScalePoints) * 100)) : 0
                  return (
                    <div key={sm.subjectId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12.5, width: 130, flexShrink: 0 }}>{sm.name}</span>
                      <div style={{ flex: 1, background: COLORS.ruleLight, borderRadius: 4, overflow: 'hidden', height: 14 }}>
                        <div style={{ width: `${pct}%`, background: COLORS.accent, height: '100%' }} />
                      </div>
                      <span style={{ fontSize: 12.5, fontWeight: 700, width: 34, textAlign: 'right', flexShrink: 0 }}>{sm.grade}</span>
                      <span style={{ fontSize: 11.5, color: COLORS.muted, width: 34, flexShrink: 0 }}>({sm.meanPoints})</span>
                      <span style={{ fontSize: 11, color: COLORS.muted, width: 60, flexShrink: 0 }}>({sm.count} entered)</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

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

          <div style={{ marginBottom: 28 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <div style={sectionLabel}>⚠ Students Who Need Help ({needsHelp.length})</div>
              <label style={fieldLabel}>Average below (%)
                <input
                  type="number" min="0" max="100" value={helpBelow}
                  onChange={(e) => setHelpBelow(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                  style={{ ...input, width: 90 }}
                />
              </label>
            </div>
            <p style={{ color: COLORS.muted, fontSize: 12, margin: '0 0 10px' }}>
              Flagged when their average mark is below {helpBelow}%, or they dropped {PT_NEEDS_HELP_RANK_DROP}+ places since the previous exam.
            </p>
            {needsHelp.length === 0 ? (
              <div style={{ textAlign: 'center', color: COLORS.muted, padding: 20, background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8 }}>
                No student meets these criteria.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {needsHelp.map((s) => (
                  <div key={s.student.id} style={{ background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: '10px 16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                      <div>
                        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{s.student.full_name}</span>
                        <span style={{ fontSize: 11.5, color: COLORS.muted, marginLeft: 8 }}>{s.student.admission_no}</span>
                      </div>
                      <div style={{ fontSize: 12.5 }}>
                        Position {s.rank} · {s.meanScore !== null ? `${Math.round(s.meanScore)}%` : '—'} · <strong>{s.grade || '—'}</strong>
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: COLORS.warn, marginTop: 4 }}>{s.reasons.join(' · ')}</div>
                    {s.weakSubjects.length > 0 && (
                      <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>
                        Weak subjects: {s.weakSubjects.map((w) => `${w.subject} ${Math.round(w.score)}`).join(', ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={sectionLabel}>Full Class Ranking</div>
          {isNarrow ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rankings.map((r) => (
                <div key={r.student_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: COLORS.card, border: `1px solid ${COLORS.ruleLight}`, borderRadius: 8, padding: '10px 14px' }}>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: 13.5 }}>{r.rnk}. {r.student.full_name}</span>
                    <div style={{ fontSize: 11, color: COLORS.muted }}>{r.student.admission_no}</div>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{r.total_points}/{r.max_points}{statsById[r.student_id]?.grade ? ` · ${statsById[r.student_id].grade}` : ''}</div>
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
                <thead><tr><th style={th}>Position</th><th style={th}>Student</th><th style={th}>Adm. No.</th><th style={th}>Total Points</th><th style={th}>Mean Grade</th></tr></thead>
                <tbody>
                  {rankings.map((r) => (
                    <tr key={r.student_id} style={{ borderTop: `1px solid ${COLORS.ruleLight}` }}>
                      <td style={{ ...td, fontWeight: 700 }}>{r.rnk}</td>
                      <td style={td}>{r.student.full_name}</td>
                      <td style={{ ...td, color: COLORS.muted }}>{r.student.admission_no}</td>
                      <td style={td}>{r.total_points} / {r.max_points}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{statsById[r.student_id]?.grade || '—'}</td>
                    </tr>
                  ))}
                  {rankings.length === 0 && (
                    <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: COLORS.muted, padding: 24 }}>No marks recorded for this cohort/exam yet.</td></tr>
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
      .from('students').select('*').eq('cohort', classLabel).is('graduated_at', null).order('full_name')
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

  async function handleDeleteTimetable() {
    if (filteredSlots.length === 0) { notify('Nothing to delete for the current filters.', 'error'); return }
    const scopeLabel = classFilter !== 'all' && teacherFilter !== 'all'
      ? `${CLASS_OPTIONS.find((c) => c.value === classFilter)?.label} entries for ${teachers.find((t) => t.id === teacherFilter)?.full_name}`
      : classFilter !== 'all'
        ? `the entire ${CLASS_OPTIONS.find((c) => c.value === classFilter)?.label} timetable`
        : teacherFilter !== 'all'
          ? `${teachers.find((t) => t.id === teacherFilter)?.full_name}'s entire timetable`
          : 'the entire school timetable'
    const confirmed = await confirmAction(
      `Delete ${scopeLabel}? This removes ${filteredSlots.length} entr${filteredSlots.length === 1 ? 'y' : 'ies'} and cannot be undone.`,
      { danger: true, confirmLabel: 'Delete' }
    )
    if (!confirmed) return
    const ids = filteredSlots.map((s) => s.id)
    const { error } = await supabase.from('timetable_slots').delete().in('id', ids)
    if (error) { notify(`Couldn't delete: ${error.message}`, 'error'); return }
    notify(`Deleted ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'}.`)
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

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18, alignItems: 'flex-end' }}>
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
        <button onClick={handleDeleteTimetable} style={{ ...secondaryBtn, color: COLORS.warn, borderColor: COLORS.warn, marginBottom: 14 }}>
          {classFilter === 'all' && teacherFilter === 'all' ? 'Delete Timetable' : 'Delete Filtered Entries'}
        </button>
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

// ============================================================================
// SETTINGS: Branding — upload school logo (used everywhere) and an optional
// custom receipt design (used as the background for generated receipts)
// ============================================================================
// Dummy data used only to render the live watermark previews in Settings —
// never saved or sent anywhere.
const SAMPLE_RECEIPT_PAYMENT = {
  id: 'sample1234', paid_at: new Date().toISOString(), amount: 15000, method: 'M-Pesa', reference_no: 'QK7X9ABC12', note: '',
}
const SAMPLE_RECEIPT_STUDENT = { full_name: 'Jane Sample Wanjiru', admission_no: 'PWA/2024/017', parent_name: 'Mary Wanjiru' }
const SAMPLE_RECEIPT_INVOICES = [{ amount: 45000 }]
const SAMPLE_RECEIPT_PAYMENTS = [{ amount: 15000 }]
const SAMPLE_REPORT = {
  exam: { name: 'End of Term Exam', term: 'Term 2', year: new Date().getFullYear(), term_resumes_on: null },
  isCbc: false,
  student: { full_name: 'Jane Sample Wanjiru', admission_no: 'PWA/2024/017', cohort: 'Form 3' },
  subjectRows: [
    { name: 'Mathematics', prevGrade: 'B', grade: 'B+', remark: 'Good improvement', is_compulsory: true },
    { name: 'English', prevGrade: 'B+', grade: 'B+', remark: 'Consistent', is_compulsory: true },
  ],
  aggregate: { total: 62, maxTotal: 84 },
  position: 5, outOf: 42,
  prevAggregate: { total: 58, maxTotal: 84 },
  prevPosition: 8, prevOutOf: 42,
  timeline: [],
  principalComment: 'Keep up the good work.',
  classTeacherComment: 'A pleasure to teach.',
}

function BrandingSettings() {
  const { notify } = useNotify()
  const {
    logoUrl, secondaryLogoUrl, receiptTemplateUrl,
    receiptWatermarkEnabled, receiptWatermarkOpacity, receiptWatermarkOffsetX, receiptWatermarkOffsetY,
    reportWatermarkEnabled, reportWatermarkOpacity, reportWatermarkOffsetX, reportWatermarkOffsetY,
    reload,
  } = useSchoolSettings()
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [uploadingSecondaryLogo, setUploadingSecondaryLogo] = useState(false)
  const [uploadingReceipt, setUploadingReceipt] = useState(false)

  // Local, editable copies for the design controls below — kept separate
  // from the saved context values so toggling/moving a control previews
  // live without writing to the database until "Save Design" is clicked.
  const [receiptEnabled, setReceiptEnabled] = useState(receiptWatermarkEnabled)
  const [receiptOpacity, setReceiptOpacity] = useState(receiptWatermarkOpacity)
  const [receiptOffsetX, setReceiptOffsetX] = useState(receiptWatermarkOffsetX)
  const [receiptOffsetY, setReceiptOffsetY] = useState(receiptWatermarkOffsetY)
  const [reportEnabled, setReportEnabled] = useState(reportWatermarkEnabled)
  const [reportOpacity, setReportOpacity] = useState(reportWatermarkOpacity)
  const [reportOffsetX, setReportOffsetX] = useState(reportWatermarkOffsetX)
  const [reportOffsetY, setReportOffsetY] = useState(reportWatermarkOffsetY)
  const [savingDesign, setSavingDesign] = useState(false)

  useEffect(() => {
    setReceiptEnabled(receiptWatermarkEnabled)
    setReceiptOpacity(receiptWatermarkOpacity)
    setReceiptOffsetX(receiptWatermarkOffsetX)
    setReceiptOffsetY(receiptWatermarkOffsetY)
    setReportEnabled(reportWatermarkEnabled)
    setReportOpacity(reportWatermarkOpacity)
    setReportOffsetX(reportWatermarkOffsetX)
    setReportOffsetY(reportWatermarkOffsetY)
  }, [receiptWatermarkEnabled, receiptWatermarkOpacity, receiptWatermarkOffsetX, receiptWatermarkOffsetY, reportWatermarkEnabled, reportWatermarkOpacity, reportWatermarkOffsetX, reportWatermarkOffsetY])

  const designDirty = (
    receiptEnabled !== receiptWatermarkEnabled || receiptOpacity !== receiptWatermarkOpacity || receiptOffsetX !== receiptWatermarkOffsetX || receiptOffsetY !== receiptWatermarkOffsetY ||
    reportEnabled !== reportWatermarkEnabled || reportOpacity !== reportWatermarkOpacity || reportOffsetX !== reportWatermarkOffsetX || reportOffsetY !== reportWatermarkOffsetY
  )

  async function saveDesignSettings() {
    setSavingDesign(true)
    await ensureSettingsRow()
    const { error } = await supabase.from('school_settings').update({
      receipt_watermark_enabled: receiptEnabled,
      receipt_watermark_opacity: receiptOpacity,
      receipt_watermark_offset_x: receiptOffsetX,
      receipt_watermark_offset_y: receiptOffsetY,
      report_watermark_enabled: reportEnabled,
      report_watermark_opacity: reportOpacity,
      report_watermark_offset_x: reportOffsetX,
      report_watermark_offset_y: reportOffsetY,
    }).eq('id', 1)
    setSavingDesign(false)
    if (error) { notify(`Couldn't save design settings: ${error.message}`, 'error'); return }
    notify('Design settings saved.')
    reload()
  }

  function resetDesignSettings() {
    setReceiptEnabled(true)
    setReceiptOpacity(DEFAULT_RECEIPT_WATERMARK_OPACITY)
    setReceiptOffsetX(0)
    setReceiptOffsetY(0)
    setReportEnabled(true)
    setReportOpacity(DEFAULT_REPORT_WATERMARK_OPACITY)
    setReportOffsetX(0)
    setReportOffsetY(0)
  }

  const previewReceiptCellHtml = buildReceiptCellHtml({
    payment: SAMPLE_RECEIPT_PAYMENT, student: SAMPLE_RECEIPT_STUDENT,
    invoices: SAMPLE_RECEIPT_INVOICES, payments: SAMPLE_RECEIPT_PAYMENTS,
    meta: { logoUrl, secondaryLogoUrl, receiptTemplateUrl: null, receiptWatermarkEnabled: receiptEnabled, receiptWatermarkOpacity: receiptOpacity, receiptWatermarkOffsetX: receiptOffsetX, receiptWatermarkOffsetY: receiptOffsetY },
  })
  const previewReportHtml = buildReportHtml(SAMPLE_REPORT, { enabled: reportEnabled, opacity: reportOpacity, offsetX: reportOffsetX, offsetY: reportOffsetY })

  async function ensureSettingsRow() {
    // The row (id=1) may not exist yet on a fresh install — create it once.
    await supabase.from('school_settings').upsert({ id: 1 }, { onConflict: 'id', ignoreDuplicates: true })
  }

  const uploaderByField = {
    logo_url: setUploadingLogo,
    secondary_logo_url: setUploadingSecondaryLogo,
    receipt_template_url: setUploadingReceipt,
  }

  async function uploadFile(file, field) {
    const setUploading = uploaderByField[field]
    setUploading(true)
    await ensureSettingsRow()
    const ext = file.name.split('.').pop()
    const path = `${field}-${Date.now()}.${ext}`
    const { error: uploadError } = await supabase.storage.from('branding').upload(path, file)
    if (uploadError) { notify(`Upload failed: ${uploadError.message}`, 'error'); setUploading(false); return }
    const { data } = supabase.storage.from('branding').getPublicUrl(path)
    const { error: updateError } = await supabase.from('school_settings').update({ [field]: data.publicUrl }).eq('id', 1)
    setUploading(false)
    if (updateError) { notify(`Couldn't save: ${updateError.message}`, 'error'); return }
    notify('Updated.')
    reload()
  }

  async function clearField(field) {
    const { error } = await supabase.from('school_settings').update({ [field]: null }).eq('id', 1)
    if (error) { notify(`Couldn't reset: ${error.message}`, 'error'); return }
    notify('Reset to default.')
    reload()
  }

  return (
    <div>
      <div style={sectionLabel}>School logo</div>
      <p style={{ color: COLORS.muted, fontSize: 12, marginBottom: 10 }}>
        Shown in the header everywhere in the app, and on the left side of the report card letterhead. Upload a square image for best results.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
        <img src={logoUrl} alt="Current logo" style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', border: `1px solid ${COLORS.ruleLight}` }} />
        <label style={{ ...secondaryBtn, cursor: 'pointer' }}>
          {uploadingLogo ? 'Uploading...' : 'Upload New Logo'}
          <input type="file" accept="image/*" style={{ display: 'none' }} disabled={uploadingLogo}
            onChange={(e) => e.target.files[0] && uploadFile(e.target.files[0], 'logo_url')} />
        </label>
        {logoUrl !== '/crest.png' && (
          <button onClick={() => clearField('logo_url')} style={{ ...secondaryBtn, color: COLORS.warn }}>Reset to Default</button>
        )}
      </div>

      <div style={sectionLabel}>Second logo (report card letterhead, right side)</div>
      <p style={{ color: COLORS.muted, fontSize: 12, marginBottom: 10 }}>
        Optional. Shown on the right of the school logo on report cards only — e.g. a Ministry of Education, CBC,
        or accreditation logo. Leave empty to show the school logo on both sides.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
        <img src={secondaryLogoUrl} alt="Second logo" style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', border: `1px solid ${COLORS.ruleLight}` }} />
        <label style={{ ...secondaryBtn, cursor: 'pointer' }}>
          {uploadingSecondaryLogo ? 'Uploading...' : 'Upload Second Logo'}
          <input type="file" accept="image/*" style={{ display: 'none' }} disabled={uploadingSecondaryLogo}
            onChange={(e) => e.target.files[0] && uploadFile(e.target.files[0], 'secondary_logo_url')} />
        </label>
        {secondaryLogoUrl !== '/crest.png' && (
          <button onClick={() => clearField('secondary_logo_url')} style={{ ...secondaryBtn, color: COLORS.warn }}>Reset to Default</button>
        )}
      </div>

      <div style={sectionLabel}>Custom receipt design</div>
      <p style={{ color: COLORS.muted, fontSize: 12, marginBottom: 10 }}>
        Optional. Upload your own receipt design (image) and it will be used as the background for every receipt
        the Bursar generates, with the payment details overlaid near the bottom. Leave this empty to use the
        built-in receipt design instead. For best results, leave blank space near the bottom of your design for
        the overlaid details.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {receiptTemplateUrl ? (
          <img src={receiptTemplateUrl} alt="Custom receipt design" style={{ width: 80, height: 'auto', border: `1px solid ${COLORS.ruleLight}`, borderRadius: 4 }} />
        ) : (
          <div style={{ width: 80, height: 56, border: `1px dashed ${COLORS.ruleLight}`, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: COLORS.muted, textAlign: 'center' }}>
            Using default design
          </div>
        )}
        <label style={{ ...secondaryBtn, cursor: 'pointer' }}>
          {uploadingReceipt ? 'Uploading...' : 'Upload Receipt Design'}
          <input type="file" accept="image/*" style={{ display: 'none' }} disabled={uploadingReceipt}
            onChange={(e) => e.target.files[0] && uploadFile(e.target.files[0], 'receipt_template_url')} />
        </label>
        {receiptTemplateUrl && (
          <button onClick={() => clearField('receipt_template_url')} style={{ ...secondaryBtn, color: COLORS.warn }}>Remove (Use Default)</button>
        )}
      </div>

      <div style={{ borderTop: `1px solid ${COLORS.ruleLight}`, margin: '28px 0' }} />

      <div style={sectionLabel}>Receipt &amp; report card watermark design</div>
      <p style={{ color: COLORS.muted, fontSize: 12, marginBottom: 16 }}>
        Controls the faint background school-logo watermark on the built-in receipt design (used by non-teaching
        staff / Bursar) and on student report cards (KCSE &amp; CBC). The watermark sits behind the payment details
        so it reads as a genuine background rather than being hidden behind them. Tick "Remove watermark" to turn
        it off entirely, or adjust opacity and how far it sits from center (left/right and up/down) — check the
        live preview below before saving. This does not affect a custom uploaded receipt design (above), which has
        no watermark.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24, marginBottom: 16 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Receipt watermark</div>
            <label style={{ fontSize: 12, color: COLORS.muted, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={!receiptEnabled} onChange={(e) => setReceiptEnabled(!e.target.checked)} />
              Remove watermark
            </label>
          </div>
          <label style={{ ...fieldLabel, opacity: receiptEnabled ? 1 : 0.4 }}>Opacity — {Math.round(receiptOpacity * 100)}%
            <input type="range" min={0} max={0.4} step={0.01} value={receiptOpacity} disabled={!receiptEnabled}
              onChange={(e) => setReceiptOpacity(Number(e.target.value))} style={{ width: '100%' }} />
          </label>
          <label style={{ ...fieldLabel, marginTop: 10, opacity: receiptEnabled ? 1 : 0.4 }}>Horizontal position — {receiptOffsetX > 0 ? `${receiptOffsetX}px right` : receiptOffsetX < 0 ? `${Math.abs(receiptOffsetX)}px left` : 'centered'}
            <input type="range" min={-150} max={150} step={5} value={receiptOffsetX} disabled={!receiptEnabled}
              onChange={(e) => setReceiptOffsetX(Number(e.target.value))} style={{ width: '100%' }} />
          </label>
          <label style={{ ...fieldLabel, marginTop: 10, opacity: receiptEnabled ? 1 : 0.4 }}>Vertical position — {receiptOffsetY > 0 ? `${receiptOffsetY}px down` : receiptOffsetY < 0 ? `${Math.abs(receiptOffsetY)}px up` : 'centered'}
            <input type="range" min={-100} max={100} step={5} value={receiptOffsetY} disabled={!receiptEnabled}
              onChange={(e) => setReceiptOffsetY(Number(e.target.value))} style={{ width: '100%' }} />
          </label>
          <div style={{ marginTop: 12, width: 260, height: 367, overflow: 'hidden', border: `1px solid ${COLORS.ruleLight}`, borderRadius: 6 }}>
            <div style={{ width: 260, height: 367 }} dangerouslySetInnerHTML={{ __html: previewReceiptCellHtml }} />
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Report card watermark</div>
            <label style={{ fontSize: 12, color: COLORS.muted, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={!reportEnabled} onChange={(e) => setReportEnabled(!e.target.checked)} />
              Remove watermark
            </label>
          </div>
          <label style={{ ...fieldLabel, opacity: reportEnabled ? 1 : 0.4 }}>Opacity — {Math.round(reportOpacity * 100)}%
            <input type="range" min={0} max={0.4} step={0.01} value={reportOpacity} disabled={!reportEnabled}
              onChange={(e) => setReportOpacity(Number(e.target.value))} style={{ width: '100%' }} />
          </label>
          <label style={{ ...fieldLabel, marginTop: 10, opacity: reportEnabled ? 1 : 0.4 }}>Horizontal position — {reportOffsetX > 0 ? `${reportOffsetX}px right` : reportOffsetX < 0 ? `${Math.abs(reportOffsetX)}px left` : 'centered'}
            <input type="range" min={-150} max={150} step={5} value={reportOffsetX} disabled={!reportEnabled}
              onChange={(e) => setReportOffsetX(Number(e.target.value))} style={{ width: '100%' }} />
          </label>
          <label style={{ ...fieldLabel, marginTop: 10, opacity: reportEnabled ? 1 : 0.4 }}>Vertical position — {reportOffsetY > 0 ? `${reportOffsetY}px down` : reportOffsetY < 0 ? `${Math.abs(reportOffsetY)}px up` : 'default'}
            <input type="range" min={-200} max={200} step={10} value={reportOffsetY} disabled={!reportEnabled}
              onChange={(e) => setReportOffsetY(Number(e.target.value))} style={{ width: '100%' }} />
          </label>
          <div style={{ marginTop: 12, width: 260, height: 240, overflow: 'auto', border: `1px solid ${COLORS.ruleLight}`, borderRadius: 6 }}>
            <div style={{ width: 780, transform: 'scale(0.333)', transformOrigin: 'top left' }} dangerouslySetInnerHTML={{ __html: previewReportHtml }} />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={saveDesignSettings} disabled={savingDesign || !designDirty} style={btn}>
          {savingDesign ? 'Saving...' : 'Save Design Settings'}
        </button>
        <button onClick={resetDesignSettings} style={secondaryBtn}>Reset to Defaults</button>
      </div>
    </div>
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

      <BrandingSettings />
      <div style={{ borderTop: `1px solid ${COLORS.ruleLight}`, margin: '28px 0' }} />

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
        <SchoolSettingsProvider>
          <GradeScaleProvider>
            <CbcScaleProvider>
              <ConcurrentGroupsProvider>
                <AppContent />
              </ConcurrentGroupsProvider>
            </CbcScaleProvider>
          </GradeScaleProvider>
        </SchoolSettingsProvider>
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
    if ((profile.role === 'teacher' || profile.role === 'finance') && profile.status !== 'approved') {
      return <PendingApproval fullName={profile.full_name} onLogout={handleLogout} />
    }
    if (profile.role === 'finance') {
      return <FinanceHome profile={profile} onLogout={handleLogout} />
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
            {tab === 'Graduation' && <GraduationScreen profile={profile} />}
            {tab === 'Finance' && FINANCE_VISIBLE_TITLES.includes(profile.title) && <AdminFinanceScreen profile={profile} />}
            {tab === 'My Teaching' && <AdminTeachingScreen profile={profile} />}
            {tab === 'Approvals' && <ApprovalsScreen currentUserId={profile.id} viewerTitle={profile.title} />}
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