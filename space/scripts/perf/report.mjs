#!/usr/bin/env node
/**
 * Compare perf runs: a markdown table from .lab/perf/history.jsonl, printed and
 * written to .lab/perf/report.md.
 *
 *   node scripts/perf/report.mjs [--task orbit] [--kind model|replay] [--baseline <label>] [--last N] [--runs]
 *
 * One row per group (kind, task, client, model, effort, label, dev/built) with
 * the median of its runs, or one row per run with --runs. --last N keeps the
 * newest N runs (after the filters). --baseline <label>: each row also shows the
 * change against the group with that label (same kind and task), in %.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { args } from '../lab/common.mjs'
import { HISTORY, PERF, median, round } from './metrics.mjs'

const { option, flag } = args()
const opts = { task: option('--task', null), kind: option('--kind', null), baseline: option('--baseline', null), last: option('--last', null), runs: flag('--runs') }

if (!existsSync(HISTORY)) {
  console.log(`No runs yet (${HISTORY}). Start one: node scripts/perf/run.mjs --client claude --model haiku --effort high --task orbit`)
  process.exit(0)
}
let rows = readFileSync(HISTORY, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
if (opts.task) rows = rows.filter((r) => r.task === opts.task)
if (opts.kind) rows = rows.filter((r) => r.kind === opts.kind)
rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
if (opts.last) rows = rows.slice(-Number(opts.last))

// The columns: [heading, value of one run, lower is better].
const COLUMNS = [
  ['wall s', (r) => r.time?.wall],
  ['1st scene s', (r) => r.time?.first_scene ?? r.time?.first_run_scene],
  ['1st visible s', (r) => r.time?.first_visible],
  ['done s', (r) => r.time?.done ?? r.time?.total_with_playback],
  ['model s', (r) => r.time?.model_s],
  ['calls', (r) => r.calls?.total],
  ['previews', (r) => r.calls?.scene_previews ?? r.calls?.run_scene_previews],
  ['plays', (r) => r.calls?.scene_plays ?? r.calls?.run_scene_plays],
  ['written k', (r) => (r.written?.total ?? null) / 1000],
  ['repeat %', (r) => (r.written?.repeat_share ?? null) === null ? null : r.written.repeat_share * 100],
  ['read k', (r) => (r.read?.result_chars ?? null) / 1000],
  ['images', (r) => r.read?.images],
  ['preview ms', (r) => r.app?.preview_ms_median],
  ['play ms', (r) => r.app?.play_ms_median],
  ['frame p95 ms', (r) => r.frames?.interval_ms?.p95],
  ['work med ms', (r) => r.frames?.work_ms?.median],
  ['work p95 ms', (r) => r.frames?.work_ms?.p95],
  ['work max ms', (r) => r.frames?.work_ms?.max],
  ['frames >50ms', (r) => r.frames?.long_50ms],
  ['cost $', (r) => r.usage?.cost_usd]
]
const val = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : null)

const key = (r) => [r.kind, r.task, r.client, r.model, r.effort ?? '-', r.label ?? '-', r.mode].join('|')
const name = (r) => `${r.kind} ${r.task} ${r.client ?? ''} ${r.model ?? ''}${r.effort ? ` ${r.effort}` : ''}${r.label ? ` [${r.label}]` : ''}${r.mode === 'built' ? ' built' : ''}`.replace(/\s+/g, ' ')

let groups
if (opts.runs) groups = rows.map((r) => ({ r, n: 1, runs: [r], title: `${name(r)} ${r.timestamp.slice(5, 16).replace('T', ' ')}${r.ok ? '' : ' (error)'}` }))
else {
  const map = new Map()
  for (const r of rows) {
    const k = key(r)
    if (!map.has(k)) map.set(k, { r, runs: [] })
    map.get(k).runs.push(r)
  }
  groups = [...map.values()].map((g) => ({ ...g, n: g.runs.length, title: name(g.r) }))
}
for (const g of groups) g.values = COLUMNS.map(([, f]) => median(g.runs.map((r) => val(f(r)))))

const baseOf = (g) => (opts.baseline ? groups.find((b) => b.r.label === opts.baseline && b.r.kind === g.r.kind && b.r.task === g.r.task) : null)
const fmt = (v) => (v === null ? '–' : Math.abs(v) >= 100 ? String(Math.round(v)) : String(round(v, Math.abs(v) >= 10 ? 1 : 2)))
const cell = (v, b) => {
  if (v === null) return '–'
  if (b === null || b === undefined || b === 0) return fmt(v)
  const pct = Math.round(((v - b) / b) * 100)
  return `${fmt(v)} (${pct > 0 ? '+' : ''}${pct}%)`
}

const lines = []
lines.push(`# Perf report`, '', `${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${rows.length} runs${opts.task ? ` · task ${opts.task}` : ''}${opts.kind ? ` · kind ${opts.kind}` : ''}${opts.baseline ? ` · baseline [${opts.baseline}]` : ''} · ${opts.runs ? 'one row per run' : 'median per group'}`, '')
lines.push(`| run | n | code | ${COLUMNS.map(([h]) => h).join(' | ')} |`)
lines.push(`| --- | --- | --- | ${COLUMNS.map(() => '---').join(' | ')} |`)
for (const g of groups) {
  const b = baseOf(g)
  const codes = [...new Set(g.runs.map((r) => `${r.code?.commit?.slice(0, 7) ?? '?'}${r.code?.dirty ? `+${r.code.diff_hash?.slice(0, 6)}` : ''}`))].join(', ')
  lines.push(`| ${g.title} | ${g.n} | ${codes} | ${g.values.map((v, i) => cell(v, b && b !== g ? b.values[i] : null)).join(' | ')} |`)
}
lines.push('', 'Times in seconds from the agent start (replay: from the first call). "done": the last scene has played. "written k": thousands of characters the model wrote into tool args. "repeat %": share of scene program code (write_scene; run_scene in older runs) that is ≥ 0.9 similar to the scene before it. "read k": thousands of result characters. "code": commit + hash of uncommitted changes in space/src and space/resources. Details: space/scripts/perf/README.md.')
const text = `${lines.join('\n')}\n`
writeFileSync(join(PERF, 'report.md'), text)
process.stdout.write(text)
