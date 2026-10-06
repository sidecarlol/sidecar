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

// In VS Code the mod also talks to the Sidecar panel extension on this machine. That is a local call, not a
// new one to the server: the server hears the same documented calls, and the panel gets the ad and the
// earnings figures only, over 127.0.0.1, with its token and nothing else in the headers.
test('privacy: with the VS Code panel the server hears the same calls, and the panel never gets the prompt or the cwd', async ($, on) => {
  const TOKEN = 'cd'.repeat(24)
  mock.store(on)
  mock.env(on, { SIDECAR_API_BASE: API, TERM_PROGRAM: 'vscode', HOME: '/Users/jane' })
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
  on('fs.exists', async (_$, e) => ({ value: e.path === '/Users/jane/.sidecar/panel' }) as never)
  on('fs.list', async () => ({ value: [{ name: '50000.json', kind: 'file' }] }) as never)
  on('fs.read', async () => ({ value: JSON.stringify({ port: 50000, token: TOKEN, pid: 99, startedAt: 1 }) }) as never)

  const server: string[] = []
  const local: { call: string; keys: string[]; text: string; headers: string[] }[] = []
  on('http.fetch', async (_$, e) => {
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }) as never
    const sent = e.init?.body ? (JSON.parse(String(e.init.body)) as Record<string, unknown>) : undefined
    if (e.url.startsWith('http://127.0.0.1:50000/')) {
      local.push({
        call: `${e.init?.method ?? 'GET'} ${e.url.slice('http://127.0.0.1:50000'.length)}`,
        keys: sent ? Object.keys(sent).sort() : [],
        text: `${e.url} ${e.init?.body ?? ''}`,
        headers: Object.keys(e.init?.headers ?? {}).sort(),
      })
      if (e.url.endsWith('/hello')) return json({ sidecarPanel: true, pid: 99, app: 'Visual Studio Code', workspaceFolders: ['/Users/jane/secret-repo'] })
      return json({ open: true, visible: true, docVisible: true, playing: true, currentMs: 0, error: null, events: [] })
    }
    const path = e.url.slice(API.length)
    server.push(`${e.init?.method ?? 'GET'} ${path.replace(/imp_\w+/, 'imp_ID')}`)
    expect(`${e.url} ${e.init?.body ?? ''}`).not.toContain('127.0.0.1')
    if (path === '/api/v1/devices') return json({ token: 'tok', deviceId: 'dev_1' })
    if (path === '/api/v1/ads/request') return json({ ad: { ...AD, format: 'video', framesUrl: `${API}/frames`, videoUrl: `${API}/api/media/videos/v.mp4`, durationMs: 20000 } })
    if (path.endsWith('/beat')) return json({ status: 'served' })
    if (path.endsWith('/complete')) return json({ creditedMicros: 1, isCredited: true, wallet: WALLET })
    if (path === '/api/v1/creatives/live') return json({ creatives: [] })
    return json({ wallet: WALLET })
  })

  await $.session.start({ source: 'startup', cwd: '/Users/jane/secret-repo', surface: 'terminal' } as never)
  await clock.settle()
  const secret = 'rotate the production password for hunter2'
  await $.prompt.submit({ text: secret, origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: secret, turnId: 't1' })
  await clock.advance(6000)
  await $.turn.complete({ turnId: 't1', answer: 'the password is hunter2' } as never)
  // The video plays on through the grace window, then settles.
  await clock.advance(31_000)

  // The server hears no call beyond the documented ones, and no frame or media download from the mod.
  expect([...new Set(server)].sort()).toEqual(
    ['GET /api/v1/creatives/live', 'GET /api/v1/me', 'POST /api/v1/ads/request', 'POST /api/v1/devices', 'POST /api/v1/impressions/imp_ID/beat', 'POST /api/v1/impressions/imp_ID/complete'].sort(),
  )
  // The panel: only /hello and /sync, token and content type in the headers, no cwd, path or prompt.
  expect([...new Set(local.map((r) => r.call))].sort()).toEqual(['GET /hello', 'POST /sync'])
  expect(local.length).toBeGreaterThan(2)
  for (const r of local) {
    expect(r.headers.every((h) => h === 'x-sidecar-token' || h === 'content-type')).toBe(true)
    expect(r.keys).toEqual(r.call === 'POST /sync' ? ['client', 'state'] : [])
    for (const leak of ['hunter2', 'secret-repo', '/Users/jane', 'rotate the production']) expect(r.text).not.toContain(leak)
  }
})
