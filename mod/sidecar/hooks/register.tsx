import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LastView, Phase, ServedAd, Wallet } from '../types'
import { cleanAd, cleanUrl, cleanWallet } from './text'
import { decodePack, fitGrid, frameCells, frameRgba, solidCells } from './video'
import type { FramePack } from './video'

const PANE = 'sidecar'
const VIDEO = 'video'
const BEAT_MS = 5000
/** The ad is asked for this soon after the prompt goes in; the pane is already open by then. */
const SHOW_AFTER_MS = 500
/** A video cut off by the end of a turn plays on to its end, but never longer than this. */
const GRACE_MAX_MS = 30_000
/** Pause between one finished ad and the next in a long turn. */
const ROTATE_GAP_MS = 500
/** How often the frame cache is refreshed against the ads that can win right now. */
const PREFETCH_EVERY_MS = 20 * 60_000
/**
 * The person counts as present this long after their last sign of life: a key in
 * the prompt, a prompt or command they submitted, a press, scroll or focus in our
 * pane. Past it the ad freezes and stops counting until they are back.
 */
const PRESENT_MS = 90_000
/** How often presence is rechecked; a return is noticed at once. */
const PRESENCE_CHECK_MS = 2000
/** The fullscreen layout docks the pane beside the chat from this many columns. */
const DOCK_MIN_COLUMNS = 110
/** Below this the inline banner stacks the video over its copy instead of beside it. */
const BANNER_SIDE_BY_SIDE_MIN = 56
/** The progress bar's played part: the orange of the site's bar. */
const BAR_COLOR = '#d97757'
/** Links light up under the pointer, as the buttons do (where the terminal reports it: fullscreen). */
const LINK_HOVER = { backgroundColor: BAR_COLOR }
/** Cells the pane's close mark covers at the right end of the body's first row. */
const CLOSE_MARK_COLUMNS = 2
/** A call to the ad server that has not answered by now is given up on: a hung server must not pile up work. */
const API_TIMEOUT_MS = 8000
/** Frame packs are megabytes: a slow link gets longer. */
const DOWNLOAD_TIMEOUT_MS = 30_000
/** After a failed registration the next attempt waits this long, so a down server or a spent install limit is not asked every turn. */
const REGISTER_RETRY_MS = 5 * 60_000
const REGISTER_LIMITED_RETRY_MS = 60 * 60_000
/**
 * The engine draws the elapsed time, tokens and effort after the spinner's message
 * (`(1m 12s · ↓ 12.3k tokens)`) and the glyph before it: this many columns are not ours.
 */
const SPINNER_CHROME_COLUMNS = 36
const SPINNER_MIN_MESSAGE = 24
const SPONSORED_TAG = ' · Sponsored'

const ad = atom({ plugin: 'sidecar', key: 'ad' } as const, null)
const wallet = atom({ plugin: 'sidecar', key: 'wallet' } as const, null)
const lastView = atom({ plugin: 'sidecar', key: 'lastView' } as const, null)
const isPaused = atom({ plugin: 'sidecar', key: 'isPaused' } as const, false)
const playedMs = atom({ plugin: 'sidecar', key: 'playedMs' } as const, 0)
const phase = atom({ plugin: 'sidecar', key: 'phase' } as const, 'idle')
const notice = atom({ plugin: 'sidecar', key: 'notice' } as const, null)
const isAway = atom({ plugin: 'sidecar', key: 'isAway' } as const, false)

type Timer = { cancel: () => void } | (() => void) | undefined

// Playback lives in module variables: a reload drops the timers with them.
/** Production API origin. */
const DEFAULT_API_BASE = 'https://sidecar.lol'

const play = {
  apiBase: DEFAULT_API_BASE,
  /** Settings come from the environment and the store, read once on first use. */
  isConfigured: false,
  wantsPane: true,
  /**
   * Real pixels (an Image: Ghostty, kitty, iTerm2, WezTerm) unless the person
   * chose `/sidecar blocks`; a terminal that refuses images falls back to blocks.
   */
  wantsPixels: true,
  isImageRefused: false,
  pack: null as FramePack | null,
  /** The sharp PNG frames, when the ad has them and the terminal draws images. */
  hd: null as HdPack | null,
  /** The current ad's sharp pack, fetched only once this terminal has shown an image. */
  hdPending: null as { creativeId: string; url: string } | null,
  /** An Image swap went through: this terminal draws real pixels. */
  isImageConfirmed: false,
  /** The JPEG frames for the Claude desktop app, which draws them in an Svg. */
  desktop: null as DesktopPack | null,
  /** Where the pane draws: the session's surface at start, then the pane's own. */
  surface: null as string | null,
  frame: 0,
  grid: { columns: 48, rows: 14 },
  frameTimer: undefined as Timer,
  beatTimer: undefined as Timer,
  presenceTimer: undefined as Timer,
  showTimer: undefined as Timer,
  graceTimer: undefined as Timer,
  isTurnRunning: false,
  /** Who opened the pane: we close only the one we opened. */
  paneOwner: null as 'us' | 'person' | null,
  isPaneClosedByPerson: false,
  isVideoMounted: false,
  isPrefetching: false,
  cacheDir: '',
  played: 0,
  lastTickAt: 0,
  /** Clock time of the person's last sign of life; 0 before any. */
  lastActiveAt: 0,
  /** The pane was drawn inline in a terminal wide enough to dock it in fullscreen. */
  couldDock: false,
  /** No registration is attempted before this clock time (a failure, or the network's install limit). */
  registerRetryAt: 0,
  registering: null as Promise<boolean> | null,
}

