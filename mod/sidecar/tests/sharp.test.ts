import { expect, mock, test } from 'claude-code/testing'

const API = 'https://api.test'
const ENV = { SIDECAR_API_BASE: API, HOME: '/home/dev' }

const WALLET = { todayMicros: 0, pendingMicros: 0, lifetimeMicros: 0, isClaimed: false, claimUrl: `${API}/earn/claim?code=ABCD-EFGH` }
/** Two valid 1x1 PNGs, one black-ish (the stale pack's) and one red (the fresh pack's). */
const STALE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const FRESH_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

const AD = {
  impressionId: 'imp_1',
  creativeId: 'cr_1',
  format: 'video',
  advertiser: 'Northwind Deploy',
  headline: 'Previews in 30 seconds',
  body: 'Every branch, its own URL.',
  spinnerText: 'Deploy previews in 30s with Northwind',
  ctaLabel: 'Try it',
  clickUrl: `${API}/c/imp_1`,
  framesUrl: `${API}/frames`,
  hdUrl: `${API}/hd`,
  durationMs: 30_000,
  viewerMicros: 2050,
  posterColor: 0x223344,
}

async function submit($: any, text: string, turnId: string) {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text, turnId })
}

/** The engine's stand-ins: a server, an in-memory disk, and an Image that takes every swap. */
function setup($: any, on: any, store: Record<string, unknown>) {
  on('prompt.submit', async (_$: any, e: any) => ({ text: e.text }))
  const kept = new Map<string, unknown>(Object.entries({ token: 't', ...store }))
  on('store.get', async (_$: any, e: any) => ({ value: kept.get(e.key) }) as never)
  on('store.set', async (_$: any, e: any) => {
    kept.set(e.key, e.value)
    return { value: undefined } as never
  })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  const rgb = new Uint8Array(4 * 2 * 3 * 2).fill(200)
  const pack = { width: 4, height: 2, fps: 10, count: 2, rgb: rgb.toBase64() }
  const hdIndex = { width: 384, height: 216, fps: 10, count: 2, parts: [1, 1] }
  const hdPart = (i: number) => ({ start: i, png: [FRESH_PNG] })
  const fetched: string[] = []
  const events: string[] = []
  const files = new Map<string, string>()
  on('http.fetch', async (_$: any, e: any) => {
    fetched.push(e.url)
    const body = e.url.endsWith('/frames')
      ? pack
      : e.url.endsWith('/hd')
        ? hdIndex
        : e.url.includes('/hd?part=')
          ? hdPart(Number(e.url.split('part=')[1]))
          : e.url.endsWith('/ads/request')
            ? { ad: AD }
            : e.url.endsWith('/beat')
              ? { status: 'served' }
              : { wallet: WALLET }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('fs.exists', async (_$: any, e: any) => ({ value: files.has(e.path) }) as never)
  on('fs.read', async (_$: any, e: any) => ({ value: files.get(e.path) ?? '' }) as never)
  on('fs.write', async (_$: any, e: any) => {
    files.set(e.path, e.content ?? e.text ?? e.data)
    return { value: undefined } as never
  })
  on('ui.status', async () => ({ value: undefined }) as never)
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('turn.start', async (_$: any, e: any) => ({ turnId: e.turnId }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  const sources: { png?: string }[] = []
  let deny: string | undefined
  on('ui.blit', async (_$: any, e: any) => {
    events.push('blit')
    sources.push(e.source)
    return { value: deny ? { deny } : {} } as never
  })
  const mount = () =>
    $.ui.mount({
      plugin: 'sidecar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'sidecar',
      props: { title: 'Sponsored', isFocused: false, bodyColumns: 60, placement: 'dock' },
    } as never)
  return { kept, clock, fetched, events, files, sources, mount, refuse: (why: string) => (deny = why) }
}

test('a pack on disk that the server has since made again is not played: the sharp one replaces it', async ($, on) => {
  const t = setup($, on, {})
  // What an older server's pack left behind: another size, parts under their own names.
  const base = '/home/dev/.cache/sidecar/frames/api_test.cr_1'
  t.files.set(`${base}.hd2.json`, JSON.stringify({ width: 384, height: 224, fps: 10, count: 2, parts: [2] }))
  t.files.set(`${base}.hd2.hd2.json`, 'ignored')
  t.files.set(`${base}.hd2.384x224_2_2.0.json`, JSON.stringify({ start: 0, png: [STALE_PNG, STALE_PNG] }))
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await submit($, 'go', 't1')
  await t.clock.advance(1000)
  const ui = await t.mount()
  await t.clock.advance(1500)
  const pngs = t.sources.map((s) => s.png).filter(Boolean)
  expect(pngs).toContain(FRESH_PNG)
  expect(pngs).not.toContain(STALE_PNG)
  // The index is always asked for; the changed pack's parts came over the wire.
  expect(t.fetched).toContain(`${API}/hd`)
  expect(t.fetched).toContain(`${API}/hd?part=0`)
  await ui.unmount()
})

test('a terminal that drew an image once is remembered: the sharp pack is asked for at the start of the next ad', async ($, on) => {
  const t = setup($, on, {})
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await submit($, 'go', 't1')
  await t.clock.advance(1000)
  const ui = await t.mount()
  await t.clock.advance(1500)
  expect(t.kept.get('imageOk')).toBe(true)
  await ui.unmount()
})

test('with an image remembered from before, the sharp pack is asked for at the start of the ad, before any swap', async ($, on) => {
  const next = setup($, on, { imageOk: true })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await submit($, 'again', 't2')
  await next.clock.advance(500)
  expect(next.fetched).toContain(`${API}/hd`)
  expect(next.events).toHaveLength(0)
})

test('one refused swap does not end the sharp frames, three in a row do', async ($, on) => {
  const t = setup($, on, { imageOk: true })
  await $.session.start({ source: 'startup', cwd: '/tmp' } as never)
  await submit($, 'go', 't1')
  await t.clock.advance(1000)
  const ui = await t.mount()
  await t.clock.advance(300)
  t.refuse('resized')
  await t.clock.advance(200)
  t.refuse('')
  await t.clock.advance(500)
  expect(t.kept.get('imageOk')).toBe(true)
  t.refuse('no placeholder images')
  await t.clock.advance(1000)
  expect(t.kept.get('imageOk')).toBe(false)
  await ui.unmount()
})
