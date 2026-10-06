import type { ServedAd, Wallet } from '../types'

/**
 * Everything the ad server sends is printed into the person's terminal, so none of it is
 * trusted to be plain. The server refuses control characters at upload; this is the second wall.
 */

/** Longest any one line of ad text is allowed to be. */
const MAX_TEXT = 500
const MAX_URL = 2048

/** A character class from code point ranges, spelled in numbers so no invisible character sits in the source. */
function charClass(ranges: [number, number][]): string {
  return `[${ranges.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join('')}]`
}

/** Tab, line feed, vertical tab, form feed, carriage return, NEL, and the Unicode line and paragraph separators read as a space, not as nothing. */
const BREAKS = new RegExp(`${charClass([[0x09, 0x0d], [0x85, 0x85], [0x2028, 0x2029]])}+`, 'gu')
/**
 * What is removed outright: C0 controls (ESC starts a terminal command, BEL ends one), DEL and C1
 * controls, the Arabic letter mark, zero-width and bidi marks and overrides (U+200B to U+200F,
 * U+202A to U+202E, U+2060 to U+206F with the isolates), the byte order mark, interlinear
 * annotation marks and the invisible tag characters.
 */
const UNSAFE = new RegExp(
  charClass([
    [0x00, 0x1f],
    [0x7f, 0x9f],
    [0x61c, 0x61c],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x206f],
    [0xfeff, 0xfeff],
    [0xfff9, 0xfffb],
    [0xe0000, 0xe007f],
  ]),
  'gu',
)

/** Ad text made safe to print: no control or bidi characters, one line, trimmed, capped. */
export function clean(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(BREAKS, ' ').replace(UNSAFE, '').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** A URL made safe to print or to put in a hyperlink: no controls, no spaces. Only http(s) survives; anything else becomes `fallback`. */
export function cleanUrl(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  const url = value.replace(UNSAFE, '').replace(/\s+/g, '')
  return /^https?:\/\//i.test(url) && url.length <= MAX_URL ? url : fallback
}

/**
 * The video's file URL, for the VS Code panel to download. Only the ad server's own media folder
 * qualifies: a URL anywhere else is dropped, so the panel is never pointed at another host.
 */
export function cleanVideoUrl(value: unknown, apiBase: string): string | null {
  const url = cleanUrl(value)
  return url.startsWith(`${apiBase}/api/media/videos/`) ? url : null
}

/** The served ad with every text and URL field cleaned. A spinner line that cleans to nothing falls back to the headline, then the advertiser. */
export function cleanAd(raw: ServedAd, home: string): ServedAd {
  const advertiser = clean(raw.advertiser, 80)
  const headline = clean(raw.headline, 120)
  return {
    ...raw,
    advertiser,
    headline,
    body: clean(raw.body),
    spinnerText: clean(raw.spinnerText) || headline || advertiser,
    ctaLabel: clean(raw.ctaLabel, 40),
    clickUrl: cleanUrl(raw.clickUrl, home),
    framesUrl: raw.framesUrl == null ? null : cleanUrl(raw.framesUrl) || null,
    ...(raw.hdUrl == null ? {} : { hdUrl: cleanUrl(raw.hdUrl) || null }),
    ...(raw.desktopUrl == null ? {} : { desktopUrl: cleanUrl(raw.desktopUrl) || null }),
    ...(raw.videoUrl == null ? {} : { videoUrl: cleanVideoUrl(raw.videoUrl, home) }),
  }
}

export function cleanWallet(raw: Wallet, home: string): Wallet {
  return raw && typeof raw === 'object' ? { ...raw, claimUrl: cleanUrl(raw.claimUrl, home) } : raw
}
