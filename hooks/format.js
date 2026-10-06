// Number, time and label formatting shared by the views.

export const PROVIDERS = {
  claude: { label: 'Claude Code', color: '#d97757' },
  codex: { label: 'Codex', color: '#c5c8e0' },
  opencode: { label: 'OpenCode', color: '#5fa8d3' },
  antigravity: { label: 'Antigravity', color: '#9b7fd4' },
  cursor: { label: 'Cursor', color: '#8fbf7f' },
  grok: { label: 'Grok', color: '#e0c060' },
  'opencode-go': { label: 'OpenCode Go', color: '#5fa8d3' },
}

export const providerLabel = (p) => PROVIDERS[p]?.label ?? p
export const providerColor = (p) => PROVIDERS[p]?.color ?? '#999999'

export function money(n) {
  const abs = Math.abs(n)
  const digits = abs > 0 && abs < 0.01 ? 4 : 2
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function tokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(Math.round(n))
}

export const percent = (part, whole) => (whole > 0 ? ((100 * part) / whole).toFixed(1) : '0.0') + '%'

/** `3d 14h`, `1h 32m`, `12m`: the two largest units of a duration. */
export function duration(ms) {
  if (!(ms > 0)) return 'now'
  const m = Math.floor(ms / 60000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (d > 0) return d + 'd ' + h + 'h'
  if (h > 0) return h + 'h ' + mm + 'm'
  return mm + 'm'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Oct 5` for a `YYYY-MM-DD` day. */
export function dayLabel(day) {
  const [, m, d] = day.split('-').map(Number)
  return MONTHS[m - 1] + ' ' + d
}

/** `14:00` for an ISO hour, in the given zone. */
export function hourLabel(iso, timeZone) {
  try {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone })
  } catch {
    return iso.slice(11, 16)
  }
}

export const pointLabel = (point, resolution, timeZone) =>
  resolution === 'hour' ? hourLabel(point.key, timeZone) : dayLabel(point.key)

/** `22:50` today, or `Oct 11 22:00` on another day, in the given zone. */
export function clockLabel(iso, nowMs, timeZone) {
  const date = new Date(iso)
  const opts = { timeZone }
  try {
    const time = date.toLocaleTimeString('en-GB', { ...opts, hour: '2-digit', minute: '2-digit' })
    const day = (d) => d.toLocaleDateString('en-CA', opts)
    if (day(date) === day(new Date(nowMs))) return time
    return date.toLocaleDateString('en-US', { ...opts, month: 'short', day: 'numeric' }) + ' ' + time
  } catch {
    return iso.slice(0, 16).replace('T', ' ')
  }
}

export const RANGE_LABELS = { '24h': 'Past 24h', '7d': '7 days', '30d': '30 days', '90d': '90 days' }
export const RANGES = ['24h', '7d', '30d', '90d']
export const GROUPS = ['model', 'provider', 'day']
