import { expect, mock, test } from 'claude-code/testing'
import { fitGrid } from '../hooks/video'

const API = 'https://api.test'
/** No install-time settings: tests point the plugin at the fake server through its env knobs. */
const ENV = { SIDECAR_API_BASE: API, SIDECAR_VIDEO_PANE: 'off' }
const ENV_PANE = { SIDECAR_API_BASE: API }

const WALLET = {
  todayMicros: 4100,
  pendingMicros: 4100,
  lifetimeMicros: 4100,
  isClaimed: false,
  claimUrl: `${API}/earn/claim?code=ABCD-EFGH`,
}

/** The person types a prompt and presses Enter: their sign of life, then the turn. */
async function submit($: any, text: string, turnId: string, kind = 'composer') {
  await $.prompt.submit({ text, origin: { kind }, wait: false })
  await $.turn.start({ text, turnId })
}

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

test('a turn serves an ad and the spinner carries it, marked Sponsored', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  const calls: string[] = []
  mock.store(on)
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('http.fetch', async (_$, e) => {
    const path = e.url.slice(API.length)
    calls.push(`${e.init?.method ?? 'GET'} ${path}`)
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }) as never
    if (path === '/api/v1/devices') return json({ token: 'tok', deviceId: 'dev_1' })
    if (path === '/api/v1/me') return json({ wallet: WALLET })
    if (path === '/api/v1/ads/request') return json({ ad: TEXT_AD })
    return json({ creditedMicros: 2050, isCredited: true, wallet: WALLET })
  })

  on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.version', async () => ({ value: { version: '2.1.287', base: '2.1.287', builtAt: '' } }) as never)

  let drawnMessage: string | null = null
  on('ui.render', { component: 'Spinner' }, async (t, e) => {
    drawnMessage = (e.props as { message: string | null }).message
    return t.ui.resolve(e).Text({ children: drawnMessage ?? '' })
  })
  on('ui.status', async () => ({ value: undefined }) as never)

  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  // Startup does its network work off the hook, so the session never waits on the server.
  await clock.settle()
  expect(calls).toContain('POST /api/v1/devices')
  expect(calls).toContain('GET /api/v1/me')

  await submit($, 'fix the tests', 't1')
  // The ad is asked for half a second into the turn.
  await clock.advance(300)
  expect(calls).not.toContain('POST /api/v1/ads/request')
  await clock.advance(300)
  expect(calls).toContain('POST /api/v1/ads/request')

  await $.ui.render({
    component: 'Spinner',
    surface: 'terminal',
    requestId: 'main',
    props: { word: 'Baking', message: null, suffix: '…', mode: 'thinking' },
  } as never)
  expect(drawnMessage).toBe('Deploy previews in 30s with Northwind · Sponsored')
})

test('pause stops ads', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  mock.clock(on)
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ wallet: WALLET, token: 't', deviceId: 'd' }) } }) as never)
  const out = await $.command.run({ command: 'sidecar', args: 'pause' } as never)
  expect(out.text).toContain('paused')
})

test('a video ad draws in the pane as a raster with its copy', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't', videoQuality: 'blocks' })
  mock.env(on, ENV_PANE)
  const clock = mock.clock(on, { now: 1_000_000 })
  // 4x2 pixels, 2 frames
  const rgb = new Uint8Array(4 * 2 * 3 * 2).fill(200)
  const pack = { width: 4, height: 2, fps: 10, count: 2, rgb: rgb.toBase64() }
  const videoAd = { ...TEXT_AD, format: 'video', framesUrl: `${API}/frames`, durationMs: 15000 }
  on('http.fetch', async (_$, e) => {
    const body = e.url.endsWith('/frames') ? pack : e.url.endsWith('/ads/request') ? { ad: videoAd } : { wallet: WALLET }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)

  await submit($, 'go', 't1')
  await clock.advance(3100)

  const ui = await $.ui.mount({
    plugin: 'sidecar',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidecar',
    props: { title: 'Sponsored', isFocused: false, bodyColumns: 60, placement: 'dock' },
  } as never)
  expect(await ui.find({ type: 'Raster', key: 'video' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Northwind Deploy/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /you earn/ })).toBeDefined()
  await ui.unmount()
})

