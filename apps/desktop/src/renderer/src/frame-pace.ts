/**
 * The display's rate for a page whose process has no frame limit. Chromium's
 * --disable-frame-rate-limit and --disable-gpu-vsync last until a restart (see
 * main/index.ts). So after the performance pill closes, this holds
 * requestAnimationFrame to the display rate, and world pictures follow, because
 * they wait for a page paint. A process that started with the limit never
 * installs this: it has the plain browser function.
 */
const hz = window.space?.frameLimitOff ?? null
let paced = false

if (hz) {
  const native = window.requestAnimationFrame.bind(window)
  const nativeCancel = window.cancelAnimationFrame.bind(window)
  const interval = 1000 / hz
  const queue = new Map<number, FrameRequestCallback>()
  let seq = 0
  let last = 0
  let armed = false

  const fire = (): void => {
    native((now) => {
      armed = false
      // The clock, not `now`: that is the frame's begin time, which lags here, and the wait would come out short.
      last = performance.now()
      const callbacks = [...queue.values()]
      queue.clear()
      for (const callback of callbacks) callback(now)
    })
  }

  // Paced ids are negative, so they never meet an id of the browser.
  window.requestAnimationFrame = (callback) => {
    if (!paced) return native(callback)
    const id = --seq
    queue.set(id, callback)
    if (!armed) {
      armed = true
      const wait = last + interval - performance.now()
      if (wait > 1) setTimeout(fire, wait)
      else fire()
    }
    return id
  }
  window.cancelAnimationFrame = (id) => {
    if (id < 0) queue.delete(id)
    else nativeCancel(id)
  }
}

/** True: requestAnimationFrame keeps the display's rate. It changes nothing in a process with the frame limit. */
export function paceFrames(on: boolean): void {
  paced = on && !!hz
}
