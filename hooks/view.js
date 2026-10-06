// Builds the /usagemeter pane from plain state. Takes the resolved elements
// (`$.ui.resolve(e)`), never `$`, so it stays a pure function of its input.
import { barChart, meter, splitBar } from './charts.js'
import {
  GROUPS,
  RANGE_LABELS,
  clockLabel,
  duration,
  money,
  percent,
  pointLabel,
  providerColor,
  providerLabel,
  tokens,
} from './format.js'

const WIDE = 100
const SIDE = 40

/** Draws a list of segment rows (from charts.js) as Text lines. */
function lines(el, rows, key) {
  const { Box, Text } = el
  return rows.map((row, i) =>
    Box({
      key: key + '-' + i,
      flexDirection: 'row',
      children: row.map((seg) =>
        Text({
          ...(seg.color ? { color: seg.color } : {}),
          ...(seg.dim ? { dimColor: true } : {}),
          ...(seg.bold ? { bold: true } : {}),
          wrap: 'truncate',
          children: [seg.text],
        }),
      ),
    }),
  )
}

const text = (el, value, props = {}) => el.Text({ wrap: 'truncate', ...props, children: [value] })
const row = (el, children, props = {}) => el.Box({ flexDirection: 'row', ...props, children })
const col = (el, children, props = {}) => el.Box({ flexDirection: 'column', ...props, children })
const blank = (el) => text(el, ' ')

function header(el, s) {
  const { Button } = el
  const tab = (id, label, hotkey) =>
    Button({ key: 'tab-' + id, label, hotkey, plain: true, ...(s.tab === id ? {} : { dimColor: true }), onPress: () => s.act.tab(id) })
  return row(el, [
    tab('cost', 'Cost', '1'),
    tab('tokens', 'Tokens', '2'),
    tab('limits', 'Limits', '3'),
    text(el, '│', { dimColor: true }),
    Button({ key: 'range', label: RANGE_LABELS[s.range], hotkey: 'r', plain: true, onPress: () => s.act.cycleRange() }),
    Button({ key: 'group', label: 'by ' + s.group, hotkey: 'g', plain: true, onPress: () => s.act.cycleGroup() }),
    Button({ key: 'refresh', label: s.busy ? 'refreshing…' : 'refresh', hotkey: 'u', plain: true, onPress: () => s.act.refresh() }),
  ], { columnGap: 2 })
}

function footer(el, s) {
  const parts = []
  if (s.usage) {
    parts.push('Updated ' + clockLabel(s.usage.readAt, s.nowMs, s.usage.timeZone))
    parts.push('scan ' + (s.usage.scanMs / 1000).toFixed(1) + 's')
    if (s.usage.rates.status === 'stale' || s.usage.rates.status === 'unavailable') parts.push('prices ' + s.usage.rates.status)
  }
  parts.push('API estimate at list prices')
  return text(el, parts.join(' · '), { dimColor: true })
}

/** The headline and per-provider list on the left (or top) of the Cost and Tokens tabs. */
/** The headline and one entry per provider, each value right-aligned to `width`. */
function summary(el, s, range, metric, width) {
  const total = range.total
  const head = metric === 'cost' ? money(total.costUsd) : tokens(total.tokens)
  const children = [
    text(el, head, { bold: true, color: '#aab4e6' }),
    text(el, total.sessions + ' sessions' + (metric === 'cost' ? ' · API estimate' : ''), { dimColor: true }),
    blank(el),
  ]
  const whole = metric === 'cost' ? total.costUsd : total.tokens
  for (const p of range.providers) {
    const value = metric === 'cost' ? money(p.costUsd) : tokens(p.tokens)
    const other = metric === 'cost' ? tokens(p.tokens) + ' tokens' : money(p.costUsd)
    const name = providerLabel(p.provider) + ' '
    const sessions = p.sessions + ' sessions'
    const gap = Math.max(2, width - 2 - name.length - sessions.length - value.length)
    children.push(row(el, [
      text(el, '● ', { color: providerColor(p.provider) }),
      text(el, name),
      text(el, sessions, { dimColor: true }),
      text(el, ' '.repeat(gap) + value, { bold: true }),
    ]))
    children.push(text(el, percent(metric === 'cost' ? p.costUsd : p.tokens, whole) + ' of ' + metric + ' · ' + other, { dimColor: true }))
    children.push(blank(el))
  }
  children.pop()
  return col(el, children)
}

