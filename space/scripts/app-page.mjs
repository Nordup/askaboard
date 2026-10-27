/**
 * Find the app's board window among the CDP targets of a dev app
 * (SPACE_REMOTE_DEBUG). Used by scripts/drive.mjs and scripts/lab/common.mjs.
 *
 * The board window is chosen by what it is, not by what it is not: its URL is
 * the renderer page (the dev server on localhost, or out/renderer/index.html),
 * without ?snapshot=1. Other pages come and go: the stage process
 * (ls-stage://) and the snapshot window start a few seconds after the board,
 * and while a page loads, /json/list shows it with an empty URL, first in the
 * list. An exclusion filter took such a page for the board.
 */

const RENDERER_URL = /^(https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/|file:\/\/.*\/renderer\/index\.html)/

export function isAppPage(target) {
  return target.type === 'page' && RENDERER_URL.test(target.url) && !target.url.includes('snapshot=1')
}

/**
 * The board window's target. Waits until it is listed (the app may still be
 * starting) and fails after timeoutMs with the targets it saw.
 * makeError(message) builds the caller's error type.
 */
export async function findAppPage(port, { timeoutMs = 20_000, makeError = (m) => new Error(m) } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let targets
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    } catch {
      throw makeError(`No app with remote debugging on 127.0.0.1:${port}. Start it with SPACE_REMOTE_DEBUG=${port} npm run dev (dev builds only).`)
    }
    const pages = targets.filter(isAppPage)
    if (pages.length === 1) return pages[0]
    if (Date.now() > deadline) {
      const seen = targets.map((t) => `${t.type} ${JSON.stringify(t.url)}`).join(', ') || 'none'
      throw makeError(
        pages.length > 1
          ? `Port ${port} shows ${pages.length} board windows; drive needs one. Targets: ${seen}`
          : `Port ${port} answers, but no board window loaded in ${timeoutMs / 1000} s. Targets: ${seen}`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
