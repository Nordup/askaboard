import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parse, type Node, type Options, type Program } from 'acorn'
import { programTooLarge } from '@shared/stage-protocol'
import { resolveSpecifier, SCENES_DIR, type SceneModule, type SceneSource, type StageModule, type StageProgram } from '@shared/scene-program'
import { isInside, type FolderSession } from './folder'
import { SceneProgramError } from './live-scene'

/**
 * Scene files and imports (spec section 0). readSceneSource reads a scene
 * program's snapshot at write_scene: the inline code or the entry file in
 * <learning folder>/boards/scenes/, and every file it imports, once. An
 * import error (a missing file, a cycle, a syntax error, a name the file does
 * not export) is a SceneProgramError with the file and the line.
 *
 * The files: every scene file and import is read at its real path (links
 * resolved), and that path must be inside boards/scenes/. A module is its
 * real path: two paths that link to one file are one module, and a module's
 * relative imports start at its real folder (the snapshot keeps the links it
 * went through). Independent files are read in parallel.
 *
 * stageProgram makes the program the stage runs (stage/worker.ts) from a
 * snapshot, and nothing else, so a rebuild of the stage from a stored
 * snapshot runs the same code:
 * - Inline code with no import, export, import() or import.meta is a script,
 *   as before modules: the body of an async function (top-level await and
 *   return).
 * - Everything else is modules, with the semantics of ES modules:
 *   - Imports are live: every reference to an imported name reads the
 *     exporting module's binding (a getter of its namespace), so a value an
 *     exported function changes is the new value in every importer. An
 *     assignment to an imported name is a TypeError.
 *   - Static imports (import and export … from) are the module graph: each
 *     file must be there at write_scene, the graph has no cycle, and every
 *     name imported or re-exported by name must resolve to one binding. A
 *     name that two `export *` give from different modules is ambiguous: an
 *     error to import by name, and left out of the namespace.
 *   - import("…") with a literal path is read at write_scene when the file is
 *     there (any other error in it is an error of write_scene); a missing file
 *     fails when the program calls import(). A computed path (import(name))
 *     loads only a module that is already in the snapshot.
 *   - Each module runs once per program, when the first importer loads it, and
 *     again for the next program.
 * Each module becomes an async function with the same line numbers as its
 * text: its import and export declarations are blanked or rewritten in place,
 * and line 1 starts with the code that loads the imported modules and gives
 * the module's exports to the stage. The names this code adds start with a
 * prefix that no identifier of the module starts with.
 *
 * Parsing and the rewrite are cached by the SHA-256 of the text, so a library
 * that many scenes and versions use is parsed once per app run.
 */

const PARSE: Options = { ecmaVersion: 'latest', sourceType: 'module', locations: true }
/** The entry module is the body of an async function, as inline code always was: it may return. */
const PARSE_ENTRY: Options = { ...PARSE, allowReturnOutsideFunction: true }
const PARSE_SCRIPT: Options = { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }
/** The rewritten module as V8 reads it (a check that the rewrite is valid, with the module's lines). */
const PARSE_OUTPUT: Options = { ecmaVersion: 'latest', sourceType: 'script', locations: true }

type AnyNode = Node & Record<string, unknown>

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** acorn's message without its "(line:column)". */
const parseMessage = (error: unknown): string => (error instanceof Error ? error.message.replace(/ \(\d+:\d+\)$/, '') : String(error))
const lineOf = (error: unknown): number | null => (error as { loc?: { line: number } }).loc?.line ?? null

/** A string literal for generated code: JSON, with the two line separators escaped (a raw one would count as a new line). */
const literal = (text: string): string => JSON.stringify(text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029]/g
/** text, followed by the line breaks of the original it replaces (so every later line keeps its number). */
const keepLines = (text: string, original: string): string => text + (original.match(LINE_BREAKS) ?? []).join('')
/** The original with every character but the line breaks as a space. */
const blankOut = (original: string): string => original.replace(/[^\n\r\u2028\u2029]/g, ' ')
/** The end of a hashbang line (#! as the first two characters), or 0. */
const hashbangEnd = (text: string): number => (text.startsWith('#!') ? text.search(/[\n\r\u2028\u2029]|$/) : 0)
/** The text with its hashbang line blanked: #! is valid only at the start of a file, and the program is not at the start of what V8 reads. */
const withoutHashbang = (text: string): string => blankOut(text.slice(0, hashbangEnd(text))) + text.slice(hashbangEnd(text))

/** Every node of a tree, depth first. */
function walk(node: unknown, visit: (node: AnyNode) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!node || typeof node !== 'object' || typeof (node as AnyNode).type !== 'string') return
  visit(node as AnyNode)
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue
    const child = (node as Record<string, unknown>)[key]
    if (child && typeof child === 'object') walk(child, visit)
  }
}

