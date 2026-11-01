/**
 * Files of the learning folder for a world's code, and a world's console. See
 * docs/learning-space/one-world-architecture.md, section 6.
 *
 * The worker's script is a data: URL, so a relative URL has no base. Here a path
 * with no scheme becomes a URL of main/live-item-protocol.ts, in fetch, in
 * new Request (three's FileLoader) and in XMLHttpRequest. Each URL holds this
 * worker's token. The main process stops every path that leaves the folder and
 * every file that is no asset. A read that fails gives the protocol's response:
 * 404 for a missing file, 403 for a refused path.
 *
 * Bytes come by the protocol as a stream, so they pass neither the page nor IPC.
 * The worker keeps a read as a Blob while a world that read it lives, so a seek
 * reads no file again. Each read asks main whether the file changed: a replay
 * reads the file as it is now.
 *
 * A load: a read, or an item of a LoadingManager, which lasts up to the end of a
 * loader's parse. While a world's own loads run, its step time waits, for
 * FILES_WAIT_MS at most with no news of a load, and the page does not take the
 * worker as hung. After a world's last load, each world gets a few picture checks,
 * so a model shows with no world.redraw().
 *
 * A load belongs to the world that started it, and a loader's parse goes on long
 * after that world's turn. So each world has its own LoadingManager, a loader takes
 * it when it is made, and the loaders of a parse get it from their parent. An item
 * belongs to its manager, and a file URL that the manager resolves names the world in
 * its fragment. A load with no world holds up every world's step time (filesBusy).
 */
