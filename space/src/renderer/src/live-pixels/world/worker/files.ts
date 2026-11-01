/**
 * Files of the learning folder for a world's code, and a world's console. See
 * docs/learning-space/one-world-architecture.md, section 6.
 *
 * The worker's script is a data: URL, so a relative URL has no base. Here a path
 * with no scheme becomes a URL of main/live-item-protocol.ts, in fetch, in
 * new Request (three's FileLoader) and in XMLHttpRequest. The main process stops
 * every path that leaves the folder. A read that fails gives the protocol's
 * response: 404 for a missing file, 403 for a refused path.
 *
 * Bytes come by the protocol as a stream, so they pass neither the page nor IPC.
 * The worker keeps a read as a Blob while a world that read it lives, so a seek
 * reads no file again. Each read asks main whether the file changed: a replay
 * reads the file as it is now.
 *
 * A load: a read, or an item of three's default LoadingManager, which lasts up
 * to the end of a loader's parse. While loads run, step time waits and the page
 * does not take the worker as hung. After the last load, each world gets a few
 * picture checks, so a model shows with no world.redraw().
 */
export const FILES = String.raw`
  const nativeFetch = scope.fetch.bind(scope);
  const NativeRequest = scope.Request;
  const FILE_URL = LIVE_ORIGIN + '/file?path=';
  /** What a world's relative import starts from. Each generation has its own path, so its modules run again, as its code does. */
  const moduleBase = (w) => LIVE_ORIGIN + '/module/' + w.key.generation + '/boards/scenes/';

  /** The protocol's URL of a request for a file, or null for any other request. A path has no scheme; the main process refuses an absolute one. */
  const fileUrlOf = (input) => {
    if (typeof input === 'string') {
      if (input.startsWith(FILE_URL)) return input;
      return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(input) ? null : FILE_URL + encodeURIComponent(input.replace(/[?#].*$/, ''));
    }
    return input instanceof NativeRequest && input.url.startsWith(FILE_URL) ? input.url : null;
  };

  // Loads now, the bytes they read, when the last one ended.
  const QUIET_MS = 100;
  let loads = 0, loadBytes = 0, loadedAt = -Infinity;
  const filesBusy = () => loads > 0 || realNow() - loadedAt < QUIET_MS;
  /** Step time waits here. Between a read and the code that uses it, QUIET_MS gives that code its turn. */
  const filesDone = async (w) => { while (filesBusy() && !w.failed) await new Promise((resolve) => nativeSetTimeout(resolve, 10)); };

  // After a load: a check of each world's picture, at these delays. A check renders only what changed.
  const CHECK_AFTER_MS = [30, 200, 800];
  let checks = 0;
  const checkPictures = () => {
    nativeClearTimeout(checks);
    let i = 0;
    const next = () => {
      for (const w of worlds.values()) w.ticked = true;
      surface.dirty = true;
      schedule();
      if (++i < CHECK_AFTER_MS.length) checks = nativeSetTimeout(next, CHECK_AFTER_MS[i] - CHECK_AFTER_MS[i - 1]);
    };
    checks = nativeSetTimeout(next, CHECK_AFTER_MS[0]);
  };

  const loadStarted = () => {
    if (!loads++) loadBytes = 0;
    post({ type: 'files', bytes: loadBytes });
  };
  const loadEnded = (bytes) => {
    loads--;
    loadBytes += bytes;
    loadedAt = realNow();
    post({ type: 'files', bytes: loadBytes });
    if (!loads) checkPictures();
  };

  // The reads that worlds keep. URL to { tag, blob, users }. A read with no user goes after KEEP_MS.
  const KEEP_MS = 10000;
  const kept = new Map();
  const releaseFiles = (w) => {
    for (const url of w.files) {
      const entry = kept.get(url);
      if (!entry) continue;
      entry.users.delete(w);
      if (!entry.users.size) nativeSetTimeout(() => { if (!entry.users.size && kept.get(url) === entry) kept.delete(url); }, KEEP_MS);
    }
    w.files.clear();
  };

  const readFile = async (url, signal) => {
    const w = owner();
    let bytes = 0;
    loadStarted();
    try {
      let entry = kept.get(url);
      const response = await nativeFetch(entry ? url + '&known=' + encodeURIComponent(entry.tag) : url, signal ? { signal } : undefined);
      if (response.status !== 304) {
        if (!response.ok) { kept.delete(url); return response; }
        entry = { tag: response.headers.get('etag'), blob: await response.blob(), users: new Set() };
        kept.set(url, entry);
      }
      if (w) { entry.users.add(w); w.files.add(url); }
      bytes = entry.blob.size;
      return new Response(entry.blob, { headers: { 'content-type': entry.blob.type, 'content-length': String(bytes) } });
    } finally {
      loadEnded(bytes);
    }
  };

  scope.fetch = (input, init) => {
    const url = fileUrlOf(input), request = input instanceof NativeRequest ? input : null;
    const method = (init && init.method) || (request ? request.method : 'GET');
    if (url === null || method !== 'GET') return nativeFetch(url || input, init);
    return readFile(url, (init && init.signal) || (request ? request.signal : undefined));
  };
  scope.Request = class Request extends NativeRequest {
    constructor(input, init) { super(fileUrlOf(input) || input, init); }
  };
  const xhrOpen = scope.XMLHttpRequest.prototype.open;
  scope.XMLHttpRequest.prototype.open = function (method, url, ...rest) { return xhrOpen.call(this, method, fileUrlOf(String(url)) || url, ...rest); };

  /** Called once, when three is here: loads of the default manager count, and images load with no document. */
  const watchLoaders = () => {
    const manager = THREE.DefaultLoadingManager, start = manager.itemStart, end = manager.itemEnd;
    manager.itemStart = (url) => { loadStarted(); start(url); };
    manager.itemEnd = (url) => { end(url); loadEnded(0); };
    // ImageLoader makes an img element, and a worker has none. A canvas follows flipY as an image does; an ImageBitmap does not.
    THREE.ImageLoader.prototype.load = function (url, onLoad, onProgress, onError) {
      const full = this.manager.resolveURL(this.path === undefined ? url : this.path + url), loader = this.manager;
      loader.itemStart(full);
      scope.fetch(full)
        .then((response) => {
          if (!response.ok) throw new Error('Image "' + full + '": ' + response.status + ' ' + response.statusText);
          return response.blob();
        })
        .then((blob) => createImageBitmap(blob, { colorSpaceConversion: 'none' }))
        .then((bitmap) => {
          const image = new OffscreenCanvas(bitmap.width, bitmap.height);
          image.getContext('2d').drawImage(bitmap, 0, 0);
          bitmap.close();
          if (onLoad) onLoad(image);
        })
        .catch((error) => {
          loader.itemError(full);
          if (onError) onError(error); else console.error(error);
        })
        .finally(() => loader.itemEnd(full));
    };
  };

  // A world's console also goes to the agent: at most LOG_LINES lines per generation, of at most LOG_CHARS characters.
  const LOG_LINES = 40, LOG_CHARS = 400;
  const logText = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return messageOf(value);
    try { return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value); } catch (e) { return Object.prototype.toString.call(value); }
  };
  for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
    const native = console[level].bind(console);
    console[level] = (...args) => {
      native(...args);
      const w = owner();
      if (!w || w.logLines > LOG_LINES) return;
      w.logLines++;
      if (w.logLines > LOG_LINES) post({ type: 'log', key: w.key, level: 'warn', text: 'This world logged more; the rest is left out.' });
      else post({ type: 'log', key: w.key, level, text: readable(args.map(logText).join(' ')).slice(0, LOG_CHARS) });
    };
  }
`