const nameOf = (node: AnyNode): string => (node.type === 'Literal' ? String(node.value) : (node.name as string))

/** The names a declaration or a binding pattern binds. */
function boundNames(node: AnyNode | null | undefined, out: string[] = []): string[] {
  if (!node) return out
  switch (node.type) {
    case 'Identifier':
      out.push(node.name as string)
      break
    case 'VariableDeclaration':
      for (const d of node.declarations as AnyNode[]) boundNames(d.id as AnyNode, out)
      break
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      boundNames(node.id as AnyNode, out)
      break
    case 'ObjectPattern':
      for (const p of node.properties as AnyNode[]) boundNames((p.type === 'RestElement' ? p.argument : p.value) as AnyNode, out)
      break
    case 'ArrayPattern':
      for (const e of node.elements as Array<AnyNode | null>) boundNames(e, out)
      break
    case 'RestElement':
      boundNames(node.argument as AnyNode, out)
      break
    case 'AssignmentPattern':
      boundNames(node.left as AnyNode, out)
      break
  }
  return out
}

/** True when inline code is a module: it uses import or export declarations, import.meta or import(). False for a script. */
function isModuleCode(text: string): boolean {
  if (!/\b(import|export)\b/.test(text)) return false
  let ast: Program
  try {
    ast = parse(text, PARSE_SCRIPT)
  } catch (error) {
    // Only import or export declarations (or import.meta) make it a module; any other error is the script's (V8 says where, as before).
    return /may appear only with 'sourceType: module'|import\.meta' outside a module/.test(parseMessage(error))
  }
  let dynamic = false
  walk(ast, (node) => {
    if (node.type === 'ImportExpression') dynamic = true
  })
  return dynamic
}

// ---------- One module, from its text alone (cached by content) ----------

/** How a module exports a name: its own binding, a name of an imported module (export … from, or an imported name exported again), or an imported module's namespace. */
type ExportOf = { kind: 'local'; local: string } | { kind: 'indirect'; request: number; name: string; line: number } | { kind: 'namespace'; request: number }

/** What a module's text says, and its rewritten body. request: an index into requests (the static imports, one per specifier, in order). */
interface Compiled {
  /** The prefix of every name the rewrite adds: <prefix>m (the stage's helper), <prefix>0… (the imported namespaces), <prefix>d (the default export). */
  prefix: string
  requests: Array<{ specifier: string; line: number }>
  /** The names imported by name (for the link check). */
  imports: Array<{ request: number; name: string; line: number }>
  exports: Map<string, ExportOf>
  stars: Array<{ request: number; line: number }>
  /** import("…") with a literal path. */
  dynamic: Array<{ specifier: string; line: number }>
  /** The getter of each export the module names itself (export * is added per graph). */
  getters: Map<string, string>
  /** The text, rewritten: same lines. */
  body: string
}

type Analysis = { ok: true; compiled: Compiled } | { ok: false; message: string; line: number | null }

/** The analyses by content (entry or not, and the SHA-256 of the text). Memory only, bounded: the oldest used go first. */
const analyses = new Map<string, { analysis: Analysis; chars: number }>()
let analysisChars = 0
const CACHE_CHARS = 64 * 1024 * 1024
const CACHE_ENTRIES = 1024

function analysisOf(text: string, entry: boolean): Analysis {
  const key = `${entry ? 'entry' : 'module'}:${sha256(text)}`
  const hit = analyses.get(key)
  if (hit) {
    analyses.delete(key)
    analyses.set(key, hit)
    return hit.analysis
  }
  const analysis = analyze(text, entry)
  const chars = text.length + (analysis.ok ? analysis.compiled.body.length : 0)
  analyses.set(key, { analysis, chars })
  analysisChars += chars
  for (const [oldKey, old] of analyses) {
    if (analysisChars <= CACHE_CHARS && analyses.size <= CACHE_ENTRIES) break
    if (oldKey === key) break
    analyses.delete(oldKey)
    analysisChars -= old.chars
  }
  return analysis
}

/** A prefix that no identifier of the module starts with. */
function freePrefix(names: Set<string>): string {
  const taken = [...names].filter((name) => name.startsWith('$ls'))
  for (let i = 0; ; i++) {
    const prefix = i ? `$ls${i}_` : '$ls'
    if (!taken.some((name) => name.startsWith(prefix))) return prefix
  }
}