function chart(el, s, range, metric, width, height) {
  const columns = range.points.map((point) => ({
    total: metric === 'cost' ? point.costUsd : point.tokens,
    label: pointLabel(point, range.resolution, s.usage.timeZone),
    parts: Object.entries(point.providers).map(([provider, slice]) => ({
      key: provider,
      value: metric === 'cost' ? slice.costUsd : slice.tokens,
      color: providerColor(provider),
    })),
  }))
  const { rows } = barChart({ columns, width, height, format: metric === 'cost' ? (n) => '$' + compact(n) : tokens })
  const title = (range.resolution === 'hour' ? 'Hourly ' : 'Daily ') + (metric === 'cost' ? 'cost' : 'processed tokens')
  return col(el, [text(el, title, { bold: true }), ...lines(el, rows, 'chart')])
}

/** `$1.2K`, `$350`: short money for chart axes and bar labels. */
function compact(n) {
  if (n === 0) return '0'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  if (n >= 100) return Math.round(n).toString()
  if (n >= 1) return n.toFixed(1)
  return n.toFixed(2)
}

function totals(el, range, metric, width) {
  const t = range.total
  // Five cells share the width; a narrow pane gets the short labels.
  const cellW = Math.max(8, Math.floor(width / 5))
  const short = cellW < 17
  const cells = [
    [short ? 'Processed' : 'Processed tokens', tokens(t.tokens)],
    [short ? 'Cached' : 'Cached input', tokens(t.cachedInput)],
    [short ? 'Uncached' : 'Uncached input', tokens(t.uncachedInput)],
    ['Output', tokens(t.output)],
    metric === 'cost' ? [short ? 'Savings' : 'Cache savings', money(t.savingsUsd)] : [short ? 'Writes' : 'Cache write', tokens(t.cacheWrite)],
  ]
  return col(el, [
    text(el, 'Totals', { bold: true }),
    row(el, cells.map(([k]) => text(el, k.padEnd(cellW).slice(0, cellW), { dimColor: true }))),
    row(el, cells.map(([, v]) => text(el, v.padEnd(cellW).slice(0, cellW), { bold: true }))),
  ])
}

const TYPE_COLORS = { input: '#7f87b8', cacheRead: '#5c6288', cacheWrite: '#9aa3d6', output: '#c9cff5', other: '#555a72' }

function legend(el, entries, key) {
  return row(el, entries.map(([label, value, color], i) =>
    row(el, [text(el, '■ ', { color }), text(el, label + ' ', { dimColor: true }), text(el, value)], { key: key + i }),
  ), { columnGap: 2, flexWrap: 'wrap' })
}

function byType(el, range, metric, width) {
  if (metric === 'cost') {
    const c = range.categoryCost
    const parts = [['Input', c.input, TYPE_COLORS.input], ['Cache read', c.cacheRead, TYPE_COLORS.cacheRead], ['Cache write', c.cacheWrite, TYPE_COLORS.cacheWrite], ['Output', c.output, TYPE_COLORS.output], ['Other', c.other, TYPE_COLORS.other]]
    const sp = range.speed
    return col(el, [
      text(el, 'Cost by type', { bold: true }),
      ...lines(el, [splitBar(parts.map(([, value, color]) => ({ value, color })), width)], 'type'),
      legend(el, parts.filter(([, v]) => Math.abs(v) >= 0.005).map(([l, v, c]) => [l, money(v), c]), 'type-legend'),
      blank(el),
      row(el, [text(el, 'Cost by speed', { bold: true }), text(el, sp.premium > 0 ? '   premium ' + money(sp.premium) : '', { dimColor: true })]),
      legend(el, [['Standard', money(sp.standard), TYPE_COLORS.input], ...(sp.fast > 0 ? [['Fast', money(sp.fast), '#e0a060']] : []), ...(sp.ultrafast > 0 ? [['Ultrafast', money(sp.ultrafast), '#e06060']] : [])], 'speed'),
    ])
  }
  const t = range.total
  const parts = [['Input', t.uncachedInput, TYPE_COLORS.input], ['Cache read', t.cachedInput, TYPE_COLORS.cacheRead], ['Cache write', t.cacheWrite, TYPE_COLORS.cacheWrite], ['Output', t.output, TYPE_COLORS.output]]
  return col(el, [
    text(el, 'Tokens by type', { bold: true }),
    ...lines(el, [splitBar(parts.map(([, value, color]) => ({ value, color })), width)], 'type'),
    legend(el, parts.map(([l, v, c]) => [l, tokens(v), c]), 'type-legend'),
  ])
}

