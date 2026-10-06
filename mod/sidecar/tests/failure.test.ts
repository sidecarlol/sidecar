import { expect, mock, test } from 'claude-code/testing'

const API = 'https://api.test'
const ENV = { SIDECAR_API_BASE: API, SIDECAR_VIDEO_PANE: 'off' }
const WALLET = { todayMicros: 4100, pendingMicros: 4100, lifetimeMicros: 4100, isClaimed: false, claimUrl: `${API}/earn/claim?code=ABCD-EFGH` }
const TEXT_AD = {
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
  durationMs: 10000,
  viewerMicros: 2050,
  posterColor: 0x223344,
}

type Reply = { status: number; body?: unknown; text?: string } | 'offline' | 'hang'

/** A fake ad server: `reply` answers each call by its method and path, and every call is logged. */
function server(on: any, clock: { sleep: (ms: number) => Promise<void> }, reply: (call: string, body: any) => Reply) {
  const calls: string[] = []
  const bodies: Record<string, any[]> = {}
  on('http.fetch', async (_$: any, e: any) => {
    const path = e.url.slice(API.length)
    const call = `${e.init?.method ?? 'GET'} ${path}`
    calls.push(call)
    const sent = e.init?.body ? JSON.parse(String(e.init.body)) : undefined
    ;(bodies[call] ??= []).push(sent)
    const got = reply(call, sent)
    if (got === 'offline') throw new Error('getaddrinfo ENOTFOUND api.test')
    if (got === 'hang') {
      await clock.sleep(10 * 60_000)
      throw new Error('hung')
    }
    const text = got.text ?? JSON.stringify(got.body ?? {})
    return { value: { status: got.status, ok: got.status >= 200 && got.status < 300, headers: {}, text } } as never
  })
  return { calls, bodies, count: (call: string) => calls.filter((c) => c === call).length }
}