function analyze(text: string, entry: boolean): Analysis {
  let ast: Program
  try {
    ast = parse(text, entry ? PARSE_ENTRY : PARSE)
  } catch (error) {
    return { ok: false, message: `SyntaxError: ${parseMessage(error)}`, line: lineOf(error) }
  }
  const names = new Set<string>()
  walk(ast, (node) => {
    if (node.type === 'Identifier') names.add(node.name as string)
  })
  const prefix = freePrefix(names)
  const helper = `${prefix}m`
  const edits: Array<{ start: number; end: number; text: string }> = []
  const replace = (start: number, end: number, text2: string): void => {
    edits.push({ start, end, text: keepLines(text2, text.slice(start, end)) })
  }
  const blank = (start: number, end: number): void => {
    edits.push({ start, end, text: blankOut(text.slice(start, end)) })
  }
  const lineAt = (node: AnyNode): number => node.loc?.start.line ?? 1

  const requests: Compiled['requests'] = []
  const requestOf = new Map<string, number>()
  const request = (source: AnyNode): number => {
    const specifier = String(source.value)
    let index = requestOf.get(specifier)
    if (index === undefined) {
      index = requests.length
      requests.push({ specifier, line: lineAt(source) })
      requestOf.set(specifier, index)
    }
    return index
  }
  const ns = (index: number): string => `${prefix}${index}`

  // Imports first: an export may name an imported binding that is imported further down (imports are hoisted).
  const imports: Compiled['imports'] = []
  /** Each imported local name: the expression that reads it (live), and where it comes from (name null: the namespace). */
  const imported = new Map<string, { read: string; request: number; name: string | null }>()
  for (const statement of ast.body as AnyNode[]) {
    if (statement.type !== 'ImportDeclaration') continue
    const index = request(statement.source as AnyNode)
    for (const s of statement.specifiers as AnyNode[]) {
      const local = (s.local as AnyNode).name as string
      if (s.type === 'ImportNamespaceSpecifier') imported.set(local, { read: ns(index), request: index, name: null })
      else {
        const name = s.type === 'ImportDefaultSpecifier' ? 'default' : nameOf(s.imported as AnyNode)
        imports.push({ request: index, name, line: lineAt(s) })
        imported.set(local, { read: `${ns(index)}[${literal(name)}]`, request: index, name })
      }
    }
    blank(statement.start, statement.end)
  }

  const exports = new Map<string, ExportOf>()
  const stars: Compiled['stars'] = []
  for (const statement of ast.body as AnyNode[]) {
    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.declaration) {
        const declaration = statement.declaration as AnyNode
        blank(statement.start, declaration.start)
        for (const name of boundNames(declaration)) exports.set(name, { kind: 'local', local: name })
      } else {
        const index = statement.source ? request(statement.source as AnyNode) : null
        for (const s of statement.specifiers as AnyNode[]) {
          const local = nameOf(s.local as AnyNode)
          const exported = nameOf(s.exported as AnyNode)
          const from = index === null ? imported.get(local) : undefined
          if (index !== null) exports.set(exported, { kind: 'indirect', request: index, name: local, line: lineAt(s) })
          else if (from && from.name === null) exports.set(exported, { kind: 'namespace', request: from.request })
          else if (from) exports.set(exported, { kind: 'indirect', request: from.request, name: from.name as string, line: lineAt(s) })
          else exports.set(exported, { kind: 'local', local })
        }
        blank(statement.start, statement.end)
      }
    } else if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = statement.declaration as AnyNode
      // The end of "export default" (comments may stand between the words).
      const keyword = /^export(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n\r\u2028\u2029]*)*default/.exec(text.slice(statement.start, declaration.start))
      const keywordEnd = statement.start + (keyword ? keyword[0].length : 0)
      const named = (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id
      if (named) {
        blank(statement.start, keywordEnd)
        exports.set('default', { kind: 'local', local: (declaration.id as AnyNode).name as string })
      } else {
        // An expression, or a function or class without a name: evaluated once, here. As the value of a "default" property, an
        // anonymous function or class gets the name "default", as in a module. The rest of the statement (parentheses, comments) stays.
        const end = text[statement.end - 1] === ';' ? statement.end - 1 : statement.end
        replace(statement.start, keywordEnd, `const ${prefix}d = { "default": `)
        edits.push({ start: end, end, text: ' }["default"];' })
        exports.set('default', { kind: 'local', local: `${prefix}d` })
      }
    } else if (statement.type === 'ExportAllDeclaration') {
      const index = request(statement.source as AnyNode)
      if (statement.exported) exports.set(nameOf(statement.exported as AnyNode), { kind: 'namespace', request: index })
      else stars.push({ request: index, line: lineAt(statement) })
      blank(statement.start, statement.end)
    }
  }

  // import.meta and import(): the stage's helper. A literal path is read at write_scene; a computed one only finds a module read then.
  const dynamic: Compiled['dynamic'] = []
  walk(ast, (node) => {
    if (node.type === 'MetaProperty' && (node.meta as AnyNode).name === 'import') replace(node.start, node.end, `${helper}.meta`)
    else if (node.type === 'ImportExpression') {
      const source = node.source as AnyNode
      const fixed = source.type === 'Literal' && typeof source.value === 'string' ? source.value : source.type === 'TemplateLiteral' && !(source.expressions as unknown[]).length ? ((source.quasis as AnyNode[])[0].value as { cooked: string | null }).cooked : null
      if (fixed !== null) dynamic.push({ specifier: fixed, line: lineAt(source) })
      replace(node.start, source.start, `${helper}.${fixed !== null ? 'literal' : 'dynamic'}(`)
    }
  })

  if (imported.size) rewriteImported(ast, imported, (start, end, read) => edits.push({ start, end, text: read }))
  if (hashbangEnd(text)) blank(0, hashbangEnd(text))

  edits.sort((a, b) => a.start - b.start || a.end - b.end)
  const parts: string[] = []
  let at = 0
  for (const edit of edits) {
    if (edit.start < at) return { ok: false, message: 'The app could not prepare this module to run (two of its rewrites overlap). Please report it.', line: null }
    parts.push(text.slice(at, edit.start), edit.text)
    at = edit.end
  }
  parts.push(text.slice(at))
  const body = parts.join('')

  // The rewrite must be valid JavaScript; if it is not, the error still names the module's own line.
  try {
    parse(`(async function (${helper}) {'use strict'; ${body}\n})`, PARSE_OUTPUT)
  } catch (error) {
    return { ok: false, message: `SyntaxError: ${parseMessage(error)}`, line: lineOf(error) }
  }

  const getters = new Map<string, string>()
  for (const [name, how] of exports) getters.set(name, how.kind === 'local' ? `() => ${how.local}` : how.kind === 'namespace' ? `() => ${ns(how.request)}` : `() => ${ns(how.request)}[${literal(how.name)}]`)
  return { ok: true, compiled: { prefix, requests, imports, exports, stars, dynamic, getters, body } }
}

