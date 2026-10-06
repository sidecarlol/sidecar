// A small layout estimator for the trees the pane draws, so a test can check a width and a
// height without a terminal: Box (row or column), Text (wrapped or truncated), Raster, Image,
// Link and Button, laid out the way Ink does for the shapes the mod uses. Not a paint.

type Node = string | { type: string; props?: Record<string, unknown>; children?: Node[] }

export type Size = { w: number; h: number }

export type LayoutOptions = {
  /** A terminal without OSC 8 hyperlinks prints a Link's URL after its label (macOS Terminal). */
  isLinkPlain?: boolean
}

function textOf(node: Node, options: LayoutOptions): string {
  if (typeof node === 'string') return node
  if (node.type === 'Link') {
    const label = String(node.props?.label ?? '')
    return options.isLinkPlain ? `${label} ${String(node.props?.href ?? '')}` : label
  }
  if (node.type === 'Button') return `[ ${String(node.props?.label ?? '')} ]`
  return (node.children ?? []).map((child) => textOf(child, options)).join('')
}

function wrapLines(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= width || !line) line = next
    else {
      lines.push(line)
      line = word
    }
  }
  lines.push(line)
  // A single word longer than the width is cut into rows.
  return lines.flatMap((l) => (l.length > width && width > 0 ? Array.from({ length: Math.ceil(l.length / width) }, (_, i) => l.slice(i * width, (i + 1) * width)) : [l]))
}

/** Whether the node gives way when its row is short: truncated text. */
function shrinks(node: Node): boolean {
  return typeof node !== 'string' && node.type === 'Text' && String(node.props?.wrap ?? '').startsWith('truncate')
}

export function measure(node: Node, avail: number, options: LayoutOptions = {}): Size {
  if (typeof node === 'string') return { w: Math.min(node.length, avail), h: 1 }
  const props = node.props ?? {}
  switch (node.type) {
    case 'Raster':
    case 'Image':
      return { w: Number(props.columns), h: Number(props.rows) }
    case 'Text':
    case 'Link':
    case 'Button': {
      const text = textOf(node, options)
      if (shrinks(node)) return { w: Math.min(text.length, avail), h: 1 }
      const lines = wrapLines(text, Math.max(1, avail))
      return { w: Math.max(...lines.map((l) => l.length)), h: lines.length }
    }
    case 'Box': {
      const own = typeof props.width === 'number' ? props.width : undefined
      const inner = own ?? avail
      const marginX = Number(props.marginLeft ?? 0) + Number(props.marginRight ?? 0)
      const marginY = Number(props.marginTop ?? 0) + Number(props.marginBottom ?? 0)
      const children = node.children ?? []
      if (props.flexDirection === 'column') {
        const sizes = children.map((child) => measure(child, inner - marginX, options))
        return { w: (own ?? Math.max(0, ...sizes.map((s) => s.w))) + marginX, h: sizes.reduce((sum, s) => sum + s.h, 0) + marginY }
      }
      // A row: fixed children take their width first, truncated text takes what is left.
      const room = inner - marginX
      let used = 0
      const fixed = children.map((child) => (shrinks(child) ? null : measure(child, room, options)))
      for (const s of fixed) used += s?.w ?? 0
      const sizes = children.map((child, i) => fixed[i] ?? measure(child, Math.max(0, room - used), options))
      const w = sizes.reduce((sum, s) => sum + s.w, 0)
      return { w: (own ?? w) + marginX, h: Math.max(1, ...sizes.map((s) => s.h)) + marginY }
    }
    default:
      return { w: 0, h: 0 }
  }
}

/** Every Text, Link and Button string in the tree, for "is this still on screen" checks. */
export function allText(node: Node, options: LayoutOptions = {}): string {
  if (typeof node === 'string') return node
  if (node.type === 'Text' || node.type === 'Link' || node.type === 'Button') return textOf(node, options)
  return (node.children ?? []).map((child) => allText(child, options)).join('\n')
}