/** Rows of the breakdown table for the chosen grouping. */
export function breakdownRows(range, group, timeZone) {
  if (group === 'provider') return range.providers.map((p) => ({ label: providerLabel(p.provider), provider: p.provider, costUsd: p.costUsd, tokens: p.tokens }))
  if (group === 'day') {
    return [...range.points].reverse().filter((p) => p.tokens > 0 || p.costUsd > 0).map((p) => ({
      label: pointLabel(p, range.resolution, timeZone),
      provider: Object.entries(p.providers).sort((a, b) => b[1].costUsd - a[1].costUsd)[0]?.[0],
      costUsd: p.costUsd,
      tokens: p.tokens,
    }))
  }
  return range.models.map((m) => ({ label: m.model, provider: m.provider, costUsd: m.costUsd, tokens: m.tokens, unpriced: m.unpriced }))
}

function breakdown(el, s, range, metric, width) {
  const rows = breakdownRows(range, s.group, s.usage.timeZone)
  const whole = metric === 'cost' ? range.total.costUsd : range.total.tokens
  const nameW = Math.max(16, width - 34)
  const children = [
    text(el, 'Breakdown · by ' + s.group, { bold: true }),
    text(el, '  #  ' + (s.group === 'day' ? (range.resolution === 'hour' ? 'Hour' : 'Day') : s.group === 'provider' ? 'Provider' : 'Model').padEnd(nameW) + 'Cost'.padStart(11) + 'Share'.padStart(8) + 'Tokens'.padStart(9), { dimColor: true }),
  ]
  rows.slice(0, 20).forEach((r, i) => {
    children.push(row(el, [
      text(el, String(i + 1).padStart(3) + '  ', { dimColor: true }),
      text(el, '● ', { color: providerColor(r.provider) }),
      text(el, r.label.padEnd(nameW - 2).slice(0, nameW - 2)),
      text(el, (r.unpriced ? 'Unpriced' : money(r.costUsd)).padStart(11), r.unpriced ? { dimColor: true } : {}),
      text(el, percent(metric === 'cost' ? r.costUsd : r.tokens, whole).padStart(8), { dimColor: true }),
      text(el, tokens(r.tokens).padStart(9)),
    ]))
  })
  if (rows.length > 20) children.push(text(el, '     … ' + (rows.length - 20) + ' more', { dimColor: true }))
  return col(el, children)
}

function usageTab(el, s, width) {
  if (!s.usage) {
    return text(el, s.error ? 'Could not read usage: ' + s.error : 'Scanning local history… the first scan of 90 days can take a minute.', { dimColor: !s.error, ...(s.error ? { color: 'red' } : {}) })
  }
  const range = s.usage.ranges[s.range]
  const metric = s.tab
  const wide = width >= WIDE
  const chartW = wide ? width - SIDE - 3 : width
  // Side by side, the chart (title, bars, x labels) is as tall as the summary
  // (headline, sessions, blank, then three rows per provider less the last blank).
  const sideHeight = Math.max(8, Math.min(16, 3 * range.providers.length))
  const top = wide
    ? row(el, [col(el, [summary(el, s, range, metric, SIDE)], { width: SIDE }), chart(el, s, range, metric, chartW, sideHeight)], { columnGap: 3 })
    : col(el, [summary(el, s, range, metric, Math.min(width, SIDE)), blank(el), chart(el, s, range, metric, chartW, 10)])
  return col(el, [
    top,
    blank(el),
    totals(el, range, metric, Math.min(width, 90)),
    blank(el),
    byType(el, range, metric, Math.min(width, 80)),
    blank(el),
    breakdown(el, s, range, metric, Math.min(width, 90)),
  ])
}