/**
 * Every reference to an imported name, rewritten to read the imported
 * module's binding (the way Vite's SSR transform does), with scopes: a name
 * that a function, block, catch or class declares again is not the import
 * there. Property keys, member names, labels and meta properties are not
 * references. A shorthand property ({count}) keeps its key. A call of an
 * imported function gets no `this`, as in a module: (0, ns.f)(); where that
 * starts a statement, a ; before it keeps the line before from calling it.
 */
function rewriteImported(ast: Program, imported: Map<string, { read: string }>, rewrite: (start: number, end: number, text: string) => void): void {
  type Scope = Set<string>
  // Where a statement of a statement list starts with an expression (a rewrite that starts with "(" there needs a ";").
  const statementStarts = new Set<number>()
  walk(ast, (node) => {
    const list = node.type === 'SwitchCase' ? node.consequent : node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock' ? node.body : null
    if (Array.isArray(list)) for (const s of list as AnyNode[]) if (s.type === 'ExpressionStatement') statementStarts.add(s.start)
  })
  const isImport = (node: AnyNode, scopes: Scope[]): boolean => {
    const name = node.name as string
    if (!imported.has(name)) return false
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return false
    return true
  }
  const read = (node: AnyNode): string => (imported.get(node.name as string) as { read: string }).read
  const declare = (scope: Scope, node: AnyNode | null | undefined): void => {
    for (const name of boundNames(node)) scope.add(name)
  }
  /** The let, const, class and function declarations of a statement list (a module is strict: functions in blocks are block scoped). */
  const lexical = (statements: AnyNode[], scope: Scope): void => {
    for (const s of statements) {
      if ((s.type === 'VariableDeclaration' && s.kind !== 'var') || s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration') declare(scope, s)
    }
  }
  /** The var declarations of a function body or a static block (not those of the functions in it). */
  const hoisted = (node: AnyNode, scope: Scope): void => {
    const visit = (n: unknown): void => {
      if (Array.isArray(n)) {
        for (const child of n) visit(child)
        return
      }
      if (!n || typeof n !== 'object' || typeof (n as AnyNode).type !== 'string') return
      const m = n as AnyNode
      if (m !== node && (m.type === 'FunctionDeclaration' || m.type === 'FunctionExpression' || m.type === 'ArrowFunctionExpression' || m.type === 'StaticBlock' || m.type === 'PropertyDefinition')) return
      if (m.type === 'VariableDeclaration' && m.kind === 'var') declare(scope, m)
      for (const key of Object.keys(m)) if (key !== 'loc') visit(m[key])
    }
    visit(node)
  }
  const children = (node: AnyNode, scopes: Scope[]): void => {
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c === 'object') visit(c as AnyNode, scopes)
      } else if (child && typeof child === 'object' && typeof (child as AnyNode).type === 'string') visit(child as AnyNode, scopes)
    }
  }
  const visit = (node: AnyNode, scopes: Scope[]): void => {
    switch (node.type) {
      case 'Identifier':
        if (isImport(node, scopes)) rewrite(node.start, node.end, read(node))
        return
      case 'CallExpression':
      case 'TaggedTemplateExpression': {
        const callee = (node.type === 'CallExpression' ? node.callee : node.tag) as AnyNode
        if (callee.type === 'Identifier' && isImport(callee, scopes)) rewrite(callee.start, callee.end, `${statementStarts.has(callee.start) ? ';' : ''}(0, ${read(callee)})`)
        else visit(callee, scopes)
        if (node.type === 'CallExpression') for (const a of node.arguments as AnyNode[]) visit(a, scopes)
        else visit(node.quasi as AnyNode, scopes)
        return
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        const outer = node.type === 'FunctionExpression' && node.id ? [...scopes, new Set([(node.id as AnyNode).name as string])] : scopes
        const params: Scope = new Set()
        for (const p of node.params as AnyNode[]) declare(params, p)
        const inParams = [...outer, params]
        for (const p of node.params as AnyNode[]) visit(p, inParams)
        const body = node.body as AnyNode
        if (body.type !== 'BlockStatement') {
          visit(body, inParams)
          return
        }
        const own: Scope = new Set()
        hoisted(body, own)
        lexical(body.body as AnyNode[], own)
        const inBody = [...inParams, own]
        for (const s of body.body as AnyNode[]) visit(s, inBody)
        return
      }
      case 'ClassDeclaration':
      case 'ClassExpression': {
        if (node.superClass) visit(node.superClass as AnyNode, scopes)
        visit(node.body as AnyNode, node.id ? [...scopes, new Set([(node.id as AnyNode).name as string])] : scopes)
        return
      }
      case 'BlockStatement':
      case 'StaticBlock': {
        const own: Scope = new Set()
        if (node.type === 'StaticBlock') hoisted(node, own)
        lexical(node.body as AnyNode[], own)
        const inner = [...scopes, own]
        for (const s of node.body as AnyNode[]) visit(s, inner)
        return
      }
      case 'SwitchStatement': {
        visit(node.discriminant as AnyNode, scopes)
        const own: Scope = new Set()
        for (const c of node.cases as AnyNode[]) lexical(c.consequent as AnyNode[], own)
        const inner = [...scopes, own]
        for (const c of node.cases as AnyNode[]) children(c, inner)
        return
      }
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const head = (node.type === 'ForStatement' ? node.init : node.left) as AnyNode | null
        const own: Scope = new Set()
        if (head && head.type === 'VariableDeclaration' && head.kind !== 'var') declare(own, head)
        children(node, [...scopes, own])
        return
      }
      case 'CatchClause': {
        const own: Scope = new Set()
        declare(own, node.param as AnyNode | null)
        const inner = [...scopes, own]
        if (node.param) visit(node.param as AnyNode, inner)
        visit(node.body as AnyNode, inner)
        return
      }
      case 'Property': {
        if (node.computed) visit(node.key as AnyNode, scopes)
        const value = node.value as AnyNode
        if (node.shorthand) {
          // {count} and {count = 1}: the key stays, the value reads the import.
          const id = value.type === 'AssignmentPattern' ? (value.left as AnyNode) : value
          if (id.type === 'Identifier' && isImport(id, scopes)) rewrite(id.start, id.end, `${id.name as string}: ${read(id)}`)
          if (value.type === 'AssignmentPattern') visit(value.right as AnyNode, scopes)
          return
        }
        visit(value, scopes)
        return
      }
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed) visit(node.key as AnyNode, scopes)
        if (node.value) visit(node.value as AnyNode, scopes)
        return
      case 'MemberExpression':
        visit(node.object as AnyNode, scopes)
        if (node.computed) visit(node.property as AnyNode, scopes)
        return
      case 'LabeledStatement':
        visit(node.body as AnyNode, scopes)
        return
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'MetaProperty':
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        return
      case 'ExportNamedDeclaration':
        // export { … } is the getters (made from the imports); only a declaration has code.
        if (node.declaration) visit(node.declaration as AnyNode, scopes)
        return
      default:
        children(node, scopes)
    }
  }
  for (const statement of ast.body as AnyNode[]) visit(statement, [])
}

