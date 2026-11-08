#!/usr/bin/env node
/**
 * Write space/.lab/index.html: one card per run in space/.lab/runs/, newest
 * first, with the video, the filmstrip, the program, the agent's feedback
 * (when the run had an interview) and the numbers. Paths are relative, so
 * the .lab folder can be opened or zipped.
 *
 *   node scripts/lab/gallery.mjs
 *
 * play.mjs and council.mjs run it after each run.
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RUNS } from './common.mjs'

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A small Markdown subset: headings, lists, code blocks, quotes, paragraphs, bold, italics, inline code, links. */
export function markdown(text) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
  const out = []
  let list = null
  let para = []
  let code = null
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`)
    list = null
  }
  for (const line of String(text ?? '').split('\n')) {
    if (code !== null) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
        code = null
      } else code.push(line)
      continue
    }
    if (/^```/.test(line)) {
      flushPara()
      flushList()
      code = []
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    const quote = /^>\s?(.*)$/.exec(line)
    if (heading) {
      flushPara()
      flushList()
      const level = Math.min(6, heading[1].length + 2)
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
    } else if (bullet || numbered) {
      flushPara()
      const tag = bullet ? 'ul' : 'ol'
      if (list && list.tag !== tag) flushList()
      if (!list) list = { tag, items: [] }
      list.items.push((bullet ?? numbered)[1])
    } else if (quote) {
      flushPara()
      flushList()
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`)
    } else if (!line.trim()) {
      flushPara()
      flushList()
    } else if (list && /^\s{2,}/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`
    } else {
      flushList()
      para.push(line.trim())
    }
  }
  if (code !== null) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
  flushPara()
  flushList()
  return out.join('\n')
}

const secs = (ms) => (ms === null || ms === undefined ? '–' : `${(ms / 1000).toFixed(1)} s`)

function card(name) {
  const dir = join(RUNS, name)
  let meta = {}
  try {
    meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  } catch {
    meta = { title: name }
  }
  const rel = (file) => `runs/${encodeURIComponent(name)}/${file}`
  const has = (file) => existsSync(join(dir, file))
  const n = meta.numbers ?? {}
  const who = [meta.client, meta.model, meta.effort ? `effort ${meta.effort}` : null].filter(Boolean).join(' · ')
  const numbers = [
    ['first mark', secs(n.first_mark_ms)],
    ['calls', n.calls ?? '–'],
    n.write_calls !== undefined ? ['writes', n.write_calls] : null,
    n.duration_s !== undefined && n.duration_s !== null ? ['scene', `${n.duration_s} s`] : null,
    n.wall_ms !== undefined ? ['wall', secs(n.wall_ms)] : null,
    meta.media === 'pending' ? ['video', 'being made'] : n.watch_s !== undefined && n.watch_s !== null ? ['video', `${n.watch_s} s of ${n.recorded_s} s real`] : n.recorded_s !== undefined ? ['video', `${n.recorded_s} s real time`] : null,
    n.steps ? ['steps', n.steps] : null,
    n.errors ? ['errors', n.errors] : null
  ].filter(Boolean)
  const program = has('program.js') ? readFileSync(join(dir, 'program.js'), 'utf8') : null
  const feedback = has('feedback.md') ? readFileSync(join(dir, 'feedback.md'), 'utf8') : null
  return `<article class="card${meta.ok === false ? ' card--error' : ''}">
  <header>
    <h2>${esc(meta.title ?? name)}</h2>
    <div class="who">${esc(who)}</div>
    <div class="when">${esc(name.slice(0, 15).replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3 $4:$5:$6'))}</div>
  </header>
  ${meta.task && meta.task !== meta.title ? `<p class="task">${esc(meta.task)}</p>` : ''}
  ${meta.ok === false && meta.error ? `<pre class="error">${esc(String(meta.error).slice(0, 2000))}</pre>` : ''}
  ${has('video.mp4') ? `<video src="${rel('video.mp4')}" autoplay muted loop playsinline controls preload="metadata"${has('final.png') ? ` poster="${rel('final.png')}"` : ''}></video>` : has('final.png') ? `<img src="${rel('final.png')}" alt="final frame">` : ''}
  <dl class="numbers">${numbers.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
  ${has('filmstrip.png') ? `<a href="${rel('filmstrip.png')}"><img class="strip" src="${rel('filmstrip.png')}" alt="filmstrip" loading="lazy"></a>` : ''}
  ${feedback ? `<details open><summary>Feedback</summary><div class="md">${markdown(feedback)}</div></details>` : ''}
  ${program ? `<details><summary>Program (${program.split('\n').length} lines)</summary><pre class="code"><code>${esc(program)}</code></pre></details>` : ''}
  <p class="files"><a href="runs/${encodeURIComponent(name)}/">folder</a>${has('video-real.mp4') ? ` · <a href="${rel('video-real.mp4')}">real-time video</a>` : ''}${has('result.json') ? ` · <a href="${rel('result.json')}">result.json</a>` : ''} · <a href="${rel('meta.json')}">meta.json</a></p>
</article>`
}

/** Write the gallery and return its path. */
export function writeGallery() {
  const names = existsSync(RUNS)
    ? readdirSync(RUNS, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse()
    : []
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live drawing lab</title>
<style>
  :root { --bg: #111113; --card: #1b1b1f; --line: #2c2c33; --text: #ececf0; --dim: #9a9aa6; --accent: #7cc4ff; --bad: #ff8a80; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
  h1 { font-size: 20px; margin: 8px 0 0; }
  .lede { color: var(--dim); margin: 0; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; min-width: 0; }
  .card--error { border-color: var(--bad); }
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
  h2 { font-size: 17px; margin: 0; flex: 1 1 auto; }
  .who, .when { color: var(--dim); font-size: 13px; }
  .task { margin: 0; color: var(--dim); }
  video, img { width: 100%; border-radius: 8px; background: #000; display: block; }
  .numbers { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0; }
  .numbers div { display: flex; gap: 6px; }
  dt { color: var(--dim); } dd { margin: 0; font-variant-numeric: tabular-nums; }
  details { border-top: 1px solid var(--line); padding-top: 8px; }
  summary { cursor: pointer; color: var(--accent); }
  pre { overflow-x: auto; background: #0c0c0e; border-radius: 8px; padding: 10px; font: 12.5px/1.45 ui-monospace, Menlo, monospace; margin: 8px 0 0; }
  .error { color: var(--bad); white-space: pre-wrap; }
  .md { overflow-wrap: anywhere; } .md h3, .md h4, .md h5 { margin: 12px 0 4px; font-size: 15px; }
  .md code { font: 13px ui-monospace, Menlo, monospace; background: #0c0c0e; padding: 1px 4px; border-radius: 4px; }
  .md pre code { padding: 0; background: none; }
  .md blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--line); color: var(--dim); }
  .files { margin: 0; font-size: 13px; color: var(--dim); }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Live drawing lab</h1>
  <p class="lede">${names.length} run${names.length === 1 ? '' : 's'}, newest first. Updated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))}.</p>
${names.map(card).join('\n')}
</main>
</body>
</html>
`
  const out = join(RUNS, '..', 'index.html')
  // Two runs can finish at once (council videos are made in the background): write, then rename.
  const part = `${out}.${process.pid}.part`
  writeFileSync(part, html)
  renameSync(part, out)
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(writeGallery())