export const FILES = String.raw`
  const nativeFetch = scope.fetch.bind(scope);
  const NativeRequest = scope.Request;
  let fileToken = '', FILE_URL = '';
  /** The right of this worker to read the folder: it comes from the page, before any world. */
  const setFileToken = (token) => { fileToken = String(token || 'none'); FILE_URL = LIVE_ORIGIN + '/file/' + fileToken + '?path='; };
  setFileToken('');
  /** What a world's relative import starts from. Each generation has its own path, so its modules run again, as its code does. */
  const moduleBase = (w) => LIVE_ORIGIN + '/module/' + fileToken + '/' + w.key.generation + '/boards/scenes/';

  /** A path as a loader gives it can be URL text, such as mesh%20data.bin in a glTF file. Decoded once here, it is the name of the file. */
  const pathOf = (input) => {
    const path = input.replace(/[?#].*$/, '');
    try { return decodeURIComponent(path); } catch (e) { return path; }
  };

  /** The protocol's URL of a request for a file, or null for any other request. A path has no scheme; the main process refuses an absolute one. */
  const fileUrlOf = (input) => {
    if (typeof input === 'string') {
      if (input.startsWith(FILE_URL)) return input;
      return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(input) ? null : FILE_URL + encodeURIComponent(pathOf(input));
    }
    return input instanceof NativeRequest && input.url.startsWith(FILE_URL) ? input.url : null;
  };

  /** A file URL that names world w. A fragment never leaves the worker. Any other URL stays as it is. */
  const namedUrl = (url, w) => {
    const file = fileUrlOf(url);
    if (file === null) return url;
    return file.includes('#') ? file : file + '#' + encodeURIComponent(w.id);
  };
  /** The world of a load whose world left: nothing waits for it. */
  const LEFT = { id: '', loads: 0, loadedAt: 0 };
  /** The world of a read: the one that its URL names, else the code that runs now. Null: no world is known, and no guess takes its place. */
  const readerOf = (url) => {
    const at = url.indexOf('#');
    return at < 0 ? runner() : worlds.get(decodeURIComponent(url.slice(at + 1))) || LEFT;
  };

  // Loads now: in the worker, per world, and of no world. A world waits for its own: a load that stalls in another world, or in one that left, holds up nothing here.
  // A load of no world can be any world's, so all wait for it. That costs a wait and no wrong still, and it is rare: code in a library, after an await, outside any loader.
  const QUIET_MS = 100, FILES_WAIT_MS = 30000;
  let loads = 0, loose = 0;
  const filesBusy = (w) => !w.failed && (w.loads > 0 || loose > 0 || realNow() - w.loadedAt < QUIET_MS);
  /**
   * Step time waits here. Between a read and the code that uses it, QUIET_MS gives that code its turn. Only time spent here counts toward FILES_WAIT_MS,
   * so a parse that blocks the worker does not. A load with no news for that long is stalled, and step time goes on without it.
   */
  const filesDone = async (w) => {
    let news = w.loadedAt, waited = 0;
    while (filesBusy(w)) {
      if (w.loadedAt !== news) { news = w.loadedAt; waited = 0; }
      if ((waited += 10) > FILES_WAIT_MS) { w.loads = 0; loose = 0; return; }
      await new Promise((resolve) => nativeSetTimeout(resolve, 10));
    }
  };

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

  /** w: the world that the load belongs to, or null. */
  const loadStarted = (w) => {
    loads++;
    if (w) { w.loads++; w.loadedAt = realNow(); } else loose++;
    post({ type: 'files' });
  };
  const loadEnded = (w) => {
    loads--;
    if (w) { if (w.loads > 0) w.loads--; w.loadedAt = realNow(); } else if (loose > 0) loose--;
    post({ type: 'files' });
    if (!loads || (w ? !w.loads : !loose)) checkPictures();
  };

  // The reads that worlds keep. URL to { tag, blob, users }. A read with no user goes after KEEP_MS.
  const KEEP_MS = 10000;
  const kept = new Map();
  const forgetLater = (url, entry) => nativeSetTimeout(() => { if (!entry.users.size && kept.get(url) === entry) kept.delete(url); }, KEEP_MS);
  const releaseFiles = (w) => {
    for (const url of w.files) {
      const entry = kept.get(url);
      if (!entry) continue;
      entry.users.delete(w);
      if (!entry.users.size) forgetLater(url, entry);
    }
    w.files.clear();
  };

  // Reads on their way. URL to { done, readers, stop }. Worlds that ask for one file at once share one read: it gives { entry } or a failed { response }.
  const reading = new Map();
  const startRead = (url) => {
    const read = { done: null, readers: 0, stop: new AbortController() }, known = kept.get(url);
    const run = async () => {
      try {
        const response = await nativeFetch(known ? url + '&known=' + encodeURIComponent(known.tag) : url, { signal: read.stop.signal });
        if (response.status === 304) { kept.set(url, known); return { entry: known }; }
        if (!response.ok) { kept.delete(url); return { response }; }
        const entry = { tag: response.headers.get('etag'), blob: await response.blob(), users: new Set() };
        kept.set(url, entry);
        return { entry };
      } finally {
        if (reading.get(url) === read) reading.delete(url);
      }
    };
    reading.set(url, read);
    read.done = run();
    read.done.catch(() => {});
    return read;
  };
  /** The result of a read for one reader. Its signal ends only its own wait. The read itself stops when no reader is left. */
  const joinRead = (read, url, signal) => {
    read.readers++;
    if (!signal) return read.done;
    return new Promise((resolve, reject) => {
      const leave = () => {
        reject(signal.reason);
        if (--read.readers) return;
        if (reading.get(url) === read) reading.delete(url);
        read.stop.abort();
      };
      if (signal.aborted) { leave(); return; }
      signal.addEventListener('abort', leave, { once: true });
      read.done.then(resolve, reject).finally(() => signal.removeEventListener('abort', leave));
    });
  };

  const readFile = async (name, signal) => {
    const w = readerOf(name), url = name.split('#')[0];
    loadStarted(w);
    try {
      const { entry, response } = await joinRead(reading.get(url) || startRead(url), url, signal);
      if (response) return response.clone();
      // A world can leave while its read runs: then only the timer lets the read go.
      if (w && worlds.get(w.id) === w) { entry.users.add(w); w.files.add(url); } else if (!entry.users.size) forgetLater(url, entry);
      return new Response(entry.blob, { headers: { 'content-type': entry.blob.type, 'content-length': String(entry.blob.size) } });
    } finally {
      loadEnded(w);
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

  /** Called once, when three is here: items of a loading manager count as loads of its world, and images load with no document. */
  const watchLoaders = () => {
    const shared = THREE.DefaultLoadingManager;
    const plain = { itemStart: shared.itemStart, itemEnd: shared.itemEnd, itemError: shared.itemError, resolveURL: shared.resolveURL, getHandler: shared.getHandler };
    /** Manager m works for world w, or for no world (null). from: its own functions. World code runs in itemEnd, and a throw there must not leave a load open. */
    const claim = (m, w, from) => {
      const { itemStart, itemEnd, resolveURL } = from;
      m.lsClaimed = true;
      m.itemStart = (url) => { loadStarted(w); itemStart.call(m, url); };
      m.itemEnd = (url) => { try { itemEnd.call(m, url); } finally { loadEnded(w); } };
      m.resolveURL = (url) => (w ? namedUrl(resolveURL.call(m, url), w) : resolveURL.call(m, url));
      return m;
    };
    claim(shared, null, plain);
    /** A loader that names no manager stands for the default one, so its world's manager is a real one of its own, and each item also goes through the default one: its onLoad, modifier and handlers go on working. */
    const worldManager = (w) => {
      const m = new THREE.LoadingManager(), own = { ...m };
      m.itemError = (url) => { try { own.itemError.call(m, url); } finally { plain.itemError.call(shared, url); } };
      m.getHandler = (file) => own.getHandler.call(m, file) || plain.getHandler.call(shared, file);
      return claim(m, w, {
        itemStart: (url) => { own.itemStart.call(m, url); plain.itemStart.call(shared, url); },
        itemEnd: (url) => { try { own.itemEnd.call(m, url); } finally { plain.itemEnd.call(shared, url); } },
        resolveURL: (url) => plain.resolveURL.call(shared, own.resolveURL.call(m, url))
      });
    };
    // A loader of a parse gets its parent's manager, so it stays with the world.
    Object.defineProperty(THREE.Loader.prototype, 'manager', {
      configurable: true,
      get() { return this.lsManager; },
      set(m) {
        const w = runner();
        if (w && m === shared) m = w.manager || (w.manager = worldManager(w));
        else if (w && !m.lsClaimed) claim(m, w, m);
        this.lsManager = m;
      }
    });
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

  // A worker frees a module only when it ends, and each generation has its own URLs, so each run of a world with modules keeps one more copy. A generation
  // must run its modules again, as it runs its code. So a shared copy is no choice, and the bound is a new worker: 'recycle' restarts it, as after a lost context,
  // and each world starts again from its node. This falls in a seek, when a world starts again anyway. It is no loss, so it counts toward no limit. A step host has
  // its own worker and never gets here.
  const MODULE_RUNS = 128;
  let moduleRuns = 0;
  const moduleRun = (w) => {
    if (w.modules) return;
    w.modules = true;
    if (++moduleRuns >= Math.max(tune.moduleRuns ?? MODULE_RUNS, 4 * worlds.size)) post({ type: 'recycle' });
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