// ---------- The snapshot (write_scene) ----------

/** boards/scenes/ of the learning folder: its path, and its real path (null: it is not there). */
interface Scenes {
  dir: string
  real: string | null
}

/** What a path in boards/scenes/ gave: a module (at its real path), no file, or an error. */
type Slot = { kind: 'module'; module: SceneModule } | { kind: 'missing' } | { kind: 'error'; message: string }

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function scenesOf(folder: FolderSession | null, site: { line: number | null; file: string | null }): Promise<Scenes> {
  if (!folder) throw new SceneProgramError('No learning folder is open, so there are no scene files in boards/scenes/.', site.line, site.file)
  const dir = join(folder.root, SCENES_DIR)
  try {
    // boards/scenes/ itself must be in the learning folder (also through links).
    await folder.resolvePath(SCENES_DIR)
    return { dir, real: await realpath(dir) }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { dir, real: null }
    throw new SceneProgramError(`${SCENES_DIR}/: ${errorText(error)}`, site.line, site.file)
  }
}

/**
 * Read a path in boards/scenes/: its real path must be in boards/scenes/, and
 * the file read is that real path. texts: the reads by real path (one read per file).
 */
async function readSlot(scenes: Scenes, path: string, texts: Map<string, Promise<string>>): Promise<Slot> {
  if (!scenes.real) return { kind: 'missing' }
  let real: string
  try {
    real = await realpath(join(scenes.dir, ...path.split('/')))
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'error', message: `${path} could not be read: ${errorText(error)}` }
  }
  if (real === scenes.real || !isInside(scenes.real, real)) {
    return { kind: 'error', message: `${path} is a link to ${real}, which is not in boards/scenes/. Scene files, and the files they import, are read only from boards/scenes/ of the learning folder.` }
  }
  const canonical = relative(scenes.real, real).split(sep).join('/')
  let text = texts.get(canonical)
  if (!text) {
    text = readFile(real, 'utf8')
    texts.set(canonical, text)
  }
  try {
    const t = await text
    return { kind: 'module', module: { path: canonical, text: t, sha256: sha256(t) } }
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'error', message: code === 'EISDIR' ? `${path} is a folder, not a scene file.` : `${path} could not be read: ${errorText(error)}` }
  }
}

