import { expect, mock, test } from 'claude-code/testing'
import { measure } from './layout'

const API = 'https://api.test'
const WALLET = { todayMicros: 4100, pendingMicros: 4100, lifetimeMicros: 4100, isClaimed: false, claimUrl: `${API}/earn/claim?code=ABCD-EFGH` }
/** The longest copy an advertiser may submit (lib/advertiser/rules.ts: headline 60, body 140, cta 20). */
const LONGEST = {
  advertiser: 'Northwind Deploy Platform Inc',
  headline: 'H'.repeat(8) + ' ' + 'headline '.repeat(6).trim().slice(0, 51),
  body: 'body words go here '.repeat(8).trim().slice(0, 140),
  ctaLabel: 'Start free trial now!!',
}
const AD = {
  impressionId: 'imp_0123456789abcdef',
  creativeId: 'cr_1',
  format: 'video',
  advertiser: 'Northwind',
  headline: 'Previews in 30 seconds',
  body: 'Every branch, its own URL.',
  spinnerText: 'Deploy previews in 30s with Northwind',
  ctaLabel: 'Try it',
  clickUrl: 'https://sidecar.lol/c/imp_0123456789abcdef',
  framesUrl: `${API}/frames`,
  durationMs: 15000,
  viewerMicros: 2050,
  posterColor: 0x223344,
}

/** Draws the pane for `ad` in each layout the terminal can seat it in. */
async function drawAll($: any, on: any, ad: object, run: (size: { columns: number; rows: number; bodyColumns: number; placement: 'inline' | 'dock'; isFullscreen: boolean }, drawn: any) => void) {
  on('prompt.submit', async (_$: any, e: any) => ({ text: e.text }))
  mock.store(on, { token: 't', videoQuality: 'blocks' })
  mock.env(on, { SIDECAR_API_BASE: API })
  const clock = mock.clock(on, { now: 1_000_000 })
  const rgb = new Uint8Array(16 * 9 * 3 * 2).fill(120)
  const pack = { width: 16, height: 9, fps: 10, count: 2, rgb: rgb.toBase64() }
  on('http.fetch', async (_$: any, e: any) => {
    const body = e.url.endsWith('/frames') ? pack : e.url.endsWith('/ads/request') ? { ad } : e.url.endsWith('/beat') ? { status: 'served' } : { wallet: WALLET }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('turn.start', async (_$: any, e: any) => ({ turnId: e.turnId }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.invalidate', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.blit', async () => ({ value: {} }) as never)
  await $.prompt.submit({ text: 'go', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(3100)
  // The inline pane's body is the terminal less the frame's sides; the dock is the 48 columns the mod asks for.
  const sizes = [
    { columns: 80, rows: 24, bodyColumns: 76, placement: 'inline', isFullscreen: false },
    { columns: 120, rows: 40, bodyColumns: 116, placement: 'inline', isFullscreen: false },
    { columns: 200, rows: 50, bodyColumns: 196, placement: 'inline', isFullscreen: false },
    { columns: 80, rows: 24, bodyColumns: 76, placement: 'inline', isFullscreen: true },
    { columns: 120, rows: 24, bodyColumns: 46, placement: 'dock', isFullscreen: true },
    { columns: 120, rows: 40, bodyColumns: 46, placement: 'dock', isFullscreen: true },
    { columns: 200, rows: 50, bodyColumns: 48, placement: 'dock', isFullscreen: true },
    { columns: 60, rows: 24, bodyColumns: 56, placement: 'inline', isFullscreen: false },
    { columns: 54, rows: 24, bodyColumns: 50, placement: 'inline', isFullscreen: false },
    { columns: 34, rows: 24, bodyColumns: 30, placement: 'inline', isFullscreen: false },
  ] as const
  for (const size of sizes) {
    const ui = await $.ui.mount({
      plugin: 'sidecar',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'sidecar',
      viewport: { columns: size.columns, rows: size.rows, isFullscreen: size.isFullscreen },
      props: { title: 'Sponsored', isFocused: false, bodyColumns: size.bodyColumns, placement: size.placement },
    } as never)
    run(size, await ui.drawn())
    await ui.unmount()
  }
}

// What the person's terminal draws is not testable here; what the mod asks it to draw is. These
// check the tree against the room each layout gives it: never wider than the pane's body, and
// the inline banner never taller than the 10-row pane the mod opens (8 body rows).
for (const [name, ad, isLinkPlain] of [
  ['typical copy', AD, false],
  ['typical copy, terminal without hyperlinks (macOS Terminal)', AD, true],
  ['the longest copy an advertiser may submit', { ...AD, ...LONGEST }, false],
  ['the longest copy, terminal without hyperlinks', { ...AD, ...LONGEST }, true],
] as const) {
  test(`the pane fits its room at 34 to 200 columns, inline and docked: ${name}`, { timeoutMs: 20000 }, async ($, on) => {
    let checked = 0
    await drawAll($, on, ad, (size, drawn) => {
      const got = measure(drawn, size.bodyColumns, { isLinkPlain })
      const where = `${size.columns}x${size.rows} ${size.placement} fullscreen=${size.isFullscreen}`
      expect(`${where} width ${got.w}`).toBe(`${where} width ${Math.min(got.w, size.bodyColumns)}`)
      // The side-by-side banner holds from 56 columns; narrower stacks and may scroll.
      if (size.placement === 'inline' && size.bodyColumns >= 56) expect(`${where} height ${got.h}`).toBe(`${where} height ${Math.min(got.h, 8)}`)
      checked++
    })
    expect(checked).toBe(10)
  })
}

test('the pane draws on the desktop app, the VS Code panel and mobile as a card without the picture', { timeoutMs: 20000 }, async ($, on) => {
  let surfaces = 0
  await drawAll($, on, AD, () => {})
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'sidecar',
      surface,
      component: 'Pane',
      requestId: 'sidecar',
      viewport: { columns: 60, rows: 30, isFullscreen: false },
      props: { title: 'Sponsored', isFocused: false, bodyColumns: 60, placement: 'inline' },
    } as never)
    expect(await ui.find({ type: 'Text', text: /Previews in 30 seconds/ })).toBeDefined()
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    await ui.unmount()
    surfaces++
  }
  expect(surfaces).toBe(3)
})
