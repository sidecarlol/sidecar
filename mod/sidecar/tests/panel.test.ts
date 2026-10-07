import { expect, mock, test } from 'claude-code/testing'

// VS Code: the Sidecar panel extension (vscode/) plays the video beside the terminal.

const API = 'https://api.test'
const ENV = { SIDECAR_API_BASE: API, TERM_PROGRAM: 'vscode', HOME: '/home/dev' }
const PANEL = 'http://127.0.0.1:50000'
const TOKEN = 'ab'.repeat(24)
const WALLET = { todayMicros: 4100, pendingMicros: 4100, lifetimeMicros: 4100, isClaimed: false, claimUrl: `${API}/earn/claim?code=ABCD-EFGH` }
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
  videoUrl: `${API}/api/media/videos/v.mp4`,
  durationMs: 12000,
  viewerMicros: 2050,
  posterColor: 0x223344,
}

type Lock = { name: string; body: unknown }
const GOOD_LOCK: Lock = { name: '50000.json', body: { port: 50000, token: TOKEN, pid: 4242, startedAt: 1 } }

/**
 * A VS Code window with the panel: its lock files in ~/.sidecar/panel and its local server
 * answering /hello and /sync as vscode/extension.js does. `status` is what it reports on each sync.
 */
function fakePanel(on: any, status: () => Record<string, unknown>, locks: Lock[] = [GOOD_LOCK], hello: Record<string, unknown> = {}) {
  const syncs: { client: string; state: any }[] = []
  const contacted: string[] = []
  on('fs.exists', async (_$: any, e: any) => ({ value: e.path === '/home/dev/.sidecar/panel' }) as never)
  on('fs.list', async () => ({ value: locks.map((l) => ({ name: l.name, kind: 'file' })) }) as never)
  on('fs.read', async (_$: any, e: any) => {
    const lock = locks.find((l) => e.path.endsWith(l.name))
    return { value: lock ? JSON.stringify(lock.body) : '{}' } as never
  })
  const answer = (url: string, init: any) => {
    contacted.push(url)
    expect(init?.headers?.['x-sidecar-token']).toBe(TOKEN)
    if (url === `${PANEL}/hello`) return { sidecarPanel: true, app: 'Visual Studio Code', pid: 4242, workspaceFolders: ['/work'], ...hello }
    const body = JSON.parse(String(init?.body))
    syncs.push(body)
    return body.state?.show
      ? { open: true, visible: true, docVisible: true, playing: true, currentMs: 0, error: null, events: [], ...status() }
      : { open: false, visible: false, docVisible: false, playing: false, currentMs: 0, error: null, events: [] }
  }
  return { syncs, contacted, answer }
}

function adServer(on: any, panel: ReturnType<typeof fakePanel>, ad: unknown, calls: { requests: any[]; beats: any[]; completes: any[] }) {
  on('http.fetch', async (_$: any, e: any) => {
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }) as never
    if (e.url.startsWith('http://127.0.0.1')) return json(panel.answer(e.url, e.init))
    if (e.url.endsWith('/ads/request')) {
      calls.requests.push(JSON.parse(String(e.init?.body)))
      return json({ ad })
    }
    if (e.url.endsWith('/beat')) {
      calls.beats.push(JSON.parse(String(e.init?.body)))
      return json({ status: 'served' })
    }
    if (e.url.endsWith('/complete')) {
      calls.completes.push(JSON.parse(String(e.init?.body)))
      return json({ creditedMicros: 0, isCredited: false, wallet: WALLET })
    }
    return json({ wallet: WALLET })
  })
}

function engineStubs(on: any) {
  on('prompt.submit', async (_$: any, e: any) => ({ text: e.text }))
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }) as never)
  on('turn.start', async (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }) as never)
  on('session.end', async (_$: any, e: any) => ({ sessionId: e.sessionId }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('session.version', async () => ({ value: { version: '2.1.289', base: '2.1.289', builtAt: '' } }) as never)
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.close', async () => ({ value: undefined }) as never)
  on('ui.blit', async () => ({ value: {} }) as never)
}

async function submit($: any, text: string, turnId: string) {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text, turnId })
}

const start = ($: any, cwd = '/work/app') => $.session.start({ source: 'startup', cwd, surface: 'terminal' } as never)