/**
 * The snapshot of a scene program (write_scene): inline code, or a file in
 * boards/scenes/, and every module it imports, read now. It is checked as the
 * stage will run it (every error of the graph is here, with its file and line).
 */
export async function readSceneSource(folder: FolderSession | null, input: { code?: string; file?: string }): Promise<SceneSource> {
  if (input.code !== undefined) {
    const module: SceneModule = { path: null, text: input.code, sha256: sha256(input.code) }
    if (!isModuleCode(input.code)) {
      const source: SceneSource = { entry: null, modules: [module] }
      programs.set(source, linkProgram(source, null))
      return source
    }
    return readGraph(folder, module, null)
  }
  const file = input.file ?? ''
  const resolved = resolveSpecifier(null, file)
  if ('error' in resolved) throw new SceneProgramError(`file "${file}": ${resolved.error}.`, null)
  const scenes = await scenesOf(folder, { line: null, file: null })
  const slot = await readSlot(scenes, resolved.path, new Map())
  if (slot.kind === 'missing') throw new SceneProgramError(`There is no scene file ${join(scenes.dir, resolved.path)}. file is a path in boards/scenes/ of the learning folder.`, null)
  if (slot.kind === 'error') throw new SceneProgramError(slot.message, null)
  return readGraph(folder, slot.module, scenes)
}

/** The entry module and every module it imports (each once, by real path, in the order found), read level by level, each level in parallel. */
async function readGraph(folder: FolderSession | null, entry: SceneModule, known: Scenes | null): Promise<SceneSource> {
  let scenes = known
  const modules = new Map<string | null, SceneModule>([[entry.path, entry]])
  const slots = new Map<string, Slot>()
  const texts = new Map<string, Promise<string>>()
  let level: SceneModule[] = [entry]
  while (level.length) {
    const wanted: Array<{ path: string; line: number; file: string | null }> = []
    const asked = new Set<string>()
    for (const module of level) {
      const analysis = analysisOf(module.text, module === entry)
      // A module with a syntax error imports nothing here; linkProgram reports the error.
      if (!analysis.ok) continue
      for (const dep of [...analysis.compiled.requests, ...analysis.compiled.dynamic]) {
        const resolved = resolveSpecifier(module.path, dep.specifier)
        if ('error' in resolved || slots.has(resolved.path) || asked.has(resolved.path)) continue
        asked.add(resolved.path)
        wanted.push({ path: resolved.path, line: dep.line, file: module.path })
      }
    }
    if (!wanted.length) break
    scenes ??= await scenesOf(folder, wanted[0])
    const where = scenes
    const read = await Promise.all(wanted.map((w) => readSlot(where, w.path, texts)))
    level = []
    read.forEach((slot, i) => {
      slots.set(wanted[i].path, slot)
      if (slot.kind === 'error') throw new SceneProgramError(slot.message, wanted[i].line, wanted[i].file)
      if (slot.kind === 'module' && !modules.has(slot.module.path)) {
        modules.set(slot.module.path, slot.module)
        level.push(slot.module)
      }
    })
  }
  const links: Array<[string, string]> = []
  for (const [path, slot] of slots) if (slot.kind === 'module' && slot.module.path !== path) links.push([path, slot.module.path as string])
  const source: SceneSource = { entry: entry.path, modules: [...modules.values()], ...(links.length ? { links } : {}) }
  programs.set(source, linkProgram(source, scenes?.dir ?? null))
  return source
}

