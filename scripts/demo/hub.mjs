// A fake CLIProxyAPI management API with demo accounts, for screenshots.
import { createServer } from 'node:http'
const at = (h) => new Date(Date.now() + h * 3600000).toISOString()
const epoch = (h) => Math.round((Date.now() + h * 3600000) / 1000)
const answers = {
  '/wham/usage': { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 34, reset_at: epoch(2.6), limit_window_seconds: 18000 }, secondary_window: { used_percent: 61, reset_at: epoch(70), limit_window_seconds: 604800 } } },
  '/rate-limit-reset-credits': { credits: [{ id: 'c1', status: 'available', reset_type: 'codex_rate_limits', expires_at: at(400) }] },
  '/api/oauth/usage': { five_hour: { utilization: 18, resets_at: at(1.4) }, seven_day: { utilization: 42, resets_at: at(118) }, limits: [{ kind: 'weekly_scoped', percent: 9, resets_at: at(118), scope: { model: { display_name: 'Opus' } } }] },
  ':retrieveUserQuotaSummary': { groups: [{ buckets: [{ bucketId: 'gemini-5h', remainingFraction: 0.82, resetTime: at(3.1) }, { bucketId: 'gemini-weekly', remainingFraction: 0.66, resetTime: at(90) }, { bucketId: '3p-5h', remainingFraction: 1, resetTime: at(5) }, { bucketId: '3p-weekly', remainingFraction: 0.9, resetTime: at(90) }] }] },
}
createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v0/management/auth-files') return res.end(JSON.stringify({ files: [
      { id: 'a', auth_index: 0, provider: 'codex', email: 'dev@example.com' },
      { id: 'b', auth_index: 1, provider: 'claude', email: 'dev@example.com' },
      { id: 'c', auth_index: 2, provider: 'antigravity', email: 'dev@example.com', project_id: 'demo' } ] }))
    if (req.url === '/v0/management/api-call') {
      const url = JSON.parse(raw).url
      const key = Object.keys(answers).find((k) => url.endsWith(k))
      return res.end(JSON.stringify(key ? { status_code: 200, body: JSON.stringify(answers[key]) } : { status_code: 404, body: '' }))
    }
    res.statusCode = 404; res.end('{}')
  })
}).listen(Number(process.argv[2] ?? 18317), '127.0.0.1')