test('in VS Code the ad plays in the panel: no terminal pane, watch time follows the panel', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  let playedInPanel = 0
  const panel = fakePanel(on, () => ({ currentMs: playedInPanel }))
  const calls = { requests: [] as any[], beats: [] as any[], completes: [] as any[] }
  adServer(on, panel, AD, calls)
  engineStubs(on)
  const opened: string[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })

  await start($)
  await submit($, 'go', 't1')
  await clock.advance(600)
  // The pane-and-spinner auction, but Claude Code's own pane never opens: the panel shows the video.
  expect(calls.requests[0]?.placements).toEqual(['spinner', 'pane'])
  expect(opened).not.toContain('sidecar')
  const shown = panel.syncs.find((s) => s.state?.ad)
  expect(shown?.state.ad.videoUrl).toBe(AD.videoUrl)
  expect(shown?.state.isWorking).toBe(true)

  // The panel plays: watch time counts and the server hears it.
  for (let s = 1; s <= 6; s++) {
    playedInPanel = s * 1000
    await clock.advance(1000)
  }
  expect(calls.beats.at(-1)?.isWatching).toBe(true)
  expect(calls.beats.at(-1)?.playedMs).toBeGreaterThan(4000)
})

test('a panel that is hidden or not playing earns nothing', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  const panel = fakePanel(on, () => ({ visible: false, playing: false, currentMs: 9000 }))
  const calls = { requests: [] as any[], beats: [] as any[], completes: [] as any[] }
  adServer(on, panel, AD, calls)
  engineStubs(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)

  await start($)
  await submit($, 'go', 't1')
  await clock.advance(600)
  await clock.advance(7000)
  expect(calls.beats.length).toBeGreaterThan(0)
  expect(calls.beats.every((b) => b.isWatching === false)).toBe(true)
  // The picture's own position does not count while nobody can see it.
  expect(calls.beats.at(-1)?.playedMs).toBe(0)
})

test('closing the panel skips that ad: the rest of the turn is spinner only, the next prompt brings video back', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  let events: unknown[] = []
  const panel = fakePanel(on, () => {
    const out = { events }
    events = []
    return out
  })
  const calls = { requests: [] as any[], beats: [] as any[], completes: [] as any[] }
  adServer(on, panel, AD, calls)
  engineStubs(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)

  await start($, '/work')
  await submit($, 'go', 't1')
  await clock.advance(600)
  events = [{ type: 'closed' }]
  await clock.advance(1100)
  await $.turn.complete({ turnId: 't1', answer: 'done' } as never)
  expect(calls.completes.at(-1)?.reason).toBe('skipped')

  // A turn the person did not prompt (a schedule, a peer) keeps it closed.
  await $.turn.start({ text: 'scheduled', turnId: 't2' })
  await clock.advance(600)
  expect(calls.requests.at(-1)?.placements).toEqual(['spinner'])
  await $.turn.complete({ turnId: 't2', answer: 'done' } as never)
  await clock.advance(31_000)

  const asked = calls.requests.length
  await submit($, 'again', 't3')
  await clock.advance(600)
  expect(calls.requests.length).toBe(asked + 1)
  expect(calls.requests.at(-1)?.placements).toEqual(['spinner', 'pane'])
})

test('in VS Code without the panel, the pane plays as before and the extension is offered once', async ($, on) => {
  mock.store(on, { token: 't', videoQuality: 'blocks' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  on('fs.exists', async () => ({ value: false }) as never)
  const calls = { requests: [] as any[] }
  const rgb = new Uint8Array(4 * 2 * 3 * 2).fill(120)
  on('http.fetch', async (_$, e) => {
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }) as never
    if (e.url.endsWith('/frames')) return json({ width: 4, height: 2, fps: 10, count: 2, rgb: rgb.toBase64() })
    if (e.url.endsWith('/ads/request')) {
      calls.requests.push(JSON.parse(String(e.init?.body)))
      return json({ ad: AD })
    }
    return json({ wallet: WALLET, status: 'served' })
  })
  engineStubs(on)
  const opened: string[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })

  await start($, '/work')
  await submit($, 'go', 't1')
  await clock.advance(600)
  expect(opened).toContain('sidecar')
  await $.turn.complete({ turnId: 't1', answer: 'done' } as never)
  await submit($, 'again', 't2')
  await clock.advance(600)
  expect(toasts.filter((t) => t.includes('sidecar-panel'))).toHaveLength(1)
})