// ---------- The program the stage runs ----------

const programs = new WeakMap<SceneSource, StageProgram>()

/** The program the stage runs for a snapshot (made once per snapshot object; readSceneSource made it already). */
export function stageProgram(source: SceneSource): StageProgram {
  let program = programs.get(source)
  if (!program) {
    program = linkProgram(source, null)
    programs.set(source, program)
  }
  return program
}

/** What a name a module exports is in the end: a binding of a module (local "*": its namespace), nothing, or ambiguous (two export * give different bindings). */
type Resolution = { module: SceneModule; local: string } | null | 'ambiguous'

/**
 * Link a snapshot into the program the stage runs, from the snapshot alone,
 * and check it as a module graph is checked before it runs: every import has
 * its file, no cycle, every name imported or re-exported by name resolves.
 * scenesDir: the folder for messages (null: the paths alone).
 */
function linkProgram(source: SceneSource, scenesDir: string | null): StageProgram {
  const [entry] = source.modules
  if (source.entry === null && source.modules.length === 1 && !isModuleCode(entry.text)) return checked({ kind: 'script', code: withoutHashbang(entry.text) })

  const links = new Map(source.links ?? [])
  const byPath = new Map<string, SceneModule>()
  for (const module of source.modules) if (module.path !== null) byPath.set(module.path, module)
  const compiled = new Map<SceneModule, Compiled>()
  /** The module each static import of a module names (null: no file was there). */
  const targets = new Map<SceneModule, Array<SceneModule | null>>()
  const located = (logical: string): SceneModule | null => byPath.get(links.get(logical) ?? logical) ?? null

  for (const [i, module] of source.modules.entries()) {
    const analysis = analysisOf(module.text, i === 0)
    if (!analysis.ok) throw new SceneProgramError(analysis.message, analysis.line, module.path)
    const c = analysis.compiled
    compiled.set(module, c)
    const resolve = (dep: { specifier: string; line: number }): string => {
      const resolved = resolveSpecifier(module.path, dep.specifier)
      if ('error' in resolved) throw new SceneProgramError(`import "${dep.specifier}": ${resolved.error}.`, dep.line, module.path)
      return resolved.path
    }
    for (const dep of c.dynamic) resolve(dep)
    targets.set(
      module,
      c.requests.map((dep) => located(resolve(dep)))
    )
  }

  // Every static import has its file.
  for (const module of source.modules) {
    const c = compiled.get(module) as Compiled
    c.requests.forEach((dep, r) => {
      if ((targets.get(module) as Array<SceneModule | null>)[r]) return
      const path = (resolveSpecifier(module.path, dep.specifier) as { path: string }).path
      const full = scenesDir ? join(scenesDir, path) : `boards/scenes/${path}`
      const hint = /\.[a-z]+$/i.test(path) ? '' : ' Import paths name the file with its extension, such as "lib/neuron.js".'
      throw new SceneProgramError(`import "${dep.specifier}": there is no file ${full}. Imports name files in boards/scenes/ (npm packages and URLs are not available).${hint}`, dep.line, module.path)
    })
  }

  // No cycle of static imports.
  const done = new Set<SceneModule>()
  const chain: SceneModule[] = []
  const visit = (module: SceneModule): void => {
    if (done.has(module)) return
    chain.push(module)
    const c = compiled.get(module) as Compiled
    ;(targets.get(module) as SceneModule[]).forEach((target, r) => {
      if (chain.includes(target)) {
        const loop = [...chain.slice(chain.indexOf(target)), target].map((m) => m.path ?? 'the inline code')
        const dep = c.requests[r]
        throw new SceneProgramError(`import "${dep.specifier}": the imports make a cycle (${loop.join(' → ')}). Scene modules cannot import each other in a circle: move what both need into a third file.`, dep.line, module.path)
      }
      visit(target)
    })
    chain.pop()
    done.add(module)
  }
  for (const module of source.modules) visit(module)

  // The names: what each export resolves to (ES ResolveExport) and the names of each namespace (ES GetExportedNames).
  const target = (module: SceneModule, request: number): SceneModule => (targets.get(module) as SceneModule[])[request]
  const resolveExport = (module: SceneModule, name: string, seen = new Set<string>()): Resolution => {
    const key = `${module.path ?? ''}\0${name}`
    if (seen.has(key)) return null
    seen.add(key)
    const c = compiled.get(module) as Compiled
    const how = c.exports.get(name)
    if (how) {
      if (how.kind === 'local') return { module, local: how.local }
      if (how.kind === 'namespace') return { module: target(module, how.request), local: '*' }
      return resolveExport(target(module, how.request), how.name, seen)
    }
    if (name === 'default') return null
    let found: Resolution = null
    for (const star of c.stars) {
      const r = resolveExport(target(module, star.request), name, seen)
      if (r === 'ambiguous') return r
      if (!r) continue
      if (!found) found = r
      else if (found.module !== r.module || found.local !== r.local) return 'ambiguous'
    }
    return found
  }
  const namesCache = new Map<SceneModule, Set<string>>()
  const exportedNames = (module: SceneModule, seen = new Set<SceneModule>()): Set<string> => {
    const cached = namesCache.get(module)
    if (cached) return cached
    if (seen.has(module)) return new Set()
    seen.add(module)
    const c = compiled.get(module) as Compiled
    const names = new Set(c.exports.keys())
    for (const star of c.stars) for (const name of exportedNames(target(module, star.request), seen)) if (name !== 'default') names.add(name)
    namesCache.set(module, names)
    return names
  }
  /** The names a namespace has: the exported names that resolve (an ambiguous one is left out). */
  const namespaceNames = (module: SceneModule): string[] => [...exportedNames(module)].filter((name) => resolveExport(module, name) !== null && resolveExport(module, name) !== 'ambiguous').sort()
  const nameError = (module: SceneModule, dep: { specifier: string; line: number }, into: SceneModule, name: string, what: string): SceneProgramError => {
    const r = resolveExport(into, name)
    if (r === 'ambiguous') {
      const c = compiled.get(into) as Compiled
      const from = c.stars.map((s) => target(into, s.request)).filter((m) => resolveExport(m, name) !== null)
      return new SceneProgramError(
        `${what} "${dep.specifier}": the name "${name}" is ambiguous: ${into.path} gets it through export * from more than one module (${from.map((m) => m.path).join(', ')}). Import it from the module that defines it.`,
        dep.line,
        module.path
      )
    }
    const has = namespaceNames(into)
    return new SceneProgramError(`${what} "${dep.specifier}": ${into.path} has no export named "${name}"${has.length ? ` (it exports ${has.map((n) => `"${n}"`).join(', ')})` : ' (it exports nothing)'}.`, dep.line, module.path)
  }
  for (const module of source.modules) {
    const c = compiled.get(module) as Compiled
    for (const i of c.imports) {
      const r = resolveExport(target(module, i.request), i.name)
      if (r === null || r === 'ambiguous') throw nameError(module, { specifier: c.requests[i.request].specifier, line: i.line }, target(module, i.request), i.name, 'import')
    }
    for (const how of c.exports.values()) {
      if (how.kind !== 'indirect') continue
      const r = resolveExport(target(module, how.request), how.name)
      if (r === null || r === 'ambiguous') throw nameError(module, { specifier: c.requests[how.request].specifier, line: how.line }, target(module, how.request), how.name, 'export … from')
    }
  }

  // Each module as the stage runs it: an async function of the helper (stage/worker.ts), line 1 first loads the imports and gives the exports.
  const stageModules: StageModule[] = source.modules.map((module) => {
    const c = compiled.get(module) as Compiled
    const getters = new Map(c.getters)
    for (const name of namespaceNames(module)) {
      if (getters.has(name)) continue
      const star = c.stars.find((s) => resolveExport(target(module, s.request), name) !== null) as { request: number }
      getters.set(name, `() => ${c.prefix}${star.request}[${literal(name)}]`)
    }
    const loads = c.requests.map((_, r) => `const ${c.prefix}${r} = await ${c.prefix}m.load(${literal(target(module, r).path as string)});`)
    const list = [...getters.keys()].sort().map((name) => `[${literal(name)}, ${getters.get(name) as string}]`)
    const head = `'use strict'; ${loads.join(' ')} ${c.prefix}m.exports([${list.join(', ')}]); `
    return { path: module.path, code: `(async function (${c.prefix}m) {${head}${c.body}\n})` }
  })
  return checked({ kind: 'modules', modules: stageModules, links: [...links] })
}

/** The program, if the stage takes it (its size caps): otherwise the error names the module and the cap. */
function checked(program: StageProgram): StageProgram {
  const tooLarge = programTooLarge(program)
  if (tooLarge) throw new SceneProgramError(tooLarge.message, null, tooLarge.file)
  return program
}

