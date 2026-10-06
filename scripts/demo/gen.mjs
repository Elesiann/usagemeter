// Synthetic agent history for ledger's README screenshots. No real data.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.argv[2]
const DAY = 86400000
const now = Date.now()
let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

const claudeDir = join(home, '.claude', 'projects', '-work-demo-app')
mkdirSync(claudeDir, { recursive: true })
const codexDir = join(home, '.codex', 'sessions', '2026', '10')
mkdirSync(codexDir, { recursive: true })

// A weekday rhythm with a quiet weekend, over 90 days.
const weight = (d) => { const wd = new Date(now - d * DAY).getUTCDay(); return wd === 0 || wd === 6 ? 0.15 : 0.6 + rnd() * 0.8 }
let msg = 0
for (let d = 89; d >= 0; d--) {
  const w = weight(d)
  for (let s = 0; s < Math.round(6 * w); s++) {
    const session = `demo-${d}-${s}`
    const lines = []
    const model = rnd() < 0.55 ? 'claude-sonnet-5-5' : 'claude-opus-5-5'
    for (let t = 0; t < 40 + Math.round(rnd() * 80); t++) {
      const ts = new Date(now - d * DAY - (8 - s) * 3600000 + t * 60000).toISOString()
      lines.push(JSON.stringify({ type: 'assistant', timestamp: ts, requestId: `req_${++msg}`, sessionId: session,
        message: { id: `msg_${msg}`, model, usage: { input_tokens: 40 + Math.round(rnd() * 400), output_tokens: 200 + Math.round(rnd() * 900),
          cache_read_input_tokens: 60000 + Math.round(rnd() * 100000), cache_creation_input_tokens: Math.round(rnd() * 4000) } } }))
    }
    writeFileSync(join(claudeDir, session + '.jsonl'), lines.join('\n') + '\n')
  }
  for (let s = 0; s < Math.round(4 * w); s++) {
    const id = `cx-${d}-${s}`
    const start = now - d * DAY - (6 - s) * 3600000
    const lines = [JSON.stringify({ type: 'session_meta', timestamp: new Date(start).toISOString(), payload: { id } }),
      JSON.stringify({ type: 'turn_context', timestamp: new Date(start).toISOString(), payload: { model: rnd() < 0.7 ? 'gpt-5.3-codex' : 'gpt-5.5' } })]
    for (let t = 0; t < 20 + Math.round(rnd() * 40); t++) {
      const input = 30000 + Math.round(rnd() * 50000)
      lines.push(JSON.stringify({ type: 'event_msg', timestamp: new Date(start + t * 90000).toISOString(), payload: { type: 'token_count',
        info: { last_token_usage: { input_tokens: input, cached_input_tokens: Math.round(input * 0.85), output_tokens: 300 + Math.round(rnd() * 1500), reasoning_output_tokens: 100 } } } }))
    }
    writeFileSync(join(codexDir, `rollout-${id}.jsonl`), lines.join('\n') + '\n')
  }
}
console.log('demo history written to', home)