/** Cents from a cent up; a single view's fraction of a cent keeps four places. */
function usd(micros: number): string {
  const dollars = micros / 1_000_000
  return dollars === 0 || dollars >= 0.01 ? `$${dollars.toFixed(2)}` : `$${dollars.toFixed(4)}`
}

/** The footer's figure: whole cents, so a day's earnings read like money. */
function usdCents(micros: number): string {
  if (micros > 0 && micros < 5_000) return '<$0.01'
  return `$${(micros / 1_000_000).toFixed(2)}`
}

/** What the viewer gets for this ad: a share, or nothing for Sidecar's own house ad. */
function earnText(current: ServedAd, suffix: string): string {
  return current.isHouse ? 'House ad, not paid' : `you earn ${usd(current.viewerMicros)}${suffix}`
}

/**
 * The spinner's line: the ad, then the Sponsored mark. An ad line can be 60 characters, more than the
 * row holds at 80 columns beside the time and tokens, and a wrapped spinner jumps the prompt around:
 * cut the ad's text to fit, never the mark.
 */
function spinnerMessage(text: string, columns?: number): string {
  const room = columns ? Math.max(SPINNER_MIN_MESSAGE, columns - SPINNER_CHROME_COLUMNS) - SPONSORED_TAG.length : text.length
  const line = text.length > room ? `${text.slice(0, Math.max(1, room - 1)).trimEnd()}…` : text
  return `${line}${SPONSORED_TAG}`
}

function clockText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function stopTimer(timer: Timer): undefined {
  if (typeof timer === 'function') timer()
  else timer?.cancel()
  return undefined
}

/**
 * Nothing to set at install: the server is DEFAULT_API_BASE and the pane is on.
 * Developers point at another server with SIDECAR_API_BASE and turn the pane
 * off with SIDECAR_VIDEO_PANE=off; `/sidecar pixels` is remembered.
 */
async function configure($: EngineInterface) {
  if (play.isConfigured) return
  play.isConfigured = true
  const base = (await $.env.get('SIDECAR_API_BASE'))?.trim()
  play.apiBase = (base || DEFAULT_API_BASE).replace(/\/+$/, '')
  play.wantsPane = (await $.env.get('SIDECAR_VIDEO_PANE'))?.trim().toLowerCase() !== 'off'
  play.wantsPixels = (await $.store.get('videoQuality')) !== 'blocks'
}

/** A fetch that gives up after `ms`: the host's own fetch has no timeout, and a hung server must not hold a hook or pile up beats. */
async function fetchWithin($: EngineInterface, url: string, init: Parameters<EngineInterface['http']['fetch']>[1], ms: number) {
  let timer: Timer
  const timeout = new Promise<never>((_, reject) => {
    timer = $.clock.after(ms, () => reject(new Error(`sidecar: no answer in ${Math.round(ms / 1000)}s`))) as Timer
  })
  try {
    return await Promise.race([$.http.fetch(url, init), timeout])
  } finally {
    stopTimer(timer)
  }
}

/** Runs a timer's work so a throw never escapes into the host (a rejection from a 100ms tick would repeat 10 times a second). */
function guarded(work: () => Promise<unknown>) {
  return async () => {
    try {
      await work()
    } catch {
      // The next tick or beat tries again.
    }
  }
}