/** `↗` when a window is being used faster than it elapses, `↘` when slower. */
function pace(window, nowMs) {
  if (!window.resetsAt || !window.windowMins) return ''
  const left = Date.parse(window.resetsAt) - nowMs
  const elapsed = 1 - left / (window.windowMins * 60000)
  if (!(elapsed > 0.05 && elapsed <= 1)) return ''
  const delta = window.usedPercent - elapsed * 100
  return delta > 5 ? ' ↗' : delta < -5 ? ' ↘' : ' →'
}

function limitsTab(el, s, width) {
  const groups = []
  const accounts = s.limits?.accounts ?? []
  const byProvider = new Map()
  for (const account of accounts) {
    const list = byProvider.get(account.provider) ?? []
    list.push(account)
    byProvider.set(account.provider, list)
  }
  // Without a Claude account from the hub, fall back to this session's own reading.
  if (!byProvider.has('claude') && s.claudeNative?.length) {
    byProvider.set('claude', [{ provider: 'claude', label: 'this session', windows: s.claudeNative }])
  }
  // Label, percent (9), pace (3) and reset text share the row with the meter.
  // A narrow pane gets a shorter label and only the time left before reset.
  const narrow = width < 90
  const labelW = narrow ? 14 : 26
  const resetW = narrow ? 11 : 28
  const barW = Math.max(4, Math.min(60, width - (labelW + 12 + resetW)))
  for (const [provider, list] of byProvider) {
    groups.push(text(el, provider === 'claude' ? 'Claude' : providerLabel(provider), { bold: true, color: providerColor(provider) }))
    for (const account of list) {
      const extra = [account.plan, account.resetCredits ? account.resetCredits + ' reset' + (account.resetCredits > 1 ? 's' : '') + ' banked' : null].filter(Boolean).join(' · ')
      if (list.length > 1 || extra || account.label === 'this session') groups.push(text(el, '  ' + account.label + (extra ? ' · ' + extra : ''), { dimColor: true }))
      if (account.error) groups.push(text(el, '  ' + account.error, { color: 'red' }))
      for (const w of account.windows) {
        const left = Math.max(0, 100 - w.usedPercent)
        const until = w.resetsAt ? '↻ ' + duration(Date.parse(w.resetsAt) - s.nowMs) : ''
        const reset = w.resetsAt && !narrow ? until + ' · ' + clockLabel(w.resetsAt, s.nowMs, s.timeZone) : until
        groups.push(row(el, [
          // At least one space always separates the label from the percent.
          text(el, '  ' + w.label.slice(0, labelW - 3).padEnd(labelW - 2)),
          text(el, (Math.round(left) + '% left').padStart(9), { bold: true }),
          text(el, (pace(w, s.nowMs) || '  ').padEnd(3), { dimColor: true }),
          ...lines(el, [meter(left / 100, barW, providerColor(provider))], 'meter-' + w.id),
          text(el, ('  ' + reset).padEnd(resetW).slice(0, resetW), { dimColor: true }),
        ]))
      }
    }
    groups.push(blank(el))
  }
  if (groups.length === 0) {
    groups.push(text(el, s.limitsBusy ? 'Reading limits…' : 'No limits to show yet.', { dimColor: true }))
  }
  const notes = []
  const hub = s.limits?.hub
  if (hub?.status === 'off') notes.push('CLIProxyAPI hub not configured: set hubUrl and hubKey with /plugin configure usagemeter.')
  if (hub?.status === 'error') notes.push('CLIProxyAPI hub: ' + hub.message)
  const go = s.limits?.openCodeGo
  if (go?.status === 'error' || go?.status === 'unsupported') notes.push('OpenCode Go: ' + go.message)
  if (s.limitsError) notes.push('Limits: ' + s.limitsError)
  if (s.limits?.checkedAt) notes.push('Checked ' + clockLabel(s.limits.checkedAt, s.nowMs, s.timeZone))
  return col(el, [...groups, ...notes.map((n) => text(el, n, { dimColor: true }))])
}

export function renderPane(el, s) {
  const width = Math.max(40, s.width)
  const body = s.tab === 'limits' ? limitsTab(el, s, width) : usageTab(el, s, width)
  return col(el, [header(el, s), blank(el), body, blank(el), s.tab === 'limits' ? text(el, ' ') : footer(el, s)])
}

export const nextOf = (list, value) => list[(list.indexOf(value) + 1) % list.length]
export { GROUPS }