test('a video cut off by the end of the turn plays to its end, then the pane closes', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't' })
  mock.env(on, ENV_PANE)
  const clock = mock.clock(on, { now: 1_000_000 })
  const rgb = new Uint8Array(4 * 2 * 3 * 2).fill(90)
  const pack = { width: 4, height: 2, fps: 10, count: 2, rgb: rgb.toBase64() }
  const videoAd = { ...TEXT_AD, format: 'video', framesUrl: `${API}/frames`, durationMs: 30000 }
  const beats: { isWatching: boolean; playedMs: number }[] = []
  let requests = 0
  on('http.fetch', async (_$, e) => {
    if (e.url.endsWith('/beat')) beats.push(JSON.parse(String(e.init?.body)))
    if (e.url.endsWith('/ads/request')) requests++
    const body = e.url.endsWith('/frames') ? pack : e.url.endsWith('/ads/request') ? { ad: videoAd } : e.url.endsWith('/beat') ? { status: 'served' } : { wallet: WALLET }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }) as never)
  let closes = 0
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', async () => {
    closes++
    return { value: undefined } as never
  })
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.blit', async () => ({ value: {} }) as never)

  await submit($, 'go', 't1')
  await clock.advance(3100)
  const ui = await $.ui.mount({
    plugin: 'sidecar',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidecar',
    props: { title: 'Sponsored', isFocused: false, bodyColumns: 60, placement: 'dock' },
  } as never)
  await clock.advance(6000)

  await $.turn.complete({ turnId: 't1', answer: 'done' } as never)
  // Still playing after Claude is done, with nothing offering to cut it short.
  expect(await ui.find({ type: 'Text', text: /Northwind Deploy/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'skip' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'close' })).toBeUndefined()
  await clock.advance(10_500)
  expect(beats[beats.length - 1]?.isWatching).toBe(true)
  expect(closes).toBe(0)
  // It plays out (30s in all), settles, and our pane closes.
  await clock.advance(16_000)
  expect(closes).toBeGreaterThan(0)
  expect(requests).toBe(1)
  await ui.unmount()
})

test('a long turn rotates to the next ad once one plays out', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  let requests = 0
  let completes = 0
  on('http.fetch', async (_$, e) => {
    if (e.url.endsWith('/ads/request')) requests++
    if (e.url.endsWith('/complete')) completes++
    const body = e.url.endsWith('/ads/request') ? { ad: TEXT_AD } : e.url.endsWith('/beat') ? { status: 'served' } : { creditedMicros: 1, isCredited: true, wallet: WALLET }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)

  await submit($, 'big refactor', 't1')
  await clock.advance(3100)
  expect(requests).toBe(1)
  // The 10s spinner line plays out, settles, and the next one follows.
  await clock.advance(10_500)
  expect(completes).toBe(1)
  await clock.advance(2000)
  expect(requests).toBe(2)
})