async function api($: EngineInterface, path: string, body?: unknown, retried = false): Promise<unknown> {
  await configure($)
  const token = (await $.store.get('token')) as string | undefined
  const res = await fetchWithin(
    $,
    `${play.apiBase}/api/v1${path}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    API_TIMEOUT_MS,
  )
  // The server no longer knows this device (new database, revoked token, a different apiBase):
  // forget the token, register again, and retry once.
  if (res.status === 401 && token && path !== '/devices' && !retried) {
    await $.store.set('token', '')
    if (await ensureDevice($)) return api($, path, body, true)
  }
  if (!res.ok) throw Object.assign(new Error(`sidecar ${path}: HTTP ${res.status}`), { status: res.status })
  return JSON.parse(res.text) as unknown
}

async function refreshWallet($: EngineInterface): Promise<Wallet | null> {
  try {
    const got = (await api($, '/me')) as { wallet: Wallet }
    const safe = cleanWallet(got.wallet, play.apiBase)
    await update($, wallet, () => safe)
    return safe
  } catch {
    return null
  }
}

/** One registration at a time: the start-up one and a first prompt's must not both spend an install. */
function ensureDevice($: EngineInterface): Promise<boolean> {
  play.registering ??= registerDevice($).finally(() => {
    play.registering = null
  })
  return play.registering
}

async function registerDevice($: EngineInterface): Promise<boolean> {
  if (await $.store.get('token')) return true
  // A failed registration is not repeated every turn: a down server or a spent install limit would be asked again and again.
  if ((await $.clock.now()) < play.registerRetryAt) return false
  try {
    const version = await $.session.version()
    const made = (await api($, '/devices', { client: 'claude-code', version: version.version })) as {
      token?: unknown
      deviceId?: unknown
    }
    // A captive portal or proxy can answer 200 with something else: only a real token counts.
    if (typeof made.token !== 'string' || !made.token) throw new Error('sidecar /devices: no token')
    await $.store.set('token', made.token)
    if (typeof made.deviceId === 'string') await $.store.set('deviceId', made.deviceId)
    play.registerRetryAt = 0
    return true
  } catch (error) {
    const isLimited = (error as { status?: number }).status === 429
    play.registerRetryAt = (await $.clock.now()) + (isLimited ? REGISTER_LIMITED_RETRY_MS : REGISTER_RETRY_MS)
    await update($, notice, () =>
      isLimited ? 'Too many new installs from this network today; ads are off until tomorrow.' : 'Ad server unreachable; ads are off for now.',
    )
    return false
  }
}

/** `blocks` is the block pack; `hd` the sharp pack's index; `hd.<i>` its parts. */
function cachePath(creativeId: string, kind = 'blocks'): string {
  // `hd2`: the first sharp packs were single files over the 4 MiB limit and got cut off.
  return `${play.cacheDir}/${creativeId.replace(/[^\w-]/g, '_')}${kind === 'blocks' ? '' : `.${kind.replace('hd', 'hd2')}`}.json`
}

/** Downloads a frame pack (or a part of one) once; later plays read it from disk. */
async function cachePack($: EngineInterface, creativeId: string, url: string, kind = 'blocks'): Promise<string | null> {
  const path = cachePath(creativeId, kind)
  if (play.cacheDir && (await $.fs.exists(path))) return $.fs.read(path)
  const res = await fetchWithin($, url, undefined, DOWNLOAD_TIMEOUT_MS)
  if (!res.ok) return null
  if (play.cacheDir) await $.fs.write(path, res.text)
  return res.text
}

type HdPack = { width: number; height: number; fps: number; count: number; png: string[] }

/**
 * Fetches a sharp pack: its index, then each part (each under the 4 MiB a
 * fetch or a file may hold), joined back into one list of PNG frames.
 */
async function fetchHd($: EngineInterface, creativeId: string, url: string): Promise<HdPack | null> {
  try {
    const indexText = await cachePack($, creativeId, url, 'hd')
    if (!indexText) return null
    const index = JSON.parse(indexText) as { width?: number; height?: number; fps?: number; count?: number; parts?: number[] }
    if (!index.width || !index.height || !Array.isArray(index.parts) || index.parts.length === 0) return null
    const png: string[] = []
    for (let i = 0; i < index.parts.length; i++) {
      const sep = url.includes('?') ? '&' : '?'
      const partText = await cachePack($, creativeId, `${url}${sep}part=${i}`, `hd.${i}`)
      if (!partText) return null
      const part = JSON.parse(partText) as { start?: number; png?: string[] }
      if (part.start !== png.length || !Array.isArray(part.png)) return null
      png.push(...part.png)
    }
    if (png.length !== index.count) return null
    return { width: index.width, height: index.height, fps: index.fps ?? 10, count: png.length, png }
  } catch {
    return null
  }
}

function wantsImage(): boolean {
  return play.wantsPixels && !play.isImageRefused
}

type DesktopPack = { fps: number; count: number; jpeg: string[] }

/** The most frames and parts a desktop pack may have. */
const DESKTOP_MAX_FRAMES = 300
const DESKTOP_MAX_PARTS = 20
/** The most characters one frame may add to an Svg, which holds 131,072. */
const DESKTOP_MAX_FRAME_CHARS = 120_000
/** Prefetch warms at most this many desktop packs per pass, to bound the download. */
const DESKTOP_PREFETCH_PACKS = 3
/** A frame is spliced into Svg markup, so only base64 JPEG may pass: nothing in it can close the attribute or add an element. */
const JPEG_BASE64 = /^\/9j\/[A-Za-z0-9+/]*={0,2}$/

/** Fetches a desktop pack: its index, then each part, joined back into one list of JPEG frames. */
async function fetchDesktop($: EngineInterface, creativeId: string, url: string): Promise<DesktopPack | null> {
  try {
    const indexText = await cachePack($, creativeId, url, 'desktop')
    if (!indexText) return null
    const index = JSON.parse(indexText) as { fps?: number; count?: number; parts?: number[] }
    if (!Array.isArray(index.parts) || index.parts.length === 0 || index.parts.length > DESKTOP_MAX_PARTS) return null
    const jpeg: string[] = []
    for (let i = 0; i < index.parts.length; i++) {
      const sep = url.includes('?') ? '&' : '?'
      const partText = await cachePack($, creativeId, `${url}${sep}part=${i}`, `desktop.${i}`)
      if (!partText) return null
      const part = JSON.parse(partText) as { start?: number; jpeg?: string[] }
      if (part.start !== jpeg.length || !Array.isArray(part.jpeg)) return null
      for (const frame of part.jpeg) {
        if (typeof frame !== 'string' || frame.length > DESKTOP_MAX_FRAME_CHARS || !JPEG_BASE64.test(frame)) return null
        jpeg.push(frame)
      }
      if (jpeg.length > DESKTOP_MAX_FRAMES) return null
    }
    if (jpeg.length !== index.count) return null
    return { fps: index.fps ?? 10, count: jpeg.length, jpeg }
  } catch {
    return null
  }
}

/**
 * True where the pane draws an Svg but no Image or Raster: the Claude desktop app.
 * The desktop app attaches after session.start, which then reports no surface, so ask the session.
 */
async function isSvgSurface($: EngineInterface): Promise<boolean> {
  if (!play.surface) {
    const surfaces = await $.session.surfaces()
    play.surface = surfaces.find((s) => s !== 'terminal') ?? surfaces[0] ?? null
  }
  return play.surface === 'desktop'
}

/** The current frame as an Image source: a sharp PNG when there is one, else the block pack's pixels. */
function pictureSource(pack: FramePack) {
  if (play.hd) return { png: play.hd.png[play.frame % play.hd.count]! }
  return { rgba: frameRgba(pack, play.frame), width: pack.width, height: pack.height }
}

/** Fills the cache with every video that could win the pane, between turns. */
async function prefetch($: EngineInterface) {
  await configure($)
  if (play.isPrefetching || play.isTurnRunning || !play.wantsPane) return
  play.isPrefetching = true
  try {
    const live = (await api($, '/creatives/live')) as { creatives: { id: string; framesUrl: string; hdUrl?: string; desktopUrl?: string }[] }
    let desktopPacks = 0
    for (const c of live.creatives) {
      if (play.isTurnRunning) break
      await cachePack($, c.id, c.framesUrl).catch(() => null)
      if (wantsImage() && play.isImageConfirmed && c.hdUrl) await fetchHd($, c.id, c.hdUrl)
      // A desktop pack is several MB: warm the first few (the highest bids), the rest download when they win.
      if (c.desktopUrl && desktopPacks < DESKTOP_PREFETCH_PACKS && (await isSvgSurface($))) {
        desktopPacks++
        await fetchDesktop($, c.id, cleanUrl(c.desktopUrl))
      }
    }
  } catch {
    // Offline: the next turn downloads what it wins.
  } finally {
    play.isPrefetching = false
  }
}

function stopPlaybackTimers() {
  play.frameTimer = stopTimer(play.frameTimer)
  play.beatTimer = stopTimer(play.beatTimer)
}

async function setPhase($: EngineInterface, next: Phase) {
  await update($, phase, () => next)
}

/** Milliseconds since the person's last sign of life, as the server reads presence. */
function idleMs(now: number): number {
  return play.lastActiveAt ? Math.max(0, Math.round(now - play.lastActiveAt)) : Number.MAX_SAFE_INTEGER
}

function isPresentAt(now: number): boolean {
  return play.lastActiveAt > 0 && now - play.lastActiveAt <= PRESENT_MS
}

/**
 * True while the ad is actually being seen: the person is here, and the spinner
 * runs while Claude works or the pane is drawn.
 */
async function isWatching($: EngineInterface): Promise<boolean> {
  const current = await read($, ad)
  const now = await read($, phase)
  if (!current || (await read($, isAway))) return false
  if (current.format === 'text') return play.isTurnRunning && now === 'playing'
  return play.isVideoMounted && (now === 'playing' || now === 'grace')
}

/** Opens the pane for a video; says whether it is on screen (a narrow terminal leaves it waiting). */
async function placePane($: EngineInterface): Promise<boolean> {
  await configure($)
  if (!play.wantsPane || play.isPaneClosedByPerson) return false
  if (play.paneOwner === 'person') return true
  const opened = await $.ui.open({ id: PANE, title: 'Sponsored', rows: 10, columns: 48 })
  if (opened.isPlaced) {
    play.paneOwner = play.paneOwner ?? 'us'
    return true
  }
  // Waiting undrawn would pop it open later at a random moment: take it back.
  await $.ui.close({ id: PANE })
  return false
}

/**
 * Opens the pane as the person sends a prompt. A pane opened on their prompt is
 * placed at any width (above the prompt on the main screen, docked in
 * fullscreen); one opened later from a timer needs 144 columns. The ad fills it
 * once Claude has worked a few seconds; a turn that ends first closes it.
 */
async function openPaneForPrompt($: EngineInterface) {
  try {
    await configure($)
    if (!play.wantsPane || play.isPaneClosedByPerson || play.paneOwner || (await read($, isPaused))) return
    const opened = await $.ui.open({ id: PANE, title: 'Sponsored', rows: 10, columns: 48 })
    if (opened.isPlaced) play.paneOwner = 'us'
    else await $.ui.close({ id: PANE })
  } catch {
    // A prompt never waits on the pane.
  }
}

async function closeOurPane($: EngineInterface) {
  if (play.paneOwner !== 'us') return
  play.paneOwner = null
  play.isVideoMounted = false
  await $.ui.close({ id: PANE })
}

async function endPlayback($: EngineInterface, reason: 'complete' | 'skipped' | 'expired') {
  stopPlaybackTimers()
  play.graceTimer = stopTimer(play.graceTimer)
  const current = await read($, ad)
  await update($, ad, () => null)
  await setPhase($, 'idle')
  play.pack = null
  play.hd = null
  play.hdPending = null
  play.desktop = null
  // Nothing left to show and Claude is done: give the screen back rather than an empty pane.
  if (!play.isTurnRunning) await closeOurPane($)
  if (!current || reason === 'expired') return
  try {
    const done = (await api($, `/impressions/${current.impressionId}/complete`, {
      playedMs: Math.round(play.played),
      reason,
      idleMs: idleMs(await $.clock.now()),
    })) as { creditedMicros: number; isCredited: boolean; wallet: Wallet }
    const safeWallet = cleanWallet(done.wallet, play.apiBase)
    await update($, wallet, () => safeWallet)
    const view: LastView = {
      advertiser: current.advertiser,
      creditedMicros: done.creditedMicros,
      isCredited: done.isCredited,
      isHouse: current.isHouse === true,
    }
    await update($, lastView, () => view)
  } catch {
    // The server settles from the last heartbeat.
  }
}

/** Reports played time; the server credits a stretch only if it began while watching. */
async function beat($: EngineInterface) {
  const current = await read($, ad)
  if (!current) return
  await update($, playedMs, () => Math.round(play.played))
  try {
    const res = (await api($, `/impressions/${current.impressionId}/beat`, {
      playedMs: Math.round(play.played),
      isWatching: await isWatching($),
      idleMs: idleMs(await $.clock.now()),
    })) as { status: string }
    // Paused past the server's window: it settled the impression. Drop it.
    if (res.status !== 'served') await endPlayback($, 'expired')
  } catch {
    // A missed beat only costs the viewer credit for that stretch.
  }
}

async function tick($: EngineInterface) {
  const current = await read($, ad)
  if (!current) return
  const now = await $.clock.now()
  if (await isWatching($)) play.played += now - play.lastTickAt
  play.lastTickAt = now
  // The clock and bar move each second, not just on the 5s beat.
  if (Math.floor(play.played / 1000) !== Math.floor((await read($, playedMs)) / 1000)) {
    await update($, playedMs, () => Math.round(play.played))
  }
  const at = await read($, phase)
  // Away, the picture holds its frame.
  if (play.desktop && play.isVideoMounted && (at === 'playing' || at === 'grace') && !(await read($, isAway))) {
    // The desktop app has nothing to blit into: each frame is a redraw of the pane's Svg.
    play.frame = (play.frame + 1) % play.desktop.count
    $.ui.invalidate('ui.render')
  } else if (play.pack && play.isVideoMounted && (at === 'playing' || at === 'grace') && !(await read($, isAway))) {
    play.frame = (play.frame + 1) % play.pack.count
    const size = { requestId: PANE, key: VIDEO, columns: play.grid.columns, rows: play.grid.rows }
    if (wantsImage()) {
      const shown = await $.ui.blit({ ...size, source: pictureSource(play.pack) })
      if (!('deny' in shown && shown.deny)) {
        play.isImageConfirmed = true
        // Real pixels work here: now the sharp frames are worth the download.
        if (play.hdPending && !play.hd) {
          const { creativeId, url } = play.hdPending
          play.hdPending = null
          void loadHd($, creativeId, url)
        }
      }
      if ('deny' in shown && shown.deny) {
        // This terminal draws no images (or tmux is between): blocks from here on.
        play.isImageRefused = true
        play.hd = null
        play.hdPending = null
        $.ui.invalidate('ui.render')
      }
    } else {
      await $.ui.blit({ ...size, cells: frameCells(play.pack, play.frame, play.grid.columns, play.grid.rows) })
    }
  }
  if (play.played >= current.durationMs) await finish($)
}

function startPlaybackTimers($: EngineInterface) {
  stopPlaybackTimers()
  const fps = play.desktop?.fps ?? play.pack?.fps ?? 4
  play.frameTimer = $.clock.every(Math.round(1000 / fps), guarded(() => tick($))) as Timer
  play.beatTimer = $.clock.every(BEAT_MS, guarded(() => beat($))) as Timer
}

/** The ad played out: settle it, then queue the next one if Claude is still working. */
async function finish($: EngineInterface) {
  await endPlayback($, 'complete')
  if (play.isTurnRunning) {
    play.showTimer = stopTimer(play.showTimer)
    play.showTimer = $.clock.after(ROTATE_GAP_MS, guarded(() => onWorking($))) as Timer
  } else {
    await closeOurPane($)
  }
}

async function startAd($: EngineInterface) {
  if (await read($, isPaused)) return
  // Nobody to see it: ask for nothing until they are back.
  if (!(await checkPresence($))) return
  if (!(await ensureDevice($))) return
  const canShowVideo = await placePane($)
  let served: ServedAd | null = null
  try {
    const res = (await api($, '/ads/request', {
      placements: canShowVideo ? ['spinner', 'pane'] : ['spinner'],
      idleMs: idleMs(await $.clock.now()),
    })) as { ad: ServedAd | null }
    served = res.ad ? cleanAd(res.ad, play.apiBase) : null
    await update($, notice, () => null)
  } catch (error) {
    // A device asking too fast is told to slow down: that is no outage, so no ad this turn and nothing said.
    const isSlowedDown = (error as { status?: number }).status === 429
    await update($, notice, () => (isSlowedDown ? null : 'Ad server unreachable; no ad this turn.'))
  }
  if (!served || !play.isTurnRunning) {
    // Nothing to show, or Claude finished while we asked: the impression settles unpaid on the server.
    if (!served || served.format === 'text') await closeOurPane($)
    if (!served) return
  }

  play.played = 0
  play.frame = 0
  play.pack = null
  play.hd = null
  play.hdPending = null
  play.desktop = null
  play.lastTickAt = await $.clock.now()
  await update($, playedMs, () => 0)
  await update($, ad, () => served)
  await setPhase($, 'playing')

  if (served.format === 'video' && served.framesUrl) {
    try {
      const text = await cachePack($, served.creativeId, served.framesUrl)
      if (text) play.pack = decodePack(text)
      // The sharp frames are bigger: the block pack starts the ad, and they take over once
      // the terminal has shown an image (a terminal without images never downloads them).
      if (served.desktopUrl && (await isSvgSurface($))) {
        // The desktop app shows real frames in an Svg; the block pack is only for terminals.
        play.desktop = await fetchDesktop($, served.creativeId, served.desktopUrl)
      } else if (wantsImage() && served.hdUrl) {
        if (play.isImageConfirmed) void loadHd($, served.creativeId, served.hdUrl)
        else play.hdPending = { creativeId: served.creativeId, url: served.hdUrl }
      }
      $.ui.invalidate('ui.render')
    } catch {
      play.pack = null
      play.hd = null
      play.hdPending = null
    }
  } else {
    await closeOurPane($)
  }
  startPlaybackTimers($)
}

async function loadHd($: EngineInterface, creativeId: string, url: string) {
  try {
    const hd = await fetchHd($, creativeId, url)
    // Still the same ad, and the terminal still takes images.
    if (hd && wantsImage() && (await read($, ad))?.creativeId === creativeId) {
      play.hd = hd
      $.ui.invalidate('ui.render')
    }
  } catch {
    // The block pack plays on.
  }
}

/** Claude stopped mid-ad: stop counting, report the last stretch, give the screen back. */
async function pause($: EngineInterface) {
  play.graceTimer = stopTimer(play.graceTimer)
  if (!(await read($, ad))) return
  stopPlaybackTimers()
  await setPhase($, 'paused')
  await beat($)
  await closeOurPane($)
}

/** The next turn picks a paused ad up where it stopped. */
async function resume($: EngineInterface) {
  const current = await read($, ad)
  if (!current) return startAd($)
  if (current.format === 'video' && !(await placePane($))) return endPlayback($, 'skipped')
  play.lastTickAt = await $.clock.now()
  await setPhase($, 'playing')
  await beat($)
  if (await read($, ad)) startPlaybackTimers($)
  else await startAd($)
}

/** Claude has been working for a few seconds: show an ad, or carry on the paused one. */
async function onWorking($: EngineInterface) {
  if (!play.isTurnRunning) return
  const at = await read($, phase)
  if (at === 'paused') return resume($)
  if (!(await read($, ad))) return startAd($)
}

/** Notes the person's sign of life; coming back from away picks the ad up again. */
async function markActive($: EngineInterface) {
  play.lastActiveAt = await $.clock.now()
  if (!(await read($, isAway))) return
  await update($, isAway, () => false)
  play.lastTickAt = play.lastActiveAt
  $.ui.invalidate('ui.render')
  if (await read($, ad)) {
    // Tell the server at once that the stretch from here counts again.
    await beat($)
  }
  if (play.isTurnRunning && !(await read($, ad))) await onWorking($)
}

/** Goes away once the person has been quiet too long; says whether they are present. */
async function checkPresence($: EngineInterface): Promise<boolean> {
  const now = await $.clock.now()
  if (isPresentAt(now)) return true
  if (!(await read($, isAway))) {
    await update($, isAway, () => true)
    $.ui.invalidate('ui.render')
    // Close the stretch now: from this beat on nothing counts.
    if (await read($, ad)) await beat($)
  }
  return false
}

function ensurePresenceTimer($: EngineInterface) {
  play.presenceTimer ??= $.clock.every(PRESENCE_CHECK_MS, guarded(() => checkPresence($))) as Timer
}

/** Whether a prompt or command came from the person rather than a schedule, a peer or code. */
function isPersonOrigin(origin: { kind: string } | undefined): boolean {
  return origin?.kind === 'composer' || origin?.kind === 'bridge'
}

async function setPaused($: EngineInterface, paused: boolean) {
  await update($, isPaused, () => paused)
  if (paused) {
    await endPlayback($, 'skipped')
    await closeOurPane($)
  } else {
    play.isPaneClosedByPerson = false
    await refreshWallet($)
  }
}

export const register: Register = (on) => {
  // A reload reads the environment and store again.
  play.isConfigured = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    play.surface = e.surface
    await $.command.register({
      name: 'sidecar',
      description: 'Sidecar ads: open the ad pane, or `pause`, `resume`, `link`, `wallet`, `pixels`, `blocks`',
    })
    // Launching Claude Code is the person at the keyboard.
    play.lastActiveAt = await $.clock.now()
    // Older builds pinned a status notice; the footer hint carries the figure now.
    $.ui.status(undefined)
    const home = await $.env.get('HOME')
    play.cacheDir = home ? `${home}/.cache/sidecar/frames` : ''
    // Nothing here waits on the network: a slow or hung server must never hold up the session starting.
    void guarded(async () => {
      if (await ensureDevice($)) await refreshWallet($)
      await prefetch($)
    })()
    $.clock.every(PREFETCH_EVERY_MS, guarded(() => prefetch($)))
    ensurePresenceTimer($)
    return started
  })

  // Signs of life. Each one passes straight through; only the timestamp is kept.
  on('prompt.edit', async ($, e, next) => {
    await markActive($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (isPersonOrigin(e.origin)) {
      await markActive($)
      await openPaneForPrompt($)
    }
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (isPersonOrigin(e.origin)) await markActive($)
    return next(e)
  })

  on('ui.press', async ($, e, next) => {
    if (e.plugin === 'sidecar') await markActive($)
    return next(e)
  })

  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    await markActive($)
    return next(e)
  })

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    await markActive($)
    return next(e)
  })

  // Earnings ride at the end of the dim hint line under the prompt.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const w = await read($, wallet)
    // The engine's own hint takes most of a narrow row: say less there.
    const isNarrow = (e.viewport?.columns ?? 200) < 80
    const mine = (await read($, isPaused))
      ? 'Sidecar · paused'
      : w
        ? `Sidecar · ${usdCents(w.todayMicros)}${isNarrow ? '' : ' today'}${(await read($, isAway)) ? ' · away' : ''}`
        : null
    if (!mine) return next(e)
    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${mine}` : mine } })
  })

  on('turn.start', async ($, e, next) => {
    play.isTurnRunning = true
    ensurePresenceTimer($)
    play.graceTimer = stopTimer(play.graceTimer)
    // A video still in its grace window simply keeps playing into the new turn.
    if ((await read($, phase)) === 'grace') await setPhase($, 'playing')
    play.showTimer = stopTimer(play.showTimer)
    play.showTimer = $.clock.after(SHOW_AFTER_MS, guarded(() => onWorking($))) as Timer
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    play.isTurnRunning = false
    play.showTimer = stopTimer(play.showTimer)
    const current = await read($, ad)
    if (!current) {
      await closeOurPane($)
    } else if (current.format === 'text') {
      // The spinner is gone with the turn; the line resumes on the next one.
      await pause($)
    } else if ((await read($, phase)) === 'playing') {
      // Claude is done but the video is not: let it play out while they read the answer.
      await setPhase($, 'grace')
      const left = Math.min(GRACE_MAX_MS, Math.max(0, current.durationMs - play.played) + 1000)
      play.graceTimer = $.clock.after(
        left,
        guarded(async () => {
          if ((await read($, phase)) === 'grace') await pause($)
        }),
      ) as Timer
    }
    void prefetch($)
    // Once: the fullscreen layout docks the pane beside the chat instead of above the prompt.
    if (play.couldDock && !(await $.store.get('dockTipShown'))) {
      await $.store.set('dockTipShown', true)
      $.ui.toast('Tip: /tui fullscreen shows ads beside your chat', { timeoutMs: 8000 })
    }
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      const byPerson = e.origin.kind === 'person'
      play.paneOwner = null
      play.isVideoMounted = false
      if (byPerson) {
        play.isPaneClosedByPerson = true
        const current = await read($, ad)
        if (current?.format === 'video') await endPlayback($, 'skipped')
      }
    }
    return next(e)
  })

  on('command.run', { command: 'sidecar' }, async ($, e) => {
    // Answered here without `next`, so the sign-of-life hook above never sees it.
    if (isPersonOrigin(e.origin)) await markActive($)
    const arg = e.args.trim().toLowerCase()
    if (arg === 'pause') {
      await setPaused($, true)
      return { text: 'Sidecar paused. No ads, no earnings until `/sidecar resume`.' }
    }
    if (arg === 'pixels' || arg === 'blocks') {
      await $.store.set('videoQuality', arg)
      play.wantsPixels = arg === 'pixels'
      play.isImageRefused = false
      if (arg === 'blocks') play.hd = null
      $.ui.invalidate('ui.render')
      return {
        text:
          arg === 'pixels'
            ? 'Sidecar video in full pixels (Ghostty, kitty; other terminals fall back to blocks).'
            : 'Sidecar video in text blocks, which work in every terminal.',
      }
    }
    if (arg === 'resume') {
      await setPaused($, false)
      return { text: 'Sidecar resumed. Ads play while Claude works.' }
    }
    const w = await refreshWallet($)
    if (!w) return { text: 'Sidecar could not reach the ad server.' }
    if (arg === 'link') {
      return { text: `Link this machine to your Sidecar account to get paid:\n${w.claimUrl}` }
    }
    if (arg === 'wallet') {
      const linkLine = w.isClaimed ? '' : `\nNot linked yet: ${w.claimUrl}`
      return {
        text: `Today ${usd(w.todayMicros)} · pending ${usd(w.pendingMicros)} · lifetime ${usd(w.lifetimeMicros)}${linkLine}`,
      }
    }
    play.isPaneClosedByPerson = false
    play.paneOwner = 'person'
    await $.ui.open({ id: PANE, title: 'Sponsored' })
    return { text: 'Sidecar pane opened.' }
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const current = await read($, ad)
    if (!current || (await read($, isPaused)) || (await read($, isAway)) || (await read($, phase)) !== 'playing') return next(e)
    return next({ ...e, props: { ...e.props, message: spinnerMessage(current.spinnerText, e.viewport?.columns) } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const current = await read($, ad)
    const w = await read($, wallet)
    const last = await read($, lastView)
    const paused = await read($, isPaused)
    const why = await read($, notice)
    const ms = await read($, playedMs)
    const at = await read($, phase)
    const away = await read($, isAway)
    const width = Math.max(20, e.props.bodyColumns)
    play.surface = e.surface

    // Pressed by a click in fullscreen, or by its key once the pane has focus (ctrl+x tab).
    // The pane's own ✕ closes it; no Hide or Skip that would only cut the ad short.
    const buttons = (
      <Box>
        <Button key="pause" hotkey="p" label={paused ? 'Resume ads' : 'Pause ads'} dimColor onPress={() => setPaused($, !paused)} />
        {w && !w.isClaimed && (
          <Box key="claim" marginLeft={2} hover={LINK_HOVER}>
            <Link href={w.claimUrl} label="Get paid →" />
          </Box>
        )}
      </Box>
    )

    if (!current && play.paneOwner === 'us' && !paused) {
      // Opened on the prompt, the ad a moment away: one quiet line, not an empty panel.
      play.isVideoMounted = false
      return (
        <Text>
          <Text color="yellow">Sponsored</Text>
          <Text dimColor> · {away ? "paused while you're away" : (why ?? 'loading…')}</Text>
        </Text>
      )
    }

    if (!current) {
      play.isVideoMounted = false
      const idle = paused
        ? 'Ads are paused.'
        : away
          ? "Paused while you're away"
          : (why ?? 'Ads play here while Claude works.')
      return (
        <Box flexDirection="column" width={width}>
          <Text>
            <Text bold>Sidecar</Text>
            <Text dimColor> · {idle}</Text>
          </Text>
          {last && (
            <Text dimColor>
              Last: {last.advertiser} ·{' '}
              {last.isHouse ? 'house ad, not paid' : last.isCredited ? `+${usd(last.creditedMicros)}` : 'not counted'}
            </Text>
          )}
          <Box marginTop={1}>{buttons}</Box>
        </Box>
      )
    }

    // The pane's close mark takes the top-right cells: keep the clock clear of it.
    const header = (columns: number) => (
      <Box justifyContent="space-between" width={Math.max(10, columns - CLOSE_MARK_COLUMNS)}>
        <Text wrap="truncate-end">
          <Text color="yellow">Sponsored</Text> · <Text bold>{current.advertiser}</Text>
        </Text>
        <Text dimColor>
          {clockText(ms)} / {clockText(current.durationMs)}
        </Text>
      </Box>
    )
    const bar = (columns: number) => {
      const filled = Math.max(0, Math.min(columns, Math.round((ms / current.durationMs) * columns)))
      return (
        <Text>
          <Text color={BAR_COLOR}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'━'.repeat(columns - filled)}</Text>
        </Text>
      )
    }
    // The note sits under the link: a terminal without hyperlinks prints the URL after the label.
    const cta = (columns: number) => (
      <Box flexDirection="column" width={columns}>
        <Box key="cta" hover={LINK_HOVER}>
          <Link href={current.clickUrl} label={`${current.ctaLabel} →`} />
        </Box>
        <Text dimColor>{earnText(current, ' for this view')}</Text>
      </Box>
    )
    const status = away ? (
      <Text color="yellow">Paused while you're away</Text>
    ) : null
    const wallet$ = w && (
      <Text dimColor>
        Today {usd(w.todayMicros)} · lifetime {usd(w.lifetimeMicros)}
      </Text>
    )

    play.isVideoMounted = true
    if (e.surface === 'terminal' && current.format === 'video') {
      const { Raster, Image } = $.ui.resolve(e)
      // Docked beside the transcript (fullscreen) the video fills the pane's width. Inline above
      // the prompt (the main screen) it is a short banner: a small video with the copy beside it.
      const isBanner = e.props.placement === 'inline'
      if (isBanner && (e.viewport?.columns ?? 0) >= DOCK_MIN_COLUMNS) play.couldDock = true
      // A narrow terminal has no room for copy beside the video: stack them.
      const isStacked = isBanner && width < BANNER_SIDE_BY_SIDE_MIN
      const videoWidth = isStacked
        ? Math.min(34, width)
        : isBanner
          ? Math.min(34, Math.max(16, Math.floor(width * 0.32)))
          : width
      const maxRows = isBanner ? 7 : Math.max(6, (e.viewport?.rows ?? 40) - 18)
      play.grid = fitGrid(play.pack ?? { width: 16, height: 9 }, videoWidth, maxRows)
      const { columns, rows } = play.grid
      const picture =
        play.pack && wantsImage() ? (
          <Image
            key={VIDEO}
            columns={columns}
            rows={rows}
            alt={`${current.advertiser} video`}
            source={pictureSource(play.pack)}
          />
        ) : (
          <Raster
            key={VIDEO}
            columns={columns}
            rows={rows}
            cells={play.pack ? frameCells(play.pack, play.frame, columns, rows) : solidCells(columns, rows, current.posterColor)}
          />
        )
      const video = (
        <Box flexDirection="column" width={columns}>
          {picture}
          {bar(columns)}
        </Box>
      )

      if (isBanner && !isStacked) {
        const side = Math.max(20, width - columns - 2)
        return (
          <Box flexDirection="row">
            {video}
            {/* Five lines, the video's height: no spacers, or the pane scrolls the buttons away. */}
            <Box flexDirection="column" marginLeft={2} width={side}>
              {header(side)}
              <Text bold wrap="truncate-end">{current.headline}</Text>
              <Text dimColor wrap="truncate-end">{current.body}</Text>
              <Box>
                <Box key="cta" hover={LINK_HOVER}>
                  <Link href={current.clickUrl} label={`${current.ctaLabel} →`} />
                </Box>
                <Text dimColor wrap="truncate-end">{'   '}{earnText(current, '')}</Text>
              </Box>
              {status ?? buttons}
            </Box>
          </Box>
        )
      }

      // Docked (and the narrow stacked banner): one column, as the site shows it.
      const column = isStacked ? width : Math.max(columns, width)
      return (
        <Box flexDirection="column" width={column}>
          {header(column)}
          {video}
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{current.headline}</Text>
            <Text dimColor>{current.body}</Text>
          </Box>
          <Box marginTop={1}>{cta(column)}</Box>
          {status}
          {!isStacked && <Box marginTop={1}>{wallet$}</Box>}
          <Box marginTop={isStacked ? 1 : 0}>{buttons}</Box>
        </Box>
      )
    }

    // The desktop app draws an Svg: the frame is a JPEG inside one, with the progress bar in the
    // same document under it, so the bar is always the video's width.
    let picture = null
    if (e.surface === 'desktop' && current.format === 'video' && play.desktop) {
      const { Svg } = $.ui.resolve(e)
      const filled = (Math.max(0, Math.min(1, play.played / current.durationMs)) * 640).toFixed(1)
      picture = (
        <Svg
          key={VIDEO}
          alt={`${current.advertiser} video`}
          source={
            `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="370" viewBox="0 0 640 370">` +
            `<image width="640" height="360" href="data:image/jpeg;base64,${play.desktop.jpeg[play.frame % play.desktop.count]}"/>` +
            `<rect y="360" width="640" height="10" fill="#888" fill-opacity="0.35"/>` +
            `<rect y="360" width="${filled}" height="10" fill="${BAR_COLOR}"/>` +
            `</svg>`
          }
        />
      )
    }

    // Surfaces without a raster or a desktop pack (the editor, a text ad) get the card without the picture.
    return (
      <Box flexDirection="column" width={width}>
        {header(width)}
        {picture ?? <Text wrap="truncate-end">{bar(Math.max(10, width - CLOSE_MARK_COLUMNS))}</Text>}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{current.headline}</Text>
          <Text dimColor>{current.body}</Text>
        </Box>
        <Box marginTop={1}>{cta(width)}</Box>
        {status}
        <Box marginTop={1}>{wallet$}</Box>
        {buttons}
      </Box>
    )
  })
}
