import { expect, test } from 'claude-code/testing'

import { barChart, splitBar } from '../hooks/charts.js'

const point = (key: string, cost: number, tokens: number) => ({
  key,
  costUsd: cost,
  tokens,
  providers: { claude: { costUsd: cost, tokens } },
  models: cost > 0 ? [{ model: 'claude-opus-5-5', provider: 'claude', costUsd: cost, tokens, unpriced: false }] : [],
})

const range = (id: string, points: ReturnType<typeof point>[], resolution = 'day') => {
  const cost = points.reduce((s, p) => s + p.costUsd, 0)
  const tokens = points.reduce((s, p) => s + p.tokens, 0)
  return {
    id,
    resolution,
    sinceDay: '2026-10-01',
    untilDay: '2026-10-05',
    total: { costUsd: cost, tokens, cachedInput: tokens - 10, uncachedInput: 4, cacheWrite: 3, output: 3, savingsUsd: 12.5, sessions: 3, unpricedRecords: 0 },
    categoryCost: { input: 1, cacheRead: cost - 3, cacheWrite: 1, output: 1, other: 0 },
    speed: { standard: cost, fast: 0, ultrafast: 0, premium: 0 },
    providers: [{ provider: 'claude', costUsd: cost, tokens, sessions: 3 }],
    models: [{ model: 'claude-opus-5-5', provider: 'claude', costUsd: cost, tokens, unpriced: false }],
    points,
  }
}

const days = [point('2026-10-03', 10, 1000), point('2026-10-04', 0, 0), point('2026-10-05', 32.5, 5000)]
const SCAN = {
  version: 1,
  readAt: '2026-10-05T22:00:00.000Z',
  timeZone: 'UTC',
  scanMs: 1200,
  rates: { status: 'cached', fetchedAt: null },
  sources: [],
  ranges: {
    '24h': range('24h', [point('2026-10-05T21:00:00.000Z', 2, 200)], 'hour'),
    '7d': range('7d', days),
    '30d': range('30d', days),
    '90d': range('90d', days),
  },
}
const LIMITS = {
  version: 1,
  checkedAt: '2026-10-05T22:00:00.000Z',
  accounts: [
    {
      provider: 'codex',
      label: 'me@example.com',
      plan: 'Plus',
      resetCredits: 2,
      windows: [{ id: 'secondary', label: 'Weekly', kind: 'weekly', usedPercent: 62, resetsAt: '2026-10-09T10:00:00.000Z', windowMins: 10080 }],
    },
  ],
  hub: { status: 'ok' },
  openCodeGo: { status: 'off' },
}

const PANE = {
  plugin: 'usagemeter',
  component: 'Pane',
  requestId: 'usagemeter',
  surface: 'terminal',
  viewport: { columns: 160, rows: 50 },
  props: { title: 'Usage meter', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** Stubs the engine for one /usagemeter session and records every helper run. */
function stubs(on: any, runs: { argv: string[]; env?: Record<string, string> }[]) {
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('process.run', ($: unknown, e: any) => {
    runs.push({ argv: e.argv, env: e.init?.env })
    const doc = e.argv.at(-1) === 'scan' ? SCAN : LIMITS
    return { value: { exitCode: 0, stdout: JSON.stringify(doc) + '\n', stderr: '' } }
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test('/usagemeter scans, reads limits with the key in the environment, and draws the cost tab', { options: { hubUrl: 'http://localhost:8317', hubKey: 'secret-key', openCodeGo: true } }, async ($, on) => {
  const runs: { argv: string[]; env?: Record<string, string> }[] = []
  stubs(on, runs)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'usagemeter', args: '' })
  await settle()

  expect(runs.map((r) => r.argv.at(-1)).sort()).toEqual(['limits', 'scan'])
  const limitsRun = runs.find((r) => r.argv.at(-1) === 'limits')!
  expect(limitsRun.argv.join(' ')).not.toContain('secret-key')
  expect(limitsRun.env).toMatchObject({ USAGEMETER_HUB_URL: 'http://localhost:8317', USAGEMETER_HUB_KEY: 'secret-key', USAGEMETER_OPENCODE_GO: '1' })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: '$42.50' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Daily cost' })).toBeDefined()
})

test('keys switch tab, range and grouping', async ($, on) => {
  stubs(on, [])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'usagemeter', args: '' })
  await settle()
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: 'tab-tokens' })
  expect(await ui.find({ type: 'Text', text: 'Daily processed tokens' })).toBeDefined()

  await ui.press({ key: 'range' })
  expect(await ui.find({ type: 'Button', text: '30 days' })).toBeDefined()

  await ui.press({ key: 'group' })
  expect(await ui.find({ type: 'Text', text: 'Breakdown · by provider' })).toBeDefined()

  await ui.press({ key: 'tab-limits' })
  expect(await ui.find({ type: 'Text', text: /me@example\.com · Plus · 2 resets banked/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /38% left/ })).toBeDefined()
})

test('a narrow pane stacks its layout and draws on both surfaces', async ($, on) => {
  stubs(on, [])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'usagemeter', args: '' })
  await settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 60, placement: 'inline' } })
    expect(await ui.find({ type: 'Text', text: '$42.50' })).toBeDefined()
    await ui.press({ key: 'tab-tokens' })
    expect(await ui.find({ type: 'Text', text: 'Daily processed tokens' })).toBeDefined()
    await ui.press({ key: 'tab-limits' })
    expect(await ui.find({ type: 'Text', text: /38% left/ })).toBeDefined()
    await ui.press({ key: 'tab-cost' })
    await ui.unmount()
  }
})

test('a failed scan is reported in the pane', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: JSON.stringify({ version: 1, error: 'disk on fire' }) + '\n', stderr: '' } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'usagemeter', args: '' })
  await settle()
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: 'Could not read usage: disk on fire' })).toBeDefined()
})

test('charts fit the width they are given', () => {
  const columns = Array.from({ length: 90 }, (_, i) => ({ total: i, label: 'd' + i, parts: [{ key: 'claude', value: i, color: '#d97757' }] }))
  const { rows, merged } = barChart({ columns, width: 60, height: 6 })
  expect(merged.length <= 60).toBe(true)
  // The axis is scaled to the merged columns: the tallest merged bar fills the top row.
  const merged40 = barChart({ columns: Array.from({ length: 90 }, () => ({ total: 1, label: 'd', parts: [{ key: 'k', value: 1, color: '#fff' }] })), width: 40, height: 4 })
  expect(merged40.merged[0].total > 1).toBe(true)
  expect(merged40.rows[0][0].text.trim()).toBe(merged40.merged[0].total + ' ┤')
  for (const row of rows) expect(row.reduce((n: number, seg: { text: string }) => n + seg.text.length, 0) <= 60).toBe(true)
  const bar = splitBar([{ value: 1, color: 'a' }, { value: 1000, color: 'b' }, { value: 0, color: 'c' }], 40)
  expect(bar.reduce((n: number, seg: { text: string }) => n + seg.text.length, 0)).toBe(40)
  expect(bar.length).toBe(2)
})