/** A text ad long enough to outlast the presence window, and a server that records what it is told. */
function presenceRig($: any, on: any, adMs = 200_000) {
  const beats: { isWatching: boolean; playedMs: number; idleMs: number }[] = []
  const requests: { idleMs: number }[] = []
  on('http.fetch', async (_$: unknown, e: { url: string; init?: { body?: unknown } }) => {
    if (e.url.endsWith('/beat')) beats.push(JSON.parse(String(e.init?.body)))
    if (e.url.endsWith('/ads/request')) requests.push(JSON.parse(String(e.init?.body)))
    const body = e.url.endsWith('/ads/request')
      ? { ad: { ...TEXT_AD, durationMs: adMs } }
      : e.url.endsWith('/beat')
        ? { status: 'served' }
        : { creditedMicros: 1, isCredited: true, wallet: WALLET }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('turn.start', async (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('prompt.edit', async (_$: unknown, e: { text: string; cursor: number }) => ({ text: e.text, cursor: e.cursor }))
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  let message: string | null = null
  on('ui.render', { component: 'Spinner' }, async (t: any, e: any) => {
    message = e.props.message
    return t.ui.resolve(e).Text({ children: message ?? '' })
  })
  const spinner = async () => {
    await $.ui.render({
      component: 'Spinner',
      surface: 'terminal',
      requestId: 'main',
      props: { word: 'Baking', message: null, suffix: '…', mode: 'thinking' },
    } as never)
    return message
  }
  return { beats, requests, spinner }
}

test('idle: after 90s without a sign of life the ad stops counting and leaves the spinner', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  const rig = presenceRig($, on)

  await submit($, 'long job', 't1')
  await clock.advance(3100)
  expect(rig.requests).toHaveLength(1)
  // The prompt just submitted is the sign of life: the turn starts present.
  expect(rig.requests[0]!.idleMs).toBeLessThan(5000)
  await clock.advance(60_000)
  expect(rig.beats[rig.beats.length - 1]!.isWatching).toBe(true)
  expect(await rig.spinner()).toBe('Deploy previews in 30s with Northwind · Sponsored')

  // Past 90s of quiet: away.
  await clock.advance(30_000)
  const last = rig.beats[rig.beats.length - 1]!
  expect(last.isWatching).toBe(false)
  expect(last.idleMs).toBeGreaterThan(90_000)
  expect(await rig.spinner()).toBe(null)
  // Played time froze where the person left.
  const frozen = last.playedMs
  expect(frozen).toBeLessThan(93_000)
  await clock.advance(60_000)
  expect(rig.beats[rig.beats.length - 1]!.playedMs).toBe(frozen)
  expect(rig.beats[rig.beats.length - 1]!.isWatching).toBe(false)
})

test('away: no new ad is asked for while nobody is there', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  // 10s ads rotate through a long turn while the person is there...
  const rig = presenceRig($, on, 10_000)
  await submit($, 'big refactor', 't1')
  await clock.advance(95_000)
  const whileHere = rig.requests.length
  expect(whileHere).toBeGreaterThan(3)
  // ...and stop once they have been gone 90s.
  await clock.advance(120_000)
  expect(rig.requests.length).toBe(whileHere)
})

test('a scheduled prompt with nobody at the keyboard shows no ad', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  const rig = presenceRig($, on)
  await submit($, '/loop check the deploy', 't1', 'scheduled-trigger')
  await clock.advance(10_000)
  expect(rig.requests).toHaveLength(0)
})

test('return: a keystroke resumes the ad at once and the server hears it', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  const rig = presenceRig($, on)
  await submit($, 'long job', 't1')
  await clock.advance(3100)
  await clock.advance(120_000)
  expect(await rig.spinner()).toBe(null)
  const frozen = rig.beats[rig.beats.length - 1]!.playedMs
  const beatsBefore = rig.beats.length

  await ($ as any).prompt.edit({ origin: { kind: 'key' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'w' } as never)
  // A beat goes out right away, in the background so the keystroke never waits on it, saying the next stretch counts.
  await clock.settle()
  expect(rig.beats.length).toBe(beatsBefore + 1)
  expect(rig.beats[rig.beats.length - 1]!.isWatching).toBe(true)
  expect(rig.beats[rig.beats.length - 1]!.idleMs).toBe(0)
  expect(await rig.spinner()).toBe('Deploy previews in 30s with Northwind · Sponsored')
  // Counting picks up from where it froze, not from the time away.
  await clock.advance(10_000)
  const resumed = rig.beats[rig.beats.length - 1]!.playedMs
  expect(resumed).toBeGreaterThan(frozen + 4000)
  expect(resumed).toBeLessThan(frozen + 11_000)
})

test('return mid-turn with no ad asks for one', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  const rig = presenceRig($, on)
  // A /loop turn starts with nobody there: no ad.
  await submit($, '/loop check the deploy', 't1', 'scheduled-trigger')
  await clock.advance(10_000)
  expect(rig.requests).toHaveLength(0)
  // The person comes back and runs a command: the running turn gets its ad.
  await $.command.run({ command: 'sidecar', args: 'wallet', origin: { kind: 'composer' } } as never)
  expect(rig.requests).toHaveLength(1)
  expect(rig.requests[0]!.idleMs).toBe(0)
})

