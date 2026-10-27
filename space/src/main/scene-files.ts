import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, type Node, type Options, type Program } from 'acorn'
import { resolveSpecifier, SCENES_DIR, type SceneModule, type SceneSource, type StageModule, type StageProgram } from '@shared/scene-program'
import type { FolderSession } from './folder'
import { SceneProgramError } from './live-scene'

/**
 * Scene files and imports (spec section 0). readSceneSource reads a scene
 * program's snapshot at write_scene: the inline code or the entry file in
 * <learning folder>/boards/scenes/, and every file it imports, once. An
 * import error (a missing file, a cycle, a syntax error, a name the file does
 * not export) is a SceneProgramError with the file and the line.
 *
 * stageProgram makes the program the stage runs (stage/worker.ts) from a
 * snapshot, and nothing else, so a rebuild of the stage from a stored
 * snapshot runs the same code:
 * - Inline code with no import or export is a script, as before modules:
 *   the body of an async function (top-level await and return).
 * - Everything else is modules. Each module becomes the body of an async
 *   function with the same line numbers as its text: its import and export
 *   declarations are blanked, and line 1 starts with the code that loads the
 *   imported modules (in order, each evaluated once per program), binds the
 *   imported names and gives the module's exports to the stage as getters
 *   (live: a getter reads the module's own binding). An imported name is
 *   bound once, when its module has run (not live), so an import cycle is an
 *   error here.
 */

const PARSE: Options = { ecmaVersion: 'latest', sourceType: 'module', locations: true }
/** The entry module is the body of an async function, as inline code always was: it may return. */
const PARSE_ENTRY: Options = { ...PARSE, allowReturnOutsideFunction: true }
const PARSE_SCRIPT: Options = { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }

type AnyNode = Node & Record<string, unknown>

/** An import of a module: the path it names in boards/scenes/, the specifier as written, its line, and the names it takes (null: the whole namespace or nothing by name). */
interface Dependency {
  specifier: string
  path: string
  line: number
  names: string[]
}