test('SIDECAR_VSCODE_PANEL=off keeps the pane and never looks for a panel', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, { ...ENV, SIDECAR_VSCODE_PANEL: 'off' })
  const clock = mock.clock(on, { now: 1_000_000 })
  const panel = fakePanel(on, () => ({}))
  const calls = { requests: [] as any[], beats: [] as any[], completes: [] as any[] }
  adServer(on, panel, AD, calls)
  engineStubs(on)
  const opened: string[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })

  await start($)
  await submit($, 'go', 't1')
  await clock.advance(600)
  expect(opened).toContain('sidecar')
  expect(panel.contacted).toEqual([])
  expect(toasts).toEqual([])
})

test('a lock file is trusted only when its port, token and pid hold up and the server answers as the panel', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  const locks: Lock[] = [
    // The port is spliced into a URL: it must be a number, or the token could be sent to another host.
    { name: '1.json', body: { port: '1@evil.test', token: TOKEN, pid: 4242 } },
    { name: '2.json', body: { port: 80, token: TOKEN, pid: 4242 } },
    { name: '3.json', body: { port: 50000, token: 'has spaces', pid: 4242 } },
    { name: '4.json', body: { port: 50001, token: TOKEN, pid: 1 } },
    // Another program took a dead window's port: it answers, but not as the panel with this pid.
    { name: '5.json', body: { port: 50002, token: TOKEN, pid: 4242 } },
  ]
  const urls: string[] = []
  on('http.fetch', async (_$: any, e: any) => {
    urls.push(e.url)
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }) as never
    if (e.url === 'http://127.0.0.1:50001/hello') return json({ sidecarPanel: true, pid: 4242, app: 'x', workspaceFolders: ['/work'] })
    if (e.url === 'http://127.0.0.1:50002/hello') return json({ ok: true })
    if (e.url.endsWith('/ads/request')) return json({ ad: AD })
    return json({ wallet: WALLET, status: 'served' })
  })
  on('fs.exists', async () => ({ value: true }) as never)
  on('fs.list', async () => ({ value: locks.map((l) => ({ name: l.name, kind: 'file' })) }) as never)
  on('fs.read', async (_$: any, e: any) => ({ value: JSON.stringify(locks.find((l) => e.path.endsWith(`/${l.name}`))?.body) }) as never)
  engineStubs(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)

  await start($)
  await submit($, 'go', 't1')
  await clock.advance(600)
  const local = urls.filter((u) => u.includes('127.0.0.1') || u.includes('evil'))
  expect(local.every((u) => u.startsWith('http://127.0.0.1:'))).toBe(true)
  // Nothing past /hello went to a window that did not check out: no /sync anywhere.
  expect(urls.some((u) => u.endsWith('/sync'))).toBe(false)
  expect(urls.some((u) => u.includes('evil'))).toBe(false)
})

test('what the panel is sent: the ad and the earnings, never the prompt, the directory or a path', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  const panel = fakePanel(on, () => ({}))
  const calls = { requests: [] as any[], beats: [] as any[], completes: [] as any[] }
  adServer(on, panel, AD, calls)
  engineStubs(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)

  await start($, '/Users/jane/secret-repo')
  const secret = 'rotate the production password for hunter2'
  await submit($, secret, 't1')
  await clock.advance(3000)
  expect(panel.syncs.length).toBeGreaterThan(0)
  for (const sent of panel.syncs) {
    const text = JSON.stringify(sent)
    for (const leak of ['hunter2', 'secret-repo', '/Users/jane', 'rotate the production']) expect(text).not.toContain(leak)
    expect(Object.keys(sent).sort()).toEqual(['client', 'state'])
    expect(Object.keys(sent.state).sort()).toEqual(
      ['ad', 'away', 'earnText', 'isWorking', 'notice', 'paused', 'phase', 'playedMs', 'show', 'wallet'].sort(),
    )
  }
})

test('hostile ad text and a video URL on another host never reach the panel', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  const panel = fakePanel(on, () => ({}))
  const calls = { requests: [] as any[], beats: [] as any[], completes: [] as any[] }
  const esc = String.fromCharCode(27)
  const rlo = String.fromCodePoint(0x202e)
  adServer(on, panel, { ...AD, headline: `Hi${esc}]0;owned${rlo}there`, advertiser: `Evil${esc}[2JCo`, videoUrl: 'https://evil.test/api/media/videos/v.mp4' }, calls)
  engineStubs(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)

  await start($)
  await submit($, 'go', 't1')
  await clock.advance(1500)
  // A video with no acceptable file is not a panel video: the spinner line plays and the panel stays shut.
  expect(panel.syncs.some((s) => s.state?.ad)).toBe(false)

})