test('the pane says it is paused while you are away', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't' })
  mock.env(on, ENV_PANE)
  const clock = mock.clock(on, { now: 1_000_000 })
  const rgb = new Uint8Array(4 * 2 * 3 * 2).fill(200)
  const pack = { width: 4, height: 2, fps: 10, count: 2, rgb: rgb.toBase64() }
  const videoAd = { ...TEXT_AD, format: 'video', framesUrl: `${API}/frames`, durationMs: 300_000 }
  on('http.fetch', async (_$, e) => {
    const body = e.url.endsWith('/frames') ? pack : e.url.endsWith('/ads/request') ? { ad: videoAd } : e.url.endsWith('/beat') ? { status: 'served' } : { wallet: WALLET }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.blit', async () => ({ value: {} }) as never)
  await submit($, 'go', 't1')
  await clock.advance(3100)
  for (const placement of ['dock', 'inline'] as const) {
    const ui = await $.ui.mount({
      plugin: 'sidecar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'sidecar',
      props: { title: 'Sponsored', isFocused: false, bodyColumns: 100, placement },
    } as never)
    expect(await ui.find({ type: 'Text', text: /away/ })).toBeUndefined()
    await ui.unmount()
  }
  await clock.advance(95_000)
  for (const placement of ['dock', 'inline'] as const) {
    const ui = await $.ui.mount({
      plugin: 'sidecar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'sidecar',
      props: { title: 'Sponsored', isFocused: false, bodyColumns: 100, placement },
    } as never)
    expect(await ui.find({ type: 'Text', text: "Paused while you're away" })).toBeDefined()
    await ui.unmount()
  }
})

test('the footer hint reads Sidecar and whole cents', async ($, on) => {
  mock.store(on)
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('http.fetch', async (_$, e) => {
    const body = e.url.endsWith('/devices') ? { token: 'tok', deviceId: 'dev_1' } : { wallet: { ...WALLET, todayMicros: 10_200 } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.version', async () => ({ value: { version: '2.1.288', base: '2.1.288', builtAt: '' } }) as never)
  const statuses: unknown[] = []
  on('ui.status', async (_$, e) => {
    statuses.push(e)
    return { value: undefined } as never
  })
  let tail: string | undefined
  on('ui.render', { component: 'PromptHint' }, async (t, e) => {
    tail = (e.props as { tail?: string }).tail
    return t.ui.resolve(e).Text({ children: 'hint' })
  })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await clock.settle()
  await $.ui.render({ component: 'PromptHint', surface: 'terminal', requestId: 'main', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
  expect(tail).toBe('Sidecar · $0.01 today')
  // Nothing pinned as a status notice (that drew a warning sign and the name twice).
  expect(statuses.every((s) => JSON.stringify(s).includes('null') || !JSON.stringify(s).includes('sidecar'))).toBe(true)
})

test('a narrow terminal stacks the inline banner inside its width', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't', videoQuality: 'blocks' })
  mock.env(on, ENV_PANE)
  const clock = mock.clock(on, { now: 1_000_000 })
  const rgb = new Uint8Array(16 * 9 * 3 * 2).fill(120)
  const pack = { width: 16, height: 9, fps: 10, count: 2, rgb: rgb.toBase64() }
  const videoAd = { ...TEXT_AD, format: 'video', framesUrl: `${API}/frames`, durationMs: 30_000 }
  on('http.fetch', async (_$, e) => {
    const body = e.url.endsWith('/frames') ? pack : e.url.endsWith('/ads/request') ? { ad: videoAd } : e.url.endsWith('/beat') ? { status: 'served' } : { wallet: WALLET }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.blit', async () => ({ value: {} }) as never)
  await submit($, 'go', 't1')
  await clock.advance(3100)
  for (const bodyColumns of [76, 50, 30]) {
    const ui = await $.ui.mount({
      plugin: 'sidecar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'sidecar',
      props: { title: 'Sponsored', isFocused: false, bodyColumns, placement: 'inline' },
    } as never)
    const raster = (await ui.find({ type: 'Raster', key: 'video' })) as { props: { columns: number } } | undefined
    expect(raster).toBeDefined()
    expect(raster!.props.columns).toBeLessThanOrEqual(bodyColumns)
    expect(await ui.find({ type: 'Text', text: /Northwind Deploy/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a house ad says it pays nothing instead of what you earn', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't' })
  mock.env(on, ENV_PANE)
  const clock = mock.clock(on, { now: 1_000_000 })
  const houseAd = { ...TEXT_AD, advertiser: 'Sidecar', headline: 'Your ad here', viewerMicros: 0, isHouse: true }
  on('http.fetch', async (_$, e) => {
    const body = e.url.endsWith('/ads/request') ? { ad: houseAd } : e.url.endsWith('/beat') ? { status: 'served' } : { wallet: WALLET }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  await submit($, 'go', 't1')
  await clock.advance(3100)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'sidecar',
      surface,
      component: 'Pane',
      requestId: 'sidecar',
      props: { title: 'Sponsored', isFocused: false, bodyColumns: 80, placement: 'dock' },
    } as never)
    expect(await ui.find({ type: 'Text', text: /House ad, not paid/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /you earn/ })).toBeUndefined()
    await ui.unmount()
  }
})

test("the person's prompt opens the pane (placed at any width); a scheduled one does not", async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't' })
  mock.env(on, ENV_PANE)
  mock.clock(on, { now: 1_000_000 })
  const opens: string[] = []
  on('ui.open', async (_$, e) => {
    opens.push((e as { id: string }).id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', async () => ({ value: undefined }) as never)
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ wallet: WALLET }) } }) as never)
  await $.prompt.submit({ text: '/loop check', origin: { kind: 'scheduled-trigger' }, wait: false } as never)
  expect(opens).toHaveLength(0)
  await $.prompt.submit({ text: 'fix the tests', origin: { kind: 'composer' }, wait: false } as never)
  expect(opens).toEqual(['sidecar'])
})

/** A valid 1x1 PNG: the engine checks an Image's PNG header. */
const ONE_PX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('by default the pane shows the sharp PNG frames, and falls back to blocks where images are refused', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't' })
  mock.env(on, ENV_PANE)
  const clock = mock.clock(on, { now: 1_000_000 })
  const rgb = new Uint8Array(4 * 2 * 3 * 2).fill(200)
  const pack = { width: 4, height: 2, fps: 10, count: 2, rgb: rgb.toBase64() }
  // A sharp pack comes as an index and parts.
  const hdIndex = { width: 384, height: 216, fps: 10, count: 2, parts: [1, 1] }
  const hdPart = (i: number) => ({ start: i, png: [ONE_PX_PNG] })
  const videoAd = { ...TEXT_AD, format: 'video', framesUrl: `${API}/frames`, hdUrl: `${API}/hd`, durationMs: 30_000 }
  on('http.fetch', async (_$, e) => {
    const body = e.url.endsWith('/frames') ? pack : e.url.endsWith('/hd') ? hdIndex : e.url.includes('/hd?part=') ? hdPart(Number(e.url.split('part=')[1])) : e.url.endsWith('/ads/request') ? { ad: videoAd } : e.url.endsWith('/beat') ? { status: 'served' } : { wallet: WALLET }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  let refuse = false
  const sources: unknown[] = []
  on('ui.blit', async (_$, e) => {
    sources.push((e as { source?: unknown }).source)
    return { value: refuse ? { deny: 'no placeholder images' } : {} } as never
  })
  await submit($, 'go', 't1')
  await clock.advance(1000)
  const mount = () =>
    $.ui.mount({
      plugin: 'sidecar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'sidecar',
      props: { title: 'Sponsored', isFocused: false, bodyColumns: 60, placement: 'dock' },
    } as never)
  let ui = await mount()
  expect(await ui.find({ type: 'Image', key: 'video' })).toBeDefined()
  await clock.advance(300)
  expect(sources.some((s) => typeof (s as { png?: string })?.png === 'string')).toBe(true)
  await ui.unmount()
  // A terminal without images refuses the swap: blocks from then on.
  refuse = true
  ui = await mount()
  await clock.advance(300)
  await ui.unmount()
  ui = await mount()
  expect(await ui.find({ type: 'Raster', key: 'video' })).toBeDefined()
  await ui.unmount()
})