function engineStubs(on: any) {
  on('prompt.submit', async (_$: any, e: any) => ({ text: e.text }))
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }) as never)
  on('turn.start', async (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.version', async () => ({ value: { version: '2.1.289', base: '2.1.289', builtAt: '' } }) as never)
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)
  on('ui.blit', async () => ({ value: {} }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
}

async function turn($: any, clock: { advance: (ms: number) => Promise<void> }, id: string, ms = 700) {
  await $.prompt.submit({ text: 'go', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'go', turnId: id })
  await clock.advance(ms)
}

async function paneText($: any, requestId = 'sidecar') {
  const ui = await $.ui.mount({
    plugin: 'sidecar',
    surface: 'terminal',
    component: 'Pane',
    requestId,
    props: { title: 'Sponsored', isFocused: false, bodyColumns: 80, placement: 'inline' },
  } as never)
  const text = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return text
}

test('offline: startup and every turn finish quietly, and registration is not retried each turn', async ($, on) => {
  mock.store(on)
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  const api = server(on, clock, () => 'offline')

  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()
  expect(api.count('POST /api/v1/devices')).toBe(1)
  for (const id of ['t1', 't2', 't3']) {
    await turn($, clock, id)
    await $.turn.complete({ turnId: id, answer: 'done' } as never)
  }
  // One attempt at startup, none per turn: a down server is not asked every few seconds.
  expect(api.count('POST /api/v1/devices')).toBe(1)
  expect(api.count('POST /api/v1/ads/request')).toBe(0)
  expect(await paneText($)).toContain('Ad server unreachable')
  // Five minutes on, the next turn tries again.
  await clock.advance(5 * 60_000 + 1000)
  await turn($, clock, 't4')
  expect(api.count('POST /api/v1/devices')).toBe(2)
})

test('429 on registration: says why, and leaves the network alone for an hour', async ($, on) => {
  mock.store(on)
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  const api = server(on, clock, (call) => (call === 'POST /api/v1/devices' ? { status: 429, body: { error: 'too many new installs from this network today' } } : { status: 401 }))

  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()
  await turn($, clock, 't1')
  expect(await paneText($)).toContain('Too many new installs')
  await clock.advance(30 * 60_000)
  await turn($, clock, 't2')
  expect(api.count('POST /api/v1/devices')).toBe(1)
  await clock.advance(31 * 60_000)
  await turn($, clock, 't3')
  expect(api.count('POST /api/v1/devices')).toBe(2)
})

test('a captive portal answering 200 with a web page never becomes a token', async ($, on) => {
  mock.store(on)
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  const api = server(on, clock, () => ({ status: 200, text: '<html>Sign in to the hotel wifi</html>' }))
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()
  await turn($, clock, 't1')
  expect(await paneText($)).toContain('Ad server unreachable')
  // No token was kept, so no ad request went out with one.
  expect(api.count('POST /api/v1/ads/request')).toBe(0)
})

test('a server that never answers does not hold the session start, and calls give up after 8 seconds', async ($, on) => {
  mock.store(on)
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  const api = server(on, clock, () => 'hang')
  // The hook returns without the clock moving: nothing waits on the server.
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  expect(api.count('POST /api/v1/devices')).toBeLessThanOrEqual(1)
  await clock.advance(9000)
  expect(await paneText($)).toContain('Ad server unreachable')
})

test('server errors (500, 503) on an ad request leave the turn alone and say so in the pane', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  const api = server(on, clock, (call) => (call === 'GET /api/v1/me' ? { status: 200, body: { wallet: WALLET } } : { status: 503, text: 'upstream down' }))
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()
  await turn($, clock, 't1')
  await $.turn.complete({ turnId: 't1', answer: 'done' } as never)
  expect(api.count('POST /api/v1/ads/request')).toBe(1)
  expect(await paneText($)).toContain('no ad this turn')
  // The next turn asks again.
  await turn($, clock, 't2')
  expect(api.count('POST /api/v1/ads/request')).toBe(2)
})

test('a revoked or unknown token registers once and carries on; the new token is stored', async ($, on) => {
  mock.store(on, { token: 'revoked' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  const seen: string[] = []
  on('http.fetch', async (_$: any, e: any) => {
    const path = e.url.slice(API.length)
    seen.push(`${e.init?.method ?? 'GET'} ${path} ${e.init?.headers?.authorization ?? 'no-auth'}`)
    const json = (status: number, body: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } }) as never
    if (path === '/api/v1/devices') return json(200, { token: 'fresh', deviceId: 'dev_2' })
    if (e.init?.headers?.authorization === 'Bearer revoked') return json(401, { error: 'unknown device token' })
    if (path === '/api/v1/me') return json(200, { wallet: WALLET })
    if (path === '/api/v1/ads/request') return json(200, { ad: TEXT_AD })
    return json(200, { status: 'served', creditedMicros: 1, isCredited: true, wallet: WALLET })
  })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()
  expect(seen.filter((s) => s.startsWith('POST /api/v1/devices')).length).toBe(1)
  expect(seen).toContain('GET /api/v1/me Bearer fresh')
  await turn($, clock, 't1')
  expect(seen.some((s) => s.startsWith('POST /api/v1/ads/request Bearer fresh'))).toBe(true)
  expect(seen.filter((s) => s.startsWith('POST /api/v1/devices')).length).toBe(1)
})

test('over a cap: the ad plays, the server says it was not counted, and the pane says the same', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  server(on, clock, (call) => {
    if (call === 'POST /api/v1/ads/request') return { status: 200, body: { ad: { ...TEXT_AD, durationMs: 3000 } } }
    if (call.endsWith('/complete')) return { status: 200, body: { creditedMicros: 0, isCredited: false, wallet: WALLET } }
    if (call.endsWith('/beat')) return { status: 200, body: { status: 'served' } }
    return { status: 200, body: { wallet: WALLET } }
  })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()
  // The 3s ad plays out and settles; the next one has not been asked for yet.
  await turn($, clock, 't1', 3800)
  await $.turn.complete({ turnId: 't1', answer: 'done' } as never)
  expect(await paneText($)).toContain('not counted')
})