test('the panel is sent clean text, and its answers are held to their shape', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  const esc = String.fromCharCode(27)
  // A confused or hostile panel: wrong types everywhere, a huge position, events of unknown kinds.
  const panel = fakePanel(on, () => ({ open: 'yes', playing: 1, currentMs: 'NaN', error: { x: 1 }, events: [{ type: 'rm -rf' }, 7, null] }))
  const calls = { requests: [] as any[], beats: [] as any[], completes: [] as any[] }
  adServer(on, panel, { ...AD, headline: `Hi${esc}]0;owned there` }, calls)
  engineStubs(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)

  await start($)
  await submit($, 'go', 't1')
  await clock.advance(6000)
  const shown = panel.syncs.find((s) => s.state?.ad)
  expect(shown?.state.ad.headline).toBe('Hi]0;owned there')
  expect(JSON.stringify(panel.syncs)).not.toContain(esc)
  // Nothing it said counted as watching.
  expect(calls.beats.every((b) => b.isWatching === false && b.playedMs === 0)).toBe(true)
})

test('a panel that stops answering is dropped: the next ad looks again and falls back to the pane', async ($, on) => {
  mock.store(on, { token: 't', videoQuality: 'blocks' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  const panel = fakePanel(on, () => ({}))
  const calls = { requests: [] as any[], beats: [] as any[], completes: [] as any[] }
  let isGone = false
  adServer(on, panel, AD, calls)
  const inner = panel.answer
  panel.answer = (url, init) => {
    if (isGone) throw new Error('ECONNREFUSED')
    return inner(url, init)
  }
  engineStubs(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)

  await start($)
  await submit($, 'go', 't1')
  await clock.advance(1500)
  const before = panel.syncs.length
  expect(before).toBeGreaterThan(0)
  isGone = true
  await clock.advance(3000)
  // Gone: no more tries on the timer (the sync dropped the panel), and nothing else broke.
  const attempts = panel.contacted.length
  await clock.advance(3000)
  expect(panel.contacted.length).toBe(attempts)
})

test('a reload settles the stale ad in the background and starts clean', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, { ...ENV, SIDECAR_VIDEO_PANE: 'off' })
  const clock = mock.clock(on, { now: 1_000_000 })
  const panel = fakePanel(on, () => ({}))
  const calls = { requests: [] as any[], beats: [] as any[], completes: [] as any[] }
  adServer(on, panel, { ...AD, format: 'text', framesUrl: null, videoUrl: null }, calls)
  engineStubs(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)

  await start($)
  await submit($, 'go', 't1')
  await clock.advance(2000)
  expect(calls.requests.length).toBe(1)
  // The module reloads: session.start fires again while the state keeps the ad.
  await start($)
  await clock.settle()
  expect(calls.completes.at(-1)?.reason).toBe('skipped')
  // The next turn is served a new ad rather than waiting on the stale one.
  await $.turn.complete({ turnId: 't1', answer: 'done' } as never)
  await submit($, 'again', 't2')
  await clock.advance(700)
  expect(calls.requests.length).toBe(2)
})

test('leaving Claude Code closes the panel; a /clear leaves it be', async ($, on) => {
  mock.store(on, { token: 't' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  const panel = fakePanel(on, () => ({}))
  const calls = { requests: [] as any[], beats: [] as any[], completes: [] as any[] }
  adServer(on, panel, AD, calls)
  engineStubs(on)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)

  await start($)
  await submit($, 'go', 't1')
  await clock.advance(1500)
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } } as never)
  expect(panel.syncs.some((s) => s.state?.show === false)).toBe(false)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's', resume: { id: 's' } } as never)
  expect(panel.syncs.at(-1)?.state).toEqual({ show: false })
})