test('in the desktop app the pane plays the JPEG frames in an Svg, with the bar inside it', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't' })
  mock.env(on, ENV_PANE)
  const clock = mock.clock(on, { now: 1_000_000 })
  const rgb = new Uint8Array(4 * 2 * 3 * 2).fill(200)
  const pack = { width: 4, height: 2, fps: 10, count: 2, rgb: rgb.toBase64() }
  const desktopIndex = { width: 640, height: 360, fps: 10, count: 2, parts: [1, 1] }
  const desktopPart = (i: number) => ({ start: i, jpeg: [`/9j/AAAA${i === 0 ? 'A' : 'B'}`] })
  const videoAd = { ...TEXT_AD, format: 'video', framesUrl: `${API}/frames`, hdUrl: `${API}/hd`, desktopUrl: `${API}/desktop`, durationMs: 30_000 }
  const fetched: string[] = []
  on('http.fetch', async (_$, e) => {
    fetched.push(e.url)
    const body = e.url.endsWith('/frames') ? pack : e.url.endsWith('/desktop') ? desktopIndex : e.url.includes('/desktop?part=') ? desktopPart(Number(e.url.split('part=')[1])) : e.url.endsWith('/ads/request') ? { ad: videoAd } : e.url.endsWith('/beat') ? { status: 'served' } : { wallet: WALLET }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.version', async () => ({ value: { version: '2.1.287', base: '2.1.287', builtAt: '' } }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)
  let redraws = 0
  on('ui.invalidate', async () => {
    redraws++
    return { value: undefined } as never
  })
  await $.session.start({ source: 'startup', cwd: '/tmp', surface: 'desktop' } as never)
  await submit($, 'go', 't1')
  await clock.advance(1000)
  // The desktop app never needs the sharp terminal frames.
  expect(fetched.some((u) => u.includes('/hd'))).toBe(false)
  const mount = () =>
    $.ui.mount({
      plugin: 'sidecar',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'sidecar',
      props: { title: 'Sponsored', isFocused: false, bodyColumns: 60, placement: 'dock' },
    } as never)
  let ui = await mount()
  const first = (await ui.find({ type: 'Svg' })) as { props: { source: string } } | undefined
  expect(first?.props.source).toContain('data:image/jpeg;base64,/9j/AAAAA')
  // The bar is drawn in the Svg, not as a row of text under it.
  expect(first?.props.source).toContain(`fill="#d97757"`)
  await ui.unmount()
  // Each tick is a redraw that moves to the next frame.
  const before = redraws
  await clock.advance(250)
  expect(redraws).toBeGreaterThan(before)
  ui = await mount()
  const next = (await ui.find({ type: 'Svg' })) as { props: { source: string } } | undefined
  expect(next?.props.source).not.toBe(first?.props.source)
  await ui.unmount()
})

