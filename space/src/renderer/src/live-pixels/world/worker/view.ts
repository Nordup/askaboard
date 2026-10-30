/**
 * One world's view on the surface: no frame, no stretch (architecture section 4).
 *
 * Three spaces, all with y down:
 * - Board points from the world's anchor (the centre of its nominal rect). Reach
 *   is in these units, so it does not change with the zoom.
 * - Nominal pixels from the anchor: board points times the world's scale s. A crop
 *   is in these units. A crop edge is always a multiple of GRID, so the pixels of
 *   a world stay fixed on the world: a pan moves the output and does not render.
 * - Surface pixels: the device pixels of the surface.
 *
 * The camera keeps its nominal frustum (camera.aspect is the nominal aspect), and
 * setViewOffset takes a crop that can pass the nominal rect. So the size of a
 * render target never changes the scale or the perspective.
 */
export const VIEW = String.raw`
  /** Steps of a crop and of a render target, in pixels. The last bloom mip is 1/32, so its texels stay fixed on the world too. */
  const GRID = 64;
  /** Room for glow in pixels: bloom spreads a fixed number of pixels, up to 22 texels of its 1/32 mip. */
  const GLOW_ROOM = 448;
  /** Room for anything else, in pixels: a soft edge, a thin line on the bounds. */
  const SOFT_ROOM = 32;
  /** Renders of a world between two measures of its bounds. */
  const SAMPLE_EVERY = 6;
  /** The share of the distance that reach shrinks per measure. It grows at once. */
  const SHRINK = 0.04;

  const reachVector = () => reachVector.v || (reachVector.v = new THREE.Vector3());
  const reachBox = () => reachBox.b || (reachBox.b = new THREE.Box3());

  /** Geometry to the position version of its last bounding box. */
  const measured = new WeakMap();
  const versionOf = (attribute) => (attribute.isInterleavedBufferAttribute ? attribute.data.version : attribute.version);

  /** The world's bounds in world space: what its objects really draw now. Null when empty. */
  const measure = (w) => {
    const box = w.bounds.makeEmpty();
    const part = reachBox();
    w.scene.updateMatrixWorld();
    const visit = (o) => {
      if (!o.visible || o === w.stage) return;
      const g = o.geometry;
      const position = g && g.attributes && g.attributes.position;
      if (position) {
        const instanced = o.isInstancedMesh;
        const version = versionOf(position) + (instanced ? o.instanceMatrix.version * 65536 : 0);
        if (!g.boundingBox || measured.get(o.isInstancedMesh ? o : g) !== version) {
          if (instanced) o.computeBoundingBox(); else g.computeBoundingBox();
          measured.set(instanced ? o : g, version);
        }
        const local = instanced ? o.boundingBox : g.boundingBox;
        if (local && !local.isEmpty()) box.union(part.copy(local).applyMatrix4(o.matrixWorld));
      } else if (o.isSprite) {
        const p = reachVector().setFromMatrixPosition(o.matrixWorld);
        const r = Math.max(o.scale.x, o.scale.y);
        box.union(part.setFromCenterAndSize(p, reachVector().clone().set(r, r, r)));
      }
      for (const child of o.children) visit(child);
    };
    for (const child of w.scene.children) visit(child);
    return box.isEmpty() ? null : box;
  };

  /** The camera with its nominal frustum, no crop. */
  const nominalCamera = (w) => {
    const c = w.camera;
    if (c.isPerspectiveCamera) c.aspect = w.w / w.h;
    if (c.view && c.view.enabled) c.clearViewOffset(); else c.updateProjectionMatrix();
    c.updateMatrixWorld();
  };

  /** Expand r (board points from the anchor) by the projection of box. False when a corner is behind the camera. */
  const projectBox = (w, box, r) => {
    const c = w.camera, v = reachVector();
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      v.applyMatrix4(c.matrixWorldInverse);
      if (c.isPerspectiveCamera && v.z > -c.near) return false;
      v.applyMatrix4(c.projectionMatrix);
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return false;
      const x = (v.x * w.w) / 2, y = (-v.y * w.h) / 2;
      if (x < r.l) r.l = x;
      if (x > r.r) r.r = x;
      if (y < r.t) r.t = y;
      if (y > r.b) r.b = y;
    }
    return true;
  };

  /** Measure the bounds and update reach: grows at once, shrinks slowly. */
  const sampleReach = (w) => {
    if (typeof w.reachSet === 'number') {
      const n = w.reachSet;
      w.reach = { l: -n, t: -n, r: n, b: n, full: false };
      return;
    }
    if (w.reachSet === 'full') { w.reach = { l: 0, t: 0, r: 0, b: 0, full: true }; return; }
    const box = measure(w);
    if (!box) { w.reach = null; return; }
    nominalCamera(w);
    const r = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity, full: false };
    let seen = projectBox(w, box, r);
    if (floorOn(w)) {
      if (!w.floorBuilt) buildFloor(w, box);
      for (const extra of floorBoxes(w, box)) seen = projectBox(w, extra, r) && seen;
    }
    if (!seen) { w.reach = { l: 0, t: 0, r: 0, b: 0, full: true }; return; }
    const old = w.reach;
    if (old && !old.full) {
      r.l = r.l < old.l ? r.l : old.l + (r.l - old.l) * SHRINK;
      r.t = r.t < old.t ? r.t : old.t + (r.t - old.t) * SHRINK;
      r.r = r.r > old.r ? r.r : old.r + (r.r - old.r) * SHRINK;
      r.b = r.b > old.b ? r.b : old.b + (r.b - old.b) * SHRINK;
    }
    w.reach = r;
  };

  /** The placement in surface pixels. */
  const placed = (w) => {
    const p = w.placement, cam = surface.camera, dpr = surface.dpr, m = p.matrix;
    const k = Math.max(1e-4, Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])));
    const a = m[0] / k, b = m[1] / k, c = m[2] / k, d = m[3] / k;
    const plain = Math.abs(a - 1) < 1e-4 && Math.abs(d - 1) < 1e-4 && Math.abs(b) < 1e-4 && Math.abs(c) < 1e-4;
    const bx = p.x + p.w / 2 + m[4], by = p.y + p.h / 2 + m[5];
    let cx = ((bx - cam.x) * cam.zoom + surface.margin) * dpr;
    let cy = ((by - cam.y) * cam.zoom + surface.margin) * dpr;
    // A crop has whole pixels from the anchor, so a whole anchor keeps the output sharp in a pan.
    if (plain) { cx = Math.round(cx); cy = Math.round(cy); }
    return { s: cam.zoom * dpr * k, cx, cy, a, b, c, d, plain };
  };

  /** A box in nominal pixels, snapped out to the grid, or null when empty. */
  const snapped = (l, t, r, b) => {
    if (!(r > l) || !(b > t)) return null;
    return { l: Math.floor(l / GRID) * GRID, t: Math.floor(t / GRID) * GRID, r: Math.ceil(r / GRID) * GRID, b: Math.ceil(b / GRID) * GRID };
  };

  const room = (w) => (w.look.bloom > 0 ? GLOW_ROOM : SOFT_ROOM);

  /** What must be rendered now: reach cut by the surface, in nominal pixels from the anchor. Null when none of it is on the surface. */
  const cropFor = (w, place) => {
    const reach = w.reach;
    if (!reach) return null;
    // The surface in nominal pixels: the inverse of the placement.
    const det = place.a * place.d - place.b * place.c;
    let sl = Infinity, st = Infinity, sr = -Infinity, sb = -Infinity;
    for (let i = 0; i < 4; i++) {
      const x = (i & 1 ? surface.width : 0) - place.cx, y = (i & 2 ? surface.height : 0) - place.cy;
      const qx = (place.d * x - place.c * y) / det, qy = (-place.b * x + place.a * y) / det;
      if (qx < sl) sl = qx;
      if (qx > sr) sr = qx;
      if (qy < st) st = qy;
      if (qy > sb) sb = qy;
    }
    if (reach.full) return snapped(sl, st, sr, sb);
    const pad = room(w);
    const s = place.s;
    return snapped(Math.max(sl, reach.l * s - pad), Math.max(st, reach.t * s - pad), Math.min(sr, reach.r * s + pad), Math.min(sb, reach.b * s + pad));
  };

  const contains = (a, b) => a.l <= b.l && a.t <= b.t && a.r >= b.r && a.b >= b.b;

  /** Aim the world's camera at a crop. s: nominal pixels per board point. */
  const aimCamera = (w, s, crop) => {
    const c = w.camera, nw = w.w * s, nh = w.h * s;
    if (c.isPerspectiveCamera) c.aspect = w.w / w.h;
    c.setViewOffset(nw, nh, nw / 2 + crop.l, nh / 2 + crop.t, crop.r - crop.l, crop.b - crop.t);
    c.updateMatrixWorld();
  };

  // Render targets. Shared targets hold the passes of one world and are free again after that pass.
  // Outputs belong to one world until it gives them back.
  const shared = new Map();
  const spareOutputs = new Map();
  let useCount = 0;
  const sharedOf = (kind, W, H, make) => {
    const id = kind + ':' + W + 'x' + H;
    let entry = shared.get(id);
    if (!entry) { entry = { item: make(), used: 0 }; shared.set(id, entry); }
    entry.used = useCount;
    return entry.item;
  };
  const TRIM_AFTER = 600;
  const trimTargets = () => {
    useCount++;
    if (useCount % 120) return;
    for (const [id, entry] of shared) if (useCount - entry.used > TRIM_AFTER) { entry.item.dispose(); shared.delete(id); }
    for (const [id, list] of spareOutputs) { for (const t of list) t.dispose(); spareOutputs.delete(id); }
  };
  const takeOutput = (W, H) => {
    const list = spareOutputs.get(W + 'x' + H);
    if (list && list.length) return list.pop();
    return new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  };
  const giveOutput = (t) => {
    const id = t.width + 'x' + t.height;
    if (!spareOutputs.has(id)) spareOutputs.set(id, []);
    spareOutputs.get(id).push(t);
  };
`
