import { BLEND_GAP, paramsAtTime } from '../../../live/params'
import { LIVE_ORIGIN, LOCAL_LIBRARIES, programBody, resolveLiveSpecifier } from '@shared/live-libs'
import { WORLD_TICK_HZ } from '@shared/world-protocol'
import { FILES } from './files'
import { LOOK } from './look'
import { PICTURE } from './picture'
import { REALM } from './realm'
import { STATS } from './stats'
import { SURFACE } from './surface'
import { TOON } from './toon'
import { TOUCH } from './touch'
import { VIEW } from './view'

/**
 * The world worker: one realm, one WebGLRenderer, all worlds of a board. See
 * docs/learning-space/one-world-architecture.md. The contract with the page is
 * shared/world-protocol.ts.
 *
 * The script is a data: URL, and it runs in the sandboxed
 * frame of main/live-item-protocol.ts. These parts share one closure:
 *
 * - realm.ts: time, Math.random and timers per world, the clock, the API that
 *   a world's code gets.
 * - files.ts: files of the learning folder, loads, a world's console.
 * - view.ts: what a world really draws (reach), the crop, the render targets.
 * - touch.ts: pick, pins, ink, the hand's events, the anchor.
 * - picture.ts: whether a tick changed what a render would show.
 * - toon.ts: the look of every world.
 * - look.ts: a world's stage, and its render into its private output.
 * - stats.ts: what one second of rendering cost, while the page asks for it.
 * - surface.ts: compositing, pictures, the frame loop, the messages.
 */

/** Overscan of the surface in CSS pixels per side: a pan shows no empty edge before the next picture. */
export const WORLD_MARGIN = 256

/** The local libraries as a table for the worker, so a world's imports and the runtime share one module instance. */
function librariesTable(): { exact: Record<string, string>; prefix: Array<[string, string]> } {
  const exact: Record<string, string> = {}
  const prefix: Array<[string, string]> = []
  for (const name of LOCAL_LIBRARIES) {
    if (name.endsWith('…')) {
      const head = name.slice(0, -1)
      prefix.push([head, resolveLiveSpecifier(`${head}x`, false).slice(0, -1)])
    } else exact[name] = resolveLiveSpecifier(name, false)
  }
  return { exact, prefix }
}

// programBody calls resolveLiveSpecifier by its name in the bundle, so the worker's resolver takes that name.
function source(): string {
  return `'use strict';
(() => {
  const scope = self;
  const hz = ${WORLD_TICK_HZ};
  const paramsAtTime = ${paramsAtTime.toString()};
  const BLEND_GAP = ${BLEND_GAP};
  const LIVE_ORIGIN = ${JSON.stringify(LIVE_ORIGIN)};
  const LIBS = ${JSON.stringify(librariesTable())};
  // A relative import starts here: boards/scenes/ of the world that compiles or calls import() now.
  let importBase = '';
  const ${resolveLiveSpecifier.name} = (spec) => {
    if (/^\\.{1,2}\\//.test(spec)) return new URL(spec, importBase).href;
    if (/^(\\/|[a-z][a-z0-9+.-]*:)/i.test(spec)) return spec;
    if (LIBS.exact[spec]) return LIBS.exact[spec];
    for (const [head, url] of LIBS.prefix) if (spec.startsWith(head)) return url + spec.slice(head.length);
    return 'https://esm.sh/' + spec;
  };
  const resolveLibrary = ${resolveLiveSpecifier.name};
  const compileBody = ${programBody.toString()};
${REALM}
${FILES}
${VIEW}
${TOUCH}
${PICTURE}
${TOON}
${LOOK}
${STATS}
${SURFACE}
})();
`
}

let url: string | null = null

/** The worker's URL. The surface gives it to the frame. */
export function worldWorkerUrl(): string {
  url ??= `data:text/javascript;charset=utf-8,${encodeURIComponent(source())}`
  return url
}