test('a desktop frame that is not plain base64 JPEG is never put in the Svg', async ($, on) => {
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  mock.store(on, { token: 't' })
  mock.env(on, ENV_PANE)
  const clock = mock.clock(on, { now: 1_000_000 })
  const rgb = new Uint8Array(4 * 2 * 3 * 2).fill(200)
  const pack = { width: 4, height: 2, fps: 10, count: 2, rgb: rgb.toBase64() }
  const desktopIndex = { width: 640, height: 360, fps: 10, count: 2, parts: [2] }
  // The first frame closes the attribute and adds an element of its own.
  const desktopPart = { start: 0, jpeg: ['/9j/AAAA"/><script>x</script><image href="', '/9j/AAAAB'] }
  const videoAd = { ...TEXT_AD, format: 'video', framesUrl: `${API}/frames`, desktopUrl: `${API}/desktop`, durationMs: 30_000 }
  on('http.fetch', async (_$, e) => {
    const body = e.url.endsWith('/frames') ? pack : e.url.endsWith('/desktop') ? desktopIndex : e.url.includes('/desktop?part=') ? desktopPart : e.url.endsWith('/ads/request') ? { ad: videoAd } : e.url.endsWith('/beat') ? { status: 'served' } : { wallet: WALLET }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.version', async () => ({ value: { version: '2.1.287', base: '2.1.287', builtAt: '' } }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  await $.session.start({ source: 'startup', cwd: '/tmp', surface: 'desktop' } as never)
  await submit($, 'go', 't1')
  await clock.advance(1000)
  const ui = await $.ui.mount({
    plugin: 'sidecar',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'sidecar',
    props: { title: 'Sponsored', isFocused: false, bodyColumns: 60, placement: 'dock' },
  } as never)
  // The whole pack is refused: the pane shows the card, with no Svg at all.
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

test('pixel art is drawn at a whole-number scale, never stretched', async () => {
  const art = { width: 48, height: 28, isPixelArt: true }
  // A 58-column pane shows it at 1x (48 columns), not stretched to 58.
  expect(fitGrid(art, 58, 30)).toEqual({ columns: 48, rows: 14 })
  // Twice the room: 2x.
  expect(fitGrid(art, 100, 40)).toEqual({ columns: 96, rows: 28 })
  // Too short for 2x: back to 1x.
  expect(fitGrid(art, 100, 20)).toEqual({ columns: 48, rows: 14 })
  // A video still fills the width.
  expect(fitGrid({ width: 80, height: 45 }, 58, 30).columns).toBe(58)
})