interface Parsed {
  module: SceneModule
  ast: Program
  dependencies: Dependency[]
  /** The names the module exports itself (not through export *), and the paths it re-exports with export *. */
  exports: Set<string>
  stars: string[]
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** acorn's message without its "(line:column)". */
const parseMessage = (error: unknown): string => (error instanceof Error ? error.message.replace(/ \(\d+:\d+\)$/, '') : String(error))

/** True when inline code uses import or export (a module); false for a script. */
function isModuleCode(text: string): boolean {
  if (!/\b(import|export)\b/.test(text)) return false
  try {
    parse(text, PARSE_SCRIPT)
    return false
  } catch (error) {
    // Only import or export declarations (or import.meta) make it a module; any other error is the script's (V8 says where, as before).
    return /may appear only with 'sourceType: module'|import\.meta' outside a module/.test(parseMessage(error))
  }
}

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

/** Parse a module and find its imports. An error names the module and the line. */
function parseModule(module: SceneModule, entry: boolean): Parsed {
  let ast: Program
  try {
    ast = parse(module.text, entry ? PARSE_ENTRY : PARSE)
  } catch (error) {
    const line = (error as { loc?: { line: number } }).loc?.line ?? null
    throw new SceneProgramError(`SyntaxError: ${parseMessage(error)}`, line, module.path)
  }
  const dependencies: Dependency[] = []
  const exports = new Set<string>()
  const stars: string[] = []
  const depend = (source: AnyNode, names: string[]): string => {
    const specifier = String(source.value)
    const line = source.loc?.start.line ?? 1
    const resolved = resolveSpecifier(module.path, specifier)
    if ('error' in resolved) throw new SceneProgramError(`import "${specifier}": ${resolved.error}.`, line, module.path)
    dependencies.push({ specifier, path: resolved.path, line, names })
    return resolved.path
  }
  for (const statement of ast.body as AnyNode[]) {
    if (statement.type === 'ImportDeclaration') {
      const names = (statement.specifiers as AnyNode[]).flatMap((s) => (s.type === 'ImportSpecifier' ? [nameOf(s.imported as AnyNode)] : s.type === 'ImportDefaultSpecifier' ? ['default'] : []))
      depend(statement.source as AnyNode, names)
    } else if (statement.type === 'ExportNamedDeclaration') {
      const specifiers = statement.specifiers as AnyNode[]
      if (statement.source) depend(statement.source as AnyNode, specifiers.map((s) => nameOf(s.local as AnyNode)))
      for (const name of boundNames(statement.declaration as AnyNode)) exports.add(name)
      for (const s of specifiers) exports.add(nameOf(s.exported as AnyNode))
    } else if (statement.type === 'ExportDefaultDeclaration') exports.add('default')
    else if (statement.type === 'ExportAllDeclaration') {
      const path = depend(statement.source as AnyNode, [])
      if (statement.exported) exports.add(nameOf(statement.exported as AnyNode))
      else stars.push(path)
    }
  }
  // import("…") with a fixed path: that file is part of the snapshot too.
  walk(ast, (node) => {
    if (node.type === 'ImportExpression' && (node.source as AnyNode).type === 'Literal' && typeof (node.source as AnyNode).value === 'string') depend(node.source as AnyNode, [])
  })
  return { module, ast, dependencies, exports, stars }
}

/**
 * The snapshot of a scene program (write_scene): inline code, or a file in
 * boards/scenes/, and every module it imports, read now.
 */
export async function readSceneSource(folder: FolderSession | null, input: { code?: string; file?: string }): Promise<SceneSource> {
  if (input.code !== undefined) {
    const module: SceneModule = { path: null, text: input.code, sha256: sha256(input.code) }
    if (!isModuleCode(input.code)) return { entry: null, modules: [module] }
    return readGraph(folder, module)
  }
  const file = input.file ?? ''
  const resolved = resolveSpecifier(null, file)
  if ('error' in resolved) throw new SceneProgramError(`file "${file}": ${resolved.error}.`, null)
  const text = await readSceneFile(folder, resolved.path, () => `There is no scene file ${folder ? join(folder.root, SCENES_DIR, resolved.path) : resolved.path}. file is a path in boards/scenes/ of the learning folder.`)
  const source = await readGraph(folder, { path: resolved.path, text, sha256: sha256(text) })
  return source
}

/** The text of a file in boards/scenes/, or a SceneProgramError (missing(): the error for a file that is not there). */
async function readSceneFile(folder: FolderSession | null, path: string, missing: () => string, site: { line: number; file: string | null } | null = null): Promise<string> {
  const fail = (text: string): never => {
    throw new SceneProgramError(text, site?.line ?? null, site?.file ?? null)
  }
  if (!folder) return fail('No learning folder is open, so there are no scene files in boards/scenes/.')
  let full: string
  try {
    full = await folder.resolvePath(`${SCENES_DIR}/${path}`)
  } catch (error) {
    return fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? missing() : `${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return await readFile(full, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return fail(code === 'ENOENT' ? missing() : code === 'EISDIR' ? `${path} is a folder, not a scene file.` : `${path} could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The entry module and every module it imports (each once, in the order found); checks cycles and imported names. */
async function readGraph(folder: FolderSession | null, entry: SceneModule): Promise<SceneSource> {
  const parsed = new Map<string | null, Parsed>()
  const order: Parsed[] = []
  const visit = async (module: SceneModule, chain: Array<string | null>): Promise<void> => {
    const p = parseModule(module, module === entry)
    parsed.set(module.path, p)
    order.push(p)
    for (const dep of p.dependencies) {
      if (dep.path === module.path || chain.includes(dep.path)) {
        const loop = [...chain.slice(chain.indexOf(dep.path)), module.path, dep.path].map((path) => path ?? 'the inline code')
        throw new SceneProgramError(`import "${dep.specifier}": the imports make a cycle (${loop.join(' → ')}). Scene modules cannot import each other in a circle: move what both need into a third file.`, dep.line, module.path)
      }
      if (parsed.has(dep.path)) continue
      const text = await readSceneFile(
        folder,
        dep.path,
        () => {
          const full = folder ? join(folder.root, SCENES_DIR, dep.path) : dep.path
          const hint = /\.[a-z]+$/i.test(dep.path) ? '' : ' Import paths name the file with its extension, such as "lib/neuron.js".'
          return `import "${dep.specifier}": there is no file ${full}. Imports name files in boards/scenes/ (npm packages and URLs are not available).${hint}`
        },
        { line: dep.line, file: module.path }
      )
      await visit({ path: dep.path, text, sha256: sha256(text) }, [...chain, module.path])
    }
  }
  await visit(entry, [])
  // Every imported name must be exported (as a module would fail to link).
  const exportsOf = (path: string, seen = new Set<string>()): Set<string> => {
    const p = parsed.get(path) as Parsed
    if (seen.has(path)) return new Set()
    seen.add(path)
    const all = new Set(p.exports)
    for (const star of p.stars) for (const name of exportsOf(star, seen)) if (name !== 'default') all.add(name)
    return all
  }
  for (const p of order) {
    for (const dep of p.dependencies) {
      const names = exportsOf(dep.path)
      const missing = dep.names.find((name) => !names.has(name))
      if (missing !== undefined) {
        const has = [...names].sort()
        throw new SceneProgramError(`import "${dep.specifier}": ${dep.path} has no export named "${missing}"${has.length ? ` (it exports ${has.map((n) => `"${n}"`).join(', ')})` : ' (it exports nothing)'}.`, dep.line, p.module.path)
      }
    }
  }
  return { entry: entry.path, modules: order.map((p) => p.module) }
}

// ---------- The program the stage runs ----------

const programs = new WeakMap<SceneSource, StageProgram>()

/** The program the stage runs for a snapshot (made once per snapshot object). */
export function stageProgram(source: SceneSource): StageProgram {
  let program = programs.get(source)
  if (!program) {
    const [entry] = source.modules
    program =
      source.entry === null && source.modules.length === 1 && !isModuleCode(entry.text)
        ? { kind: 'script', code: entry.text }
        : { kind: 'modules', modules: source.modules.map((module, i) => compileModule(parseModule(module, i === 0))) }
    programs.set(source, program)
  }
  return program
}

/**
 * A module as the body of an async function with one parameter, __lsModule
 * (stage/worker.ts): load(path) gives a module's namespace when it has run,
 * dynamic(specifier) loads one at run time, exports(getters, stars) gives
 * this module's exports, meta is import.meta. Line numbers stay the same.
 */
function compileModule(p: Parsed): StageModule {
  const text = p.module.text
  const edits: Array<{ start: number; end: number; text: string }> = []
  const blank = (start: number, end: number): void => {
    edits.push({ start, end, text: text.slice(start, end).replace(/[^\n\r\u2028\u2029]/g, ' ') })
  }
  const head: string[] = []
  const binds: string[] = []
  const getters: string[] = []
  const stars: string[] = []
  const namespaces = new Map<string, string>()
  // One namespace variable per imported path, loaded in the order of the module's imports.
  const ns = (source: AnyNode): string => {
    const path = (resolveSpecifier(p.module.path, String(source.value)) as { path: string }).path
    let name = namespaces.get(path)
    if (!name) {
      name = `__lsNs${namespaces.size}`
      namespaces.set(path, name)
      head.push(`const ${name} = await __lsModule.load(${JSON.stringify(path)});`)
    }
    return name
  }
  const key = (name: string): string => JSON.stringify(name)
  for (const statement of p.ast.body as AnyNode[]) {
    if (statement.type === 'ImportDeclaration') {
      const from = ns(statement.source as AnyNode)
      for (const s of statement.specifiers as AnyNode[]) {
        const local = (s.local as AnyNode).name as string
        if (s.type === 'ImportNamespaceSpecifier') binds.push(`const ${local} = ${from};`)
        else binds.push(`const ${local} = ${from}[${key(s.type === 'ImportDefaultSpecifier' ? 'default' : nameOf(s.imported as AnyNode))}];`)
      }
      blank(statement.start, statement.end)
    } else if (statement.type === 'ExportNamedDeclaration') {
      if (statement.declaration) {
        const declaration = statement.declaration as AnyNode
        blank(statement.start, declaration.start)
        for (const name of boundNames(declaration)) getters.push(`${key(name)}: () => ${name}`)
      } else {
        const from = statement.source ? ns(statement.source as AnyNode) : null
        for (const s of statement.specifiers as AnyNode[]) {
          const local = nameOf(s.local as AnyNode)
          getters.push(`${key(nameOf(s.exported as AnyNode))}: () => ${from ? `${from}[${key(local)}]` : local}`)
        }
        blank(statement.start, statement.end)
      }
    } else if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = statement.declaration as AnyNode
      const named = (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id
      if (named) {
        blank(statement.start, declaration.start)
        getters.push(`"default": () => ${(declaration.id as AnyNode).name as string}`)
      } else {
        // An expression, or a function or class without a name: a constant. The ; keeps a next line that starts with ( apart.
        edits.push({ start: statement.start, end: declaration.start, text: 'const __lsDefault = ' })
        edits.push({ start: declaration.end, end: declaration.end, text: ';' })
        getters.push('"default": () => __lsDefault')
      }
    } else if (statement.type === 'ExportAllDeclaration') {
      const from = ns(statement.source as AnyNode)
      if (statement.exported) getters.push(`${key(nameOf(statement.exported as AnyNode))}: () => ${from}`)
      else stars.push(from)
      blank(statement.start, statement.end)
    }
  }
  walk(p.ast, (node) => {
    if (node.type === 'MetaProperty' && (node.meta as AnyNode).name === 'import') edits.push({ start: node.start, end: node.end, text: '__lsModule.meta' })
    else if (node.type === 'ImportExpression') edits.push({ start: node.start, end: (node.source as AnyNode).start, text: '__lsModule.dynamic(' })
  })
  edits.sort((a, b) => b.start - a.start || b.end - a.end)
  let body = text
  for (const edit of edits) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end)
  // Line 1: strict (a module is), the imports, the imported names, the exports. No line break, so the lines stay the same.
  const prefix = `'use strict'; ${head.join(' ')} ${binds.join(' ')} __lsModule.exports({${getters.join(', ')}}, [${stars.join(', ')}]); `
  return { path: p.module.path, code: prefix + body }
}
