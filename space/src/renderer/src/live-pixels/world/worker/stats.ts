/**
 * What rendering cost, while the page asks (PageToWorld `stats`). meter is null
 * while off, and then the paint path pays one null check per step and nothing
 * else. While on, renderer.info keeps its count over all passes of a picture.
 *
 * GPU time comes from EXT_disjoint_timer_query_webgl2 when this context has it.
 * Without it, or for a window with no valid timer result, gpuMs is the fence time
 * of watchGpu, and gpuSource says so: a fence wall time is not pure GPU time.
 */
export const STATS = String.raw`
  let meter = null;

  const middle = (list, share) => {
    if (!list.length) return null;
    const sorted = list.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
  };
  const perPicture = (total, pictures) => (pictures ? total / pictures : null);

  const clearWindow = (m) => {
    Object.assign(m, { from: realNow(), pictures: 0, gpu: [], fence: [], wall: [], cpu: [], pixels: 0, calls: 0, triangles: 0, passes: 0, worlds: 0, waited: 0 });
  };

  /** The answers of finished timer queries. A disjoint period makes a result useless, so that result is dropped. */
  const meterDrain = () => {
    const m = meter, gl = m.gl, ext = m.ext;
    while (m.queries.length && gl.getQueryParameter(m.queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const query = m.queries.shift(), ns = gl.getQueryParameter(query, gl.QUERY_RESULT);
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) m.gpu.push(ns / 1e6);
      gl.deleteQuery(query);
    }
  };

  const meterSend = () => {
    const m = meter;
    if (!m || dead) return;
    if (m.ext) meterDrain();
    const seconds = (realNow() - m.from) / 1000, n = m.pictures, gpu = m.gpu.length ? m.gpu : m.fence, memory = infoNow();
    let alive = 0, share = 1;
    const crops = [];
    for (const w of worlds.values()) {
      if (w.failed || !(w.setUp || w.ran)) continue;
      alive++;
      if (w.placement && w.placement.shown) share = Math.min(share, QUALITY[w.quality]);
      if (w.drawn && w.reach && !w.reach.full) {
        const c = w.drawn.crop, r = w.reach, inner = innerOf(w, w.drawn.s, c);
        crops.push({ scale: w.drawn.s, reach: [Math.round(r.r - r.l), Math.round(r.b - r.t)], scene: [inner.r - inner.l, inner.b - inner.t], crop: [c.r - c.l, c.b - c.t] });
      }
    }
    post({ type: 'stats', stats: {
      seconds, pictures: n, picturesPerSecond: n / seconds,
      gpuSource: !gpu.length ? null : gpu === m.fence ? 'fence' : 'timer',
      gpuMsMedian: middle(gpu, 0.5), gpuMsP95: middle(gpu, 0.95), fenceMsMedian: middle(m.fence, 0.5),
      pictureMsMedian: middle(m.wall, 0.5), cpuMsMedian: middle(m.cpu, 0.5), resolution: share,
      megapixels: perPicture(m.pixels / 1e6, n), drawCalls: perPicture(m.calls, n), triangles: perPicture(m.triangles, n), passes: perPicture(m.passes, n),
      programs: memory.programs, textures: memory.textures, geometries: memory.geometries, targets: memory.targets,
      crops, worldsAlive: alive, worldsRendered: perPicture(m.worlds, n), worldsWaited: perPicture(m.waited, n)
    } });
    clearWindow(m);
    m.timer = nativeSetTimeout(meterSend, 1000);
  };

  const setStats = (on) => {
    if (on === !!meter || dead) return;
    if (on) {
      const gl = renderer.getContext();
      meter = { gl, ext: gl.getExtension('EXT_disjoint_timer_query_webgl2'), queries: [], query: null, began: 0, rendered: 0, frameAt: 0, calls: 0, cpuMs: 0, timer: 0 };
      clearWindow(meter);
      renderer.info.autoReset = false;
      meter.timer = nativeSetTimeout(meterSend, 1000);
    } else {
      nativeClearTimeout(meter.timer);
      for (const query of meter.queries) meter.gl.deleteQuery(query);
      meter = null;
      renderer.info.autoReset = true;
    }
  };

  /** Before the first render call of a picture. */
  const meterBegin = () => {
    const m = meter;
    renderer.info.reset();
    m.frameAt = renderer.info.render.frame;
    m.rendered = 0;
    m.began = realNow();
    if (m.ext && !m.query) {
      m.query = m.gl.createQuery();
      m.gl.beginQuery(m.ext.TIME_ELAPSED_EXT, m.query);
    }
  };
  /** After the last draw of a picture. */
  const meterStop = () => {
    const m = meter;
    if (!m.query) return;
    m.gl.endQuery(m.ext.TIME_ELAPSED_EXT);
    m.queries.push(m.query);
    m.query = null;
  };
  /** Nothing changed, so there is no picture, and this one counts for nothing. */
  const meterDrop = () => {
    const m = meter;
    if (!m.query) return;
    m.gl.endQuery(m.ext.TIME_ELAPSED_EXT);
    m.gl.deleteQuery(m.query);
    m.query = null;
  };
  /** The picture is on its way. pixels: of the worlds rendered for it; a picture that only composites again has none. */
  const meterEnd = (pixels, waited) => {
    const m = meter;
    const info = renderer.info.render;
    m.cpu.push(realNow() - m.began);
    m.pictures++;
    m.pixels += pixels;
    m.calls += info.calls;
    m.triangles += info.triangles;
    m.passes += info.frame - m.frameAt;
    m.worlds += m.rendered;
    m.waited += waited;
  };
  /** The fence of a picture signalled. */
  const meterFence = (ms, wall) => {
    const m = meter;
    m.fence.push(ms);
    m.wall.push(wall);
    if (m.ext) meterDrain();
  };
`
