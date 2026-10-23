import type { ReactNode } from 'react'

/**
 * A minimal, safe markdown view for the file preview: headings, paragraphs,
 * lists, quotes, fenced code, and inline code / bold / italic. It builds
 * React nodes and never injects HTML.
 */

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g
  let last = 0
  let index = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > last) nodes.push(text.slice(last, start))
    const token = match[0]
    const key = `${keyBase}-${index++}`
    if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else nodes.push(<em key={key}>{token.slice(1, -1)}</em>)
    last = start + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*$/.test(line)) {
      i++
      continue
    }
    const fence = /^```(.*)$/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push(<pre key={key++}>{body.join('\n')}</pre>)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1].length, 4)
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4'
      blocks.push(<Tag key={key++}>{inline(heading[2], `h${key}`)}</Tag>)
      i++
      continue
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: ReactNode[] = []
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const text = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '')
        items.push(<li key={items.length}>{inline(text, `li${key}-${items.length}`)}</li>)
        i++
      }
      blocks.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>)
      continue
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push(<blockquote key={key++}>{inline(body.join(' '), `q${key}`)}</blockquote>)
      continue
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} />)
      i++
      continue
    }
    const paragraph: string[] = []
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])
    )
      paragraph.push(lines[i++])
    if (!paragraph.length) paragraph.push(lines[i++]) // never stall on an odd line
    blocks.push(<p key={key++}>{inline(paragraph.join(' '), `p${key}`)}</p>)
  }
  return <div className="markdown">{blocks}</div>
}
