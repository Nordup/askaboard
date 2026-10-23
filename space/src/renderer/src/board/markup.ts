/**
 * The light inline markup of text nodes: `**bold**`, `*italic*`,
 * `$inline math$`, and `\` to escape one of `\ * $`. Unclosed markers stay
 * literal text. Part 2 (HTML conversion) maps runs to <b>, <i> and math.
 */

export type Run =
  | { kind: 'text'; text: string }
  | { kind: 'math'; tex: string }
  | { kind: 'bold'; children: Run[] }
  | { kind: 'italic'; children: Run[] }

const ESCAPABLE = '\\*$'

export function parseMarkup(source: string): Run[] {
  let i = 0

  /** The index of the closing `$` of math that opens at `from - 1`, or -1. */
  const mathEnd = (from: number): number => {
    for (let k = from; k < source.length; k++) {
      if (source[k] === '\\') k++
      else if (source[k] === '$') return k
      else if (source[k] === '\n') return -1
    }
    return -1
  }

  const parse = (close: '**' | '*' | null): { runs: Run[]; closed: boolean } => {
    const runs: Run[] = []
    let buffer = ''
    const flush = (): void => {
      if (buffer) runs.push({ kind: 'text', text: buffer })
      buffer = ''
    }
    while (i < source.length) {
      const char = source[i]
      if (char === '\\' && i + 1 < source.length && ESCAPABLE.includes(source[i + 1])) {
        buffer += source[i + 1]
        i += 2
        continue
      }
      if (close === '**' && source.startsWith('**', i)) {
        i += 2
        flush()
        return { runs, closed: true }
      }
      // `***` inside italic closes the italic first: `***x***` is bold(italic(x)).
      if (close === '*' && char === '*' && (!source.startsWith('**', i) || source.startsWith('***', i))) {
        i += 1
        flush()
        return { runs, closed: true }
      }
      if (char === '$') {
        const end = mathEnd(i + 1)
        if (end > i + 1) {
          flush()
          runs.push({ kind: 'math', tex: source.slice(i + 1, end) })
          i = end + 1
          continue
        }
      }
      if (char === '*') {
        const marker = source.startsWith('**', i) ? '**' : '*'
        flush()
        i += marker.length
        const inner = parse(marker)
        if (inner.closed) runs.push(marker === '**' ? { kind: 'bold', children: inner.runs } : { kind: 'italic', children: inner.runs })
        else runs.push({ kind: 'text', text: marker }, ...inner.runs)
        continue
      }
      buffer += char
      i += 1
    }
    flush()
    return { runs, closed: close === null }
  }

  return parse(null).runs
}

/**
 * Toggle a marker (`**` or `*`) around the textarea selection. Returns the new
 * value and selection. An empty selection inserts a marker pair with the caret
 * in the middle.
 */
export function toggleMarker(
  value: string,
  start: number,
  end: number,
  marker: '**' | '*'
): { value: string; start: number; end: number } {
  const m = marker.length
  const before = value.slice(Math.max(0, start - m), start)
  const after = value.slice(end, end + m)
  // `*` must not match one half of `**`.
  const exact = (text: string, outer: string): boolean => text === marker && (marker === '**' || outer !== '*')
  if (exact(before, value[start - m - 1] ?? '') && exact(after, value[end + m] ?? '')) {
    return { value: value.slice(0, start - m) + value.slice(start, end) + value.slice(end + m), start: start - m, end: end - m }
  }
  const selected = value.slice(start, end)
  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= m * 2) {
    const inner = selected.slice(m, selected.length - m)
    return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length }
  }
  return { value: value.slice(0, start) + marker + selected + marker + value.slice(end), start: start + m, end: end + m }
}
