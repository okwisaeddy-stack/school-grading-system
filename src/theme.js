// src/theme.js

export const COLORS = {
  paper: '#F7F5EF',
  card: '#FFFFFF',
  ink: '#1E2A24',
  band: '#2C3E37',
  bandText: '#F4F1E8',
  rule: '#C9C2AE',
  ruleLight: '#E4DFD1',
  accent: '#9C6B2E',
  accentSoft: '#E9DDC6',
  good: '#3E6B4F',
  goodSoft: '#E4EEE7',
  warn: '#B0442E',
  warnSoft: '#F6E4DF',
  muted: '#6B6558',
}

export const wrap = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'sans-serif',
  background: COLORS.paper,
}

export const card = {
  width: 340,
  padding: 28,
  border: `1px solid ${COLORS.ruleLight}`,
  borderRadius: 10,
  background: COLORS.card,
}

export const input = {
  width: '100%',
  padding: 10,
  marginBottom: 10,
  border: '1px solid #ccc',
  borderRadius: 6,
  boxSizing: 'border-box',
}

export const btn = {
  padding: '10px 18px',
  background: COLORS.band,
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
}

export const secondaryBtn = {
  padding: '8px 16px',
  background: COLORS.card,
  color: COLORS.ink,
  border: `1px solid ${COLORS.rule}`,
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
}

export const errorText = {
  color: COLORS.warn,
  fontSize: 12,
}

export const link = {
  color: COLORS.accent,
  cursor: 'pointer',
}

export const pageWrap = {
  maxWidth: 1080,
  margin: '0 auto',
  padding: 'clamp(14px, 4vw, 28px) clamp(12px, 4vw, 20px)',
  fontFamily: 'sans-serif',
}

export const th = {
  textAlign: 'left',
  padding: '10px 14px',
  fontSize: 11,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
  color: COLORS.muted,
  background: COLORS.paper,
}

export const td = {
  padding: '10px 14px',
  fontSize: 13,
}

export const modalOverlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(30,42,36,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
  zIndex: 150,
}

export const modalCard = {
  background: '#fff',
  borderRadius: 10,
  padding: 'clamp(14px, 4vw, 24px)',
  width: '100%',
  maxWidth: 'min(560px, 94vw)',
  maxHeight: '90vh',
  overflowY: 'auto',
  fontFamily: 'sans-serif',
  boxSizing: 'border-box',
}

export const fieldLabel = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 12,
  color: COLORS.muted,
  fontWeight: 600,
}

export const sectionLabel = {
  fontSize: 12,
  color: COLORS.muted,
  fontWeight: 700,
  textTransform: 'uppercase',
  marginBottom: 6,
}

export const pillStatic = {
  padding: '5px 12px',
  borderRadius: 14,
  fontSize: 12,
  fontWeight: 600,
  background: COLORS.accentSoft,
  color: COLORS.accent,
  border: `1px solid ${COLORS.accent}`,
}

export function pillBtn(active) {
  return {
    padding: '5px 12px',
    borderRadius: 14,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    background: active ? COLORS.band : COLORS.paper,
    color: active ? '#fff' : COLORS.ink,
    border: `1px solid ${active ? COLORS.band : COLORS.ruleLight}`,
  }
}