test('commands: link prints the claim URL, wallet the figures, pause stops ad requests, resume starts them', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  const api = server(on, clock, (call) => {
    if (call === 'POST /api/v1/ads/request') return { status: 200, body: { ad: TEXT_AD } }
    if (call.endsWith('/beat')) return { status: 200, body: { status: 'served' } }
    if (call.endsWith('/complete')) return { status: 200, body: { creditedMicros: 0, isCredited: false, wallet: WALLET } }
    return { status: 200, body: { wallet: WALLET } }
  })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()

  const link = await $.command.run({ command: 'sidecar', args: 'link', origin: { kind: 'composer' } } as never)
  expect(link.text).toContain(`${API}/earn/claim?code=ABCD-EFGH`)
  const wallet = await $.command.run({ command: 'sidecar', args: 'wallet', origin: { kind: 'composer' } } as never)
  expect(wallet.text).toContain('Today $0.0041')
  expect(wallet.text).toContain('Not linked yet')

  const paused = await $.command.run({ command: 'sidecar', args: 'pause', origin: { kind: 'composer' } } as never)
  expect(paused.text).toContain('paused')
  await turn($, clock, 't1')
  expect(api.count('POST /api/v1/ads/request')).toBe(0)
  await $.turn.complete({ turnId: 't1', answer: 'done' } as never)

  const resumed = await $.command.run({ command: 'sidecar', args: 'resume', origin: { kind: 'composer' } } as never)
  expect(resumed.text).toContain('resumed')
  await turn($, clock, 't2')
  expect(api.count('POST /api/v1/ads/request')).toBe(1)

  const pixels = await $.command.run({ command: 'sidecar', args: 'pixels', origin: { kind: 'composer' } } as never)
  expect(pixels.text).toContain('full pixels')
  const blocks = await $.command.run({ command: 'sidecar', args: 'blocks', origin: { kind: 'composer' } } as never)
  expect(blocks.text).toContain('text blocks')
})

test('commands against a dead server answer in words instead of throwing', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  server(on, clock, () => 'offline')
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()
  for (const args of ['link', 'wallet']) {
    const out = await $.command.run({ command: 'sidecar', args, origin: { kind: 'composer' } } as never)
    expect(out.text).toContain('could not reach')
  }
})

test('first run: the footer reads "Sidecar · $0.00 today" before any ad has paid', async ($, on) => {
  mock.store(on)
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  server(on, clock, (call) => (call === 'POST /api/v1/devices' ? { status: 200, body: { token: 'tok', deviceId: 'dev_1' } } : { status: 200, body: { wallet: { ...WALLET, todayMicros: 0, pendingMicros: 0, lifetimeMicros: 0 } } }))
  let tail: string | undefined
  on('ui.render', { component: 'PromptHint' }, async (t: any, e: any) => {
    tail = e.props.tail
    return t.ui.resolve(e).Text({ children: 'hint' })
  })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()
  await $.ui.render({ component: 'PromptHint', surface: 'terminal', requestId: 'main', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
  expect(tail).toBe('Sidecar · $0.00 today')
})

test('the spinner line is cut to the row at narrow widths, and the Sponsored mark is never cut', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  server(on, clock, (call) => {
    if (call === 'POST /api/v1/ads/request') return { status: 200, body: { ad: { ...TEXT_AD, spinnerText: 'X'.repeat(60) } } }
    if (call.endsWith('/beat')) return { status: 200, body: { status: 'served' } }
    return { status: 200, body: { wallet: WALLET } }
  })
  const drawn: Record<number, string> = {}
  on('ui.render', { component: 'Spinner' }, async (t: any, e: any) => {
    drawn[e.viewport?.columns ?? 0] = e.props.message
    return t.ui.resolve(e).Text({ children: e.props.message ?? '' })
  })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()
  await turn($, clock, 't1')
  for (const columns of [80, 120, 200]) {
    await $.ui.render({
      component: 'Spinner',
      surface: 'terminal',
      requestId: 'main',
      viewport: { columns, rows: 30, isFullscreen: false },
      props: { word: 'Baking', message: null, suffix: '…', mode: 'thinking' },
    } as never)
  }
  for (const columns of [80, 120, 200]) {
    expect(drawn[columns]).toMatch(/ · Sponsored$/)
    // glyph, message, suffix and the engine's "(1m 12s · ↓ 12.3k tokens)" all share the row
    expect(drawn[columns]!.length + 40).toBeLessThanOrEqual(Math.max(columns, 64 + 40))
  }
  expect(drawn[80]!.length).toBeLessThan(drawn[200]!.length)
  expect(drawn[200]).toBe(`${'X'.repeat(60)} · Sponsored`)
})

test('a prompt typed while start-up registration is still in flight does not register a second device', async ($, on) => {
  mock.store(on)
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  let devices = 0
  on('http.fetch', async (_$: any, e: any) => {
    const path = e.url.slice(API.length)
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }) as never
    if (path === '/api/v1/devices') {
      devices++
      await clock.sleep(2000)
      return json({ token: 'tok', deviceId: 'dev_1' })
    }
    if (path === '/api/v1/ads/request') return json({ ad: TEXT_AD })
    if (path.endsWith('/beat')) return json({ status: 'served' })
    return json({ wallet: WALLET })
  })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await turn($, clock, 't1', 3000)
  expect(devices).toBe(1)
  await clock.advance(1000)
})

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const NEL = String.fromCharCode(0x85)
const CSI = String.fromCharCode(0x9b)
const RLO = String.fromCharCode(0x202e)
const LRI = String.fromCharCode(0x2066)
/** True when the text holds a terminal escape, a C0 or C1 control, or a bidi override or isolate. */
const hasUnsafe = (text: string) =>
  [...text].some((c) => {
    const n = c.codePointAt(0)!
    return n <= 0x1f || (n >= 0x7f && n <= 0x9f) || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069) || n === 0x200e || n === 0x200f
  })