test('an image ad, which has no video file, plays in the pane while the panel stays out of it', async ($, on) => {
  mock.store(on, { token: 't', videoQuality: 'blocks' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  const panel = fakePanel(on, () => ({ currentMs: 0 }))
  const calls = { requests: [] as any[], beats: [] as any[], completes: [] as any[] }
  const rgb = new Uint8Array(4 * 2 * 3 * 2).fill(120)
  on('http.fetch', async (_$: any, e: any) => {
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }) as never
    if (e.url.startsWith('http://127.0.0.1')) return json(panel.answer(e.url, e.init))
    if (e.url.endsWith('/frames')) return json({ width: 4, height: 2, fps: 10, count: 2, rgb: rgb.toBase64() })
    if (e.url.endsWith('/ads/request')) return json({ ad: { ...AD, videoUrl: null } })
    if (e.url.endsWith('/beat')) {
      calls.beats.push(JSON.parse(String(e.init?.body)))
      return json({ status: 'served' })
    }
    return json({ wallet: WALLET })
  })
  engineStubs(on)
  const opened: string[] = []
  on('ui.open', async (_$: any, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })

  await start($)
  await submit($, 'go', 't1')
  await clock.advance(600)
  expect(opened).toContain('sidecar')
  expect(panel.syncs.some((s) => s.state?.ad)).toBe(false)

  const ui = await $.ui.mount({
    plugin: 'sidecar',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidecar',
    props: { title: 'Sponsored', isFocused: false, bodyColumns: 60, placement: 'dock' },
  } as never)
  expect(await ui.find({ type: 'Raster', key: 'video' })).toBeDefined()
  for (let s = 0; s < 6; s++) await clock.advance(1000)
  expect(calls.beats.at(-1)?.isWatching).toBe(true)
  expect(calls.beats.at(-1)?.playedMs).toBeGreaterThan(4000)
  await ui.unmount()
})

test('a panel that cannot start the video in 15s hands the ad to the pane, and that creative skips the panel after', async ($, on) => {
  mock.store(on, { token: 't', videoQuality: 'blocks' })
  mock.env(on, ENV)
  const clock = mock.clock(on, { now: 1_000_000 })
  // Open and on screen, but the video never plays: a failed download or a codec VS Code lacks.
  const panel = fakePanel(on, () => ({ playing: false, currentMs: 0, error: 'tried mp4: decode' }))
  const calls = { requests: [] as any[], beats: [] as any[], completes: [] as any[] }
  const rgb = new Uint8Array(4 * 2 * 3 * 2).fill(120)
  let n = 0
  on('http.fetch', async (_$: any, e: any) => {
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }) as never
    if (e.url.startsWith('http://127.0.0.1')) return json(panel.answer(e.url, e.init))
    if (e.url.endsWith('/frames')) return json({ width: 4, height: 2, fps: 10, count: 2, rgb: rgb.toBase64() })
    if (e.url.endsWith('/ads/request')) return json({ ad: { ...AD, impressionId: `imp_${++n}` } })
    if (e.url.endsWith('/beat')) {
      calls.beats.push(JSON.parse(String(e.init?.body)))
      return json({ status: 'served' })
    }
    if (e.url.endsWith('/complete')) {
      calls.completes.push(JSON.parse(String(e.init?.body)))
      return json({ creditedMicros: 0, isCredited: false, wallet: WALLET })
    }
    return json({ wallet: WALLET })
  })
  engineStubs(on)
  const opened: string[] = []
  on('ui.open', async (_$: any, e: any) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })

  await start($, '/work')
  await submit($, 'go', 't1')
  await clock.advance(600)
  expect(panel.syncs.some((s) => s.state?.ad)).toBe(true)
  for (let s = 0; s < 10; s++) await clock.advance(1000)
  expect(opened).not.toContain('sidecar')

  for (let s = 0; s < 7; s++) await clock.advance(1000)
  expect(opened).toContain('sidecar')
  expect(panel.syncs.at(-1)?.state).toEqual({ show: false })
  const ui = await $.ui.mount({
    plugin: 'sidecar',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'sidecar',
    props: { title: 'Sponsored', isFocused: false, bodyColumns: 60, placement: 'dock' },
  } as never)
  expect(await ui.find({ type: 'Raster', key: 'video' })).toBeDefined()
  for (let s = 0; s < 6; s++) await clock.advance(1000)
  expect(calls.beats.at(-1)?.isWatching).toBe(true)
  await ui.unmount()
  await $.turn.complete({ turnId: 't1', answer: 'done' } as never)

  // The next turn serves the same creative: straight to the pane, the panel is not shown it again.
  const shownBefore = panel.syncs.filter((s) => s.state?.ad).length
  await submit($, 'again', 't2')
  await clock.advance(600)
  await clock.advance(3000)
  expect(panel.syncs.filter((s) => s.state?.ad).length).toBe(shownBefore)
})
