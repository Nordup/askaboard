import { textHtml } from '../board/content'

/**
 * The size of a scene's tex() and text() nodes as the board lays them out,
 * for the sandbox (live-prelude.js measures text before it places labels and
 * reports bounds). Each item is laid out in a hidden copy of the content
 * layer with the same markup and style as compile.ts gives the node.
 */

let host: HTMLDivElement | null = null

function measureHost(): HTMLDivElement {
  if (host && host.isConnected) return host
  host = document.createElement('div')
  host.className = 'board__content'
  host.setAttribute('aria-hidden', 'true')
  Object.assign(host.style, { position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', transform: 'none' })
  document.body.appendChild(host)
  return host
}

export async function measureSceneTexts(items: Array<{ math: boolean; text: string; size: number }>): Promise<Array<[number, number]>> {
  await document.fonts.ready
  const root = measureHost()
  const elements = items.map((item) => {
    const element = document.createElement('div')
    element.className = 'node node-text'
    Object.assign(element.style, { position: 'absolute', left: '0', top: '0', fontSize: `${item.size}px`, whiteSpace: 'pre', lineHeight: '1.3' })
    const source = item.math ? `$\\displaystyle ${item.text.replace(/\$/g, '\\$')}$` : item.text
    element.innerHTML = textHtml(source)
    root.appendChild(element)
    return element
  })
  const sizes = elements.map((element) => {
    const box = element.getBoundingClientRect()
    return [Math.round(box.width * 100) / 100, Math.round(box.height * 100) / 100] as [number, number]
  })
  for (const element of elements) element.remove()
  return sizes
}
