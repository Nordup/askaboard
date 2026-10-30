import { BLEND_GAP, paramsAtTime } from '../../../live/params'
import { LOCAL_LIBRARIES, programBody, resolveLiveSpecifier } from '@shared/live-libs'
import { TICK_HZ } from '../../clock'
import { LOOK } from './look'
import { REALM } from './realm'
import { SURFACE } from './surface'
import { VIEW } from './view'

/**
 * The world worker: one realm, one WebGLRenderer, all worlds of a board. See
 * docs/learning-space/one-world-architecture.md. The contract with the page is
 * shared/world-protocol.ts.
 *
 * The script is a data: URL, as in program.ts, and it runs in the sandboxed
 * frame of main/live-item-protocol.ts. These parts share one closure:
 *
 * - realm.ts: time, Math.random and timers per world, the clock, the API that
 *   a world's code gets.
 * - view.ts: what a world really draws (reach), the crop, the render targets.
 * - look.ts: the film look of one world into its private output.
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
  const hz = ${TICK_HZ};
  const paramsAtTime = ${paramsAtTime.toString()};
  const BLEND_GAP = ${BLEND_GAP};
  const LIBS = ${JSON.stringify(librariesTable())};
  const ${resolveLiveSpecifier.name} = (spec) => {
    if (/^(\\.{0,2}\\/|[a-z][a-z0-9+.-]*:)/i.test(spec)) return spec;
    if (LIBS.exact[spec]) return LIBS.exact[spec];
    for (const [head, url] of LIBS.prefix) if (spec.startsWith(head)) return url + spec.slice(head.length);
    return 'https://esm.sh/' + spec;
  };
  const resolveLibrary = ${resolveLiveSpecifier.name};
  const compileBody = ${programBody.toString()};
${REALM}
${VIEW}
${LOOK}
${SURFACE}
})();
`
}

let url: string | null = null

/** The worker's URL. The surface gives it to the frame, as ProgramHost gives programUrl. */
export function worldWorkerUrl(): string {
  url ??= `data:text/javascript;charset=utf-8,${encodeURIComponent(source())}`
  return url
}
