// Terminal video: a frame pack of raw RGB frames turned into Raster cells.
// Each cell is an upper half block (U+2580): foreground paints the top pixel,
// background the bottom, so a cell carries two vertical pixels.

export type FramePack = {
  /** Pixels per row of every frame. */
  width: number
  /** Rows of pixels of every frame. */
  height: number
  fps: number
  /** How many frames the pack holds. */
  count: number
  /** All frames, back to back, `width * height * 3` bytes each. */
  rgb: Uint8Array
  /** Pixel art drawn for the grid: shown only at whole-number scales, so every pixel stays square. */
  isPixelArt?: boolean
}

const HALF_BLOCK = 0x2580

// The hooks environment has the ES2026 base64 helpers; this build's lib does not declare them yet.
declare global {
  interface Uint8ArrayConstructor {
    fromBase64(base64: string): Uint8Array
  }
  interface Uint8Array {
    toBase64(): string
  }
}

/** Decodes the server's frame pack (`{ width, height, fps, count, rgb: base64 }`). */
export function decodePack(json: string): FramePack {
  const raw = JSON.parse(json) as {
    width: number
    height: number
    fps: number
    count: number
    rgb: string
    pixelArt?: boolean
  }
  const rgb = Uint8Array.fromBase64(raw.rgb)
  const frameBytes = raw.width * raw.height * 3
  const count = Math.min(raw.count, Math.floor(rgb.length / frameBytes))
  return { width: raw.width, height: raw.height, fps: raw.fps, count, rgb, isPixelArt: raw.pixelArt === true }
}

/** The cell grid that fits the pack's aspect ratio inside `maxColumns` x `maxRows`. */
export function fitGrid(
  pack: Pick<FramePack, 'width' | 'height' | 'isPixelArt'>,
  maxColumns: number,
  maxRows: number,
): { columns: number; rows: number } {
  // Pixel art: the largest whole-number scale that fits, one pixel per column and per
  // half row at 1x, so no column or row is doubled where its neighbour is not.
  if (pack.isPixelArt && pack.height % 2 === 0) {
    const scale = Math.floor(Math.min(maxColumns / pack.width, (maxRows * 2) / pack.height))
    if (scale >= 1) return { columns: pack.width * scale, rows: (pack.height / 2) * scale }
  }
  const aspect = pack.width / pack.height
  let columns = Math.max(8, Math.min(512, Math.floor(maxColumns)))
  // A cell is about twice as tall as wide and holds two pixels, so square pixels come out square.
  let rows = Math.max(4, Math.round(columns / aspect / 2))
  if (rows > maxRows) {
    rows = Math.max(4, Math.floor(maxRows))
    columns = Math.max(8, Math.round(rows * 2 * aspect))
  }
  return { columns, rows: Math.min(256, rows) }
}

/** One frame of the pack as Raster `cells`, nearest-neighbour scaled to the grid. */
export function frameCells(
  pack: FramePack,
  index: number,
  columns: number,
  rows: number,
): string {
  const words = new Uint32Array(columns * rows * 3)
  const frame = ((index % pack.count) + pack.count) % pack.count
  const base = frame * pack.width * pack.height * 3
  const pixelRows = rows * 2

  const sample = (x: number, y: number): number => {
    const sx = Math.min(pack.width - 1, Math.floor(((x + 0.5) * pack.width) / columns))
    const sy = Math.min(pack.height - 1, Math.floor(((y + 0.5) * pack.height) / pixelRows))
    const at = base + (sy * pack.width + sx) * 3
    return ((pack.rgb[at] ?? 0) << 16) | ((pack.rgb[at + 1] ?? 0) << 8) | (pack.rgb[at + 2] ?? 0)
  }

  let w = 0
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      words[w++] = HALF_BLOCK
      words[w++] = sample(col, row * 2)
      words[w++] = sample(col, row * 2 + 1)
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}

/** A solid grid (a poster before the pack arrives). */
export function solidCells(columns: number, rows: number, color: number): string {
  const words = new Uint32Array(columns * rows * 3)
  for (let i = 0; i < columns * rows; i++) {
    words[i * 3] = HALF_BLOCK
    words[i * 3 + 1] = color
    words[i * 3 + 2] = color
  }
  return new Uint8Array(words.buffer).toBase64()
}

/** One frame of the pack as RGBA pixels (base64), for an `Image` on terminals with kitty graphics. */
export function frameRgba(pack: FramePack, index: number): string {
  const frame = ((index % pack.count) + pack.count) % pack.count
  const pixels = pack.width * pack.height
  const base = frame * pixels * 3
  const out = new Uint8Array(pixels * 4)
  for (let i = 0; i < pixels; i++) {
    out[i * 4] = pack.rgb[base + i * 3] ?? 0
    out[i * 4 + 1] = pack.rgb[base + i * 3 + 1] ?? 0
    out[i * 4 + 2] = pack.rgb[base + i * 3 + 2] ?? 0
    out[i * 4 + 3] = 255
  }
  return out.toBase64()
}
