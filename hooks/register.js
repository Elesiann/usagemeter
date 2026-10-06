// ledger: a /ledger pane with cost, tokens and plan limits.
//
// The heavy lifting (reading gigabytes of local transcripts, pricing them,
// asking the CLIProxyAPI hub for limits) happens in helper/dist/ledger-helper.mjs,
// which this module runs with $.process.run. This file keeps the pane's state
// and draws it through view.js.
import { GROUPS, RANGES } from './format.js'
import { nextOf, renderPane } from './view.js'

const PANE = 'ledger'
/** A snapshot older than this is refreshed when the pane opens. */
const STALE_MS = 5 * 60 * 1000
/** A cold 90-day scan reads every transcript once; later scans reuse the helper's cache. */
const SCAN_TIMEOUT_MS = 10 * 60 * 1000
const LIMITS_TIMEOUT_MS = 60 * 1000

let config = {}
let tab = 'cost'
let range = '7d'
let group = 'model'
/** Index of the selected point in the current range; null follows the latest one. */
let cursor = null
let usage = null
let usageError = null
let scanning = false
let limits = null
let limitsError = null
let limitsBusy = false
/** This session's own Claude rate limits, the fallback when the hub has no Claude account. */
let claudeNative = []

const CLAUDE_WINDOWS = {
  five_hour: { label: 'Session', kind: 'session', windowMins: 300 },
  seven_day: { label: 'Weekly', kind: 'weekly', windowMins: 7 * 24 * 60 },
  spend_limit: { label: 'Spend limit', kind: 'other' },
}

function nativeWindows(rateLimits) {
  return (rateLimits ?? []).map((limit) => ({
    id: limit.kind,
    label: CLAUDE_WINDOWS[limit.kind]?.label ?? limit.kind,
    kind: CLAUDE_WINDOWS[limit.kind]?.kind ?? 'other',
    usedPercent: limit.percentUsed,
    ...(CLAUDE_WINDOWS[limit.kind]?.windowMins ? { windowMins: CLAUDE_WINDOWS[limit.kind].windowMins } : {}),
    ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
  }))
}

function parseOutput(stdout) {
  const line = stdout.trim().split('\n').at(-1)
  try {
    return line ? JSON.parse(line) : null
  } catch {
    return null
  }
}

const failure = (result, doc) =>
  doc?.error || result.stderr.trim().split('\n').at(-1) || 'the helper exited with code ' + result.exitCode

async function refreshUsage($) {
  if (scanning) return
  scanning = true
  usageError = null
  $.ui.invalidate('ui.render')
  try {
    const result = await $.process.run(['node', '--no-warnings', $.plugin.root + '/helper/dist/ledger-helper.mjs', 'scan'], {
      timeoutMs: SCAN_TIMEOUT_MS,
    })
    const doc = parseOutput(result.stdout)
    if (result.exitCode !== 0 || !doc || doc.error || !doc.ranges) throw new Error(failure(result, doc))
    usage = doc
    await $.store.set('usage', doc)
  } catch (error) {
    usageError = error instanceof Error ? error.message : String(error)
  } finally {
    scanning = false
    $.ui.invalidate('ui.render')
  }
}

async function refreshLimits($) {
  if (limitsBusy) return
  limitsBusy = true
  limitsError = null
  $.ui.invalidate('ui.render')
  try {
    const native = await $.session.usage()
    if (native.rateLimits.length > 0) claudeNative = nativeWindows(native.rateLimits)
    // The key travels in the child's environment, never on its command line.
    const result = await $.process.run(['node', '--no-warnings', $.plugin.root + '/helper/dist/ledger-helper.mjs', 'limits'], {
      timeoutMs: LIMITS_TIMEOUT_MS,
      env: {
        LEDGER_HUB_URL: String(config.hubUrl ?? ''),
        LEDGER_HUB_KEY: String(config.hubKey ?? ''),
        LEDGER_OPENCODE_GO: config.openCodeGo ? '1' : '0',
      },
    })
    const doc = parseOutput(result.stdout)
    if (result.exitCode !== 0 || !doc || doc.error || !doc.accounts) throw new Error(failure(result, doc))
    limits = doc
    await $.store.set('limits', doc)
  } catch (error) {
    limitsError = error instanceof Error ? error.message : String(error)
  } finally {
    limitsBusy = false
    $.ui.invalidate('ui.render')
  }
}

/**
 * Usage is rescanned once its snapshot is stale. Limits are read on every
 * open: the read is quick, and a saved snapshot may predate a change to the
 * hub settings.
 */
function refresh($, force) {
  if (force || !usage || Date.now() - Date.parse(usage.readAt) > STALE_MS) refreshUsage($)
  refreshLimits($)
}

function pointCount() {
  return usage?.ranges?.[range]?.points?.length ?? 0
}

export function register(on, options) {
  config = options ?? {}

  on('session.start', async ($, e, next) => {
    try {
      const [savedUsage, savedLimits] = await Promise.all([$.store.get('usage'), $.store.get('limits')])
      if (savedUsage?.ranges) usage = savedUsage
      if (savedLimits?.accounts) limits = savedLimits
    } catch {
      // No saved snapshot: the first open scans.
    }
    await $.command.register({
      name: 'ledger',
      description: 'Cost, tokens and plan limits across your coding agents',
      argumentHint: '[refresh]',
      immediate: true,
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.rateLimits?.length) {
      claudeNative = nativeWindows(e.rateLimits)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('command.run', { command: 'ledger' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Ledger', focus: true, closeOnEscape: true, columns: 150 })
    refresh($, e.args.trim() === 'refresh')
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const redraw = () => $.ui.invalidate('ui.render')
    const points = pointCount()
    if (tab === 'limits') {
      // Read on every draw: a reload clears module state, and the call costs nothing.
      const native = await $.session.usage()
      if (native.rateLimits.length > 0) claudeNative = nativeWindows(native.rateLimits)
    }
    const state = {
      tab,
      range,
      group,
      cursor: points === 0 ? null : cursor === null ? points - 1 : Math.min(cursor, points - 1),
      usage,
      error: usageError,
      busy: scanning || limitsBusy,
      limits,
      limitsError,
      limitsBusy,
      claudeNative,
      width: e.props.bodyColumns ?? 80,
      nowMs: Date.now(),
      timeZone: usage?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      act: {
        tab: (id) => {
          tab = id
          redraw()
        },
        cycleRange: () => {
          range = nextOf(RANGES, range)
          cursor = null
          redraw()
        },
        cycleGroup: () => {
          group = nextOf(GROUPS, group)
          redraw()
        },
        move: (delta) => {
          const count = pointCount()
          if (count === 0) return
          const current = cursor === null ? count - 1 : cursor
          cursor = Math.max(0, Math.min(count - 1, current + delta))
          redraw()
        },
        refresh: () => refresh($, true),
      },
    }
    return renderPane($.ui.resolve(e), state)
  })
}
