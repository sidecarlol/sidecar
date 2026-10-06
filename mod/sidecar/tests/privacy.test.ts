import { expect, mock, test } from 'claude-code/testing'

const API = 'https://api.test'
const WALLET = { todayMicros: 4100, pendingMicros: 4100, lifetimeMicros: 4100, isClaimed: false, claimUrl: `${API}/earn/claim?code=ABCD-EFGH` }
const AD = {
  impressionId: 'imp_1',
  creativeId: 'cr_1',
  format: 'text',
  advertiser: 'Northwind Deploy',
  headline: 'Previews in 30 seconds',
  body: 'Every branch, its own URL.',
  spinnerText: 'Deploy previews in 30s with Northwind',
  ctaLabel: 'Try it',
  clickUrl: `${API}/c/imp_1`,
  framesUrl: null,
  durationMs: 3000,
  viewerMicros: 2050,
  posterColor: 0x223344,
}

// The privacy page and the docs promise: never prompts, responses, code, file names or paths, the
// working directory, tool calls, environment variables. This watches every request of a whole turn.
test('privacy: a whole turn sends only the documented fields, never the prompt, the cwd or a path', async ($, on) => {
  mock.store(on)
  mock.env(on, { SIDECAR_API_BASE: API })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.version', async () => ({ value: { version: '2.1.289', base: '2.1.289', builtAt: '' } }) as never)
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)

  const requests: { call: string; keys: string[]; text: string; headers: string[] }[] = []
  on('http.fetch', async (_$, e) => {
    const path = e.url.slice(API.length)
    const call = `${e.init?.method ?? 'GET'} ${path}`
    const sent = e.init?.body ? (JSON.parse(String(e.init.body)) as Record<string, unknown>) : undefined
    requests.push({ call, keys: sent ? Object.keys(sent).sort() : [], text: `${e.url} ${e.init?.body ?? ''}`, headers: Object.keys(e.init?.headers ?? {}).sort() })
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }) as never
    if (path === '/api/v1/devices') return json({ token: 'tok', deviceId: 'dev_1' })
    if (path === '/api/v1/ads/request') return json({ ad: AD })
    if (path.endsWith('/beat')) return json({ status: 'served' })
    if (path.endsWith('/complete')) return json({ creditedMicros: 1, isCredited: true, wallet: WALLET })
    if (path === '/api/v1/creatives/live') return json({ creatives: [] })
    return json({ wallet: WALLET })
  })

  await $.session.start({ source: 'startup', cwd: '/Users/jane/secret-repo' } as never)
  await clock.settle()
  const secret = 'rotate the production password for hunter2'
  await $.prompt.submit({ text: secret, origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: secret, turnId: 't1' })
  await clock.advance(6000)
  await $.turn.complete({ turnId: 't1', answer: 'the password is hunter2' } as never)
  await clock.advance(1000)

  const id = (call: string) => call.replace(/imp_\w+/, 'imp_ID')
  expect([...new Set(requests.map((r) => id(r.call)))].sort()).toEqual(
    ['GET /api/v1/creatives/live', 'GET /api/v1/me', 'POST /api/v1/ads/request', 'POST /api/v1/devices', 'POST /api/v1/impressions/imp_ID/beat', 'POST /api/v1/impressions/imp_ID/complete'].sort(),
  )
  const fields: Record<string, string[]> = {
    'POST /api/v1/devices': ['client', 'version'],
    'POST /api/v1/ads/request': ['idleMs', 'placements'],
    'POST /api/v1/impressions/imp_ID/beat': ['idleMs', 'isWatching', 'playedMs'],
    'POST /api/v1/impressions/imp_ID/complete': ['idleMs', 'playedMs', 'reason'],
  }
  for (const r of requests) {
    expect(r.keys).toEqual(fields[id(r.call)] ?? [])
    // Only a content type and the device token ride in the headers.
    expect(r.headers.every((h) => h === 'authorization' || h === 'content-type')).toBe(true)
    for (const leak of ['hunter2', 'secret-repo', '/Users/jane', 'rotate the production']) expect(r.text).not.toContain(leak)
  }
})