test('hostile ad text: control and bidi characters never reach the spinner or the pane', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  const hostile = {
    ...TEXT_AD,
    advertiser: `Evil${ESC}]0;pwned${BEL} Corp${RLO}`,
    headline: `Head${ESC}[2Jline${LRI}`,
    body: `Body${NEL}text${CSI}31m\nsecond line`,
    spinnerText: `Buy ${ESC}[31mnow${RLO}txet${ESC}[0m`,
    ctaLabel: `Go${BEL}`,
    clickUrl: `https://api.test/c/imp_1${ESC}\\${BEL}`,
  }
  server(on, clock, (call) => {
    if (call === 'POST /api/v1/ads/request') return { status: 200, body: { ad: hostile } }
    if (call.endsWith('/beat')) return { status: 200, body: { status: 'served' } }
    return { status: 200, body: { wallet: { ...WALLET, claimUrl: `${API}/earn/claim?code=A${ESC}B` } } }
  })
  let drawn = ''
  on('ui.render', { component: 'Spinner' }, async (t: any, e: any) => {
    drawn = e.props.message
    return t.ui.resolve(e).Text({ children: e.props.message ?? '' })
  })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()
  await turn($, clock, 't1')
  await $.ui.render({
    component: 'Spinner',
    surface: 'terminal',
    requestId: 'main',
    viewport: { columns: 200, rows: 30, isFullscreen: false },
    props: { word: 'Baking', message: null, suffix: '…', mode: 'thinking' },
  } as never)
  expect(drawn).toBe('Buy [31mnowtxet[0m · Sponsored')
  expect(hasUnsafe(drawn)).toBe(false)

  // The pane comes back as JSON: decode it and check every string in the drawn tree.
  const pane = await paneText($)
  const texts: string[] = []
  const collect = (node: unknown) => {
    if (typeof node === 'string') texts.push(node)
    else if (node && typeof node === 'object') Object.values(node).forEach(collect)
  }
  collect(JSON.parse(pane))
  expect(texts.length).toBeGreaterThan(5)
  expect(texts.filter(hasUnsafe)).toEqual([])
  expect(pane).toContain('Evil]0;pwned Corp')
  expect(pane).toContain('Body text31m second line')
  expect(pane).toContain('earn/claim?code=AB')
})

test('429 on an ad request: no ad this turn, no "unreachable" notice, and the next turn asks again', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  engineStubs(on)
  const api = server(on, clock, (call) => (call === 'GET /api/v1/me' ? { status: 200, body: { wallet: WALLET } } : { status: 429, body: { error: 'too many requests' } }))
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()
  await turn($, clock, 't1')
  expect(api.count('POST /api/v1/ads/request')).toBe(1)
  expect(await paneText($)).not.toContain('unreachable')
  await $.turn.complete({ turnId: 't1', answer: 'done' } as never)
  await turn($, clock, 't2')
  expect(api.count('POST /api/v1/ads/request')).toBe(2)
})
