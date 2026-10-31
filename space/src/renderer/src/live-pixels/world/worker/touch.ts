/**
 * Touch: the hand reaches into a world (architecture section 5). A board point
 * becomes a ray, a ray becomes a hit with a part name, a pin stays on a part as
 * it turns, ink arrives as strokes.
 *
 * Pick has a time limit. three-mesh-bvh is not a dependency of the app and its
 * build needs a bare `three`, so a pick walks typed arrays with plain loops:
 * about 10 ms for a million instances. At the limit it stops and gives the best
 * hit so far. An event computes e.hit only when the code reads it, so a world
 * that only follows the pointer pays nothing.
 */
export const TOUCH = String.raw`
  /** A pick stops after this time. */
  const PICK_MS = 10;
  /** Instances that a pick tests triangle by triangle, nearest first. */
  const PICK_CANDIDATES = 32;
  /** Board points of tolerance for points and lines. */
  const PICK_TOLERANCE = 6;
  /** Triangles per check of the clock. */
  const CLOCK_EVERY = 8192;

  /** A placed world's anchor on the board. A world with no placement has its anchor at the centre of its nominal rect. */
  const anchorOf = (w) => {
    const p = w.placement;
    if (!p) return { x: w.w / 2 + w.moved.x, y: w.h / 2 + w.moved.y, m: [1, 0, 0, 1, 0, 0] };
    return { x: p.x + p.w / 2 + p.matrix[4] + w.moved.x, y: p.y + p.h / 2 + p.matrix[5] + w.moved.y, m: p.matrix };
  };
  /** A board point in nominal board points from the anchor. */
  const nominalOf = (w, x, y) => {
    const a = anchorOf(w), m = a.m, dx = x - a.x, dy = y - a.y, det = m[0] * m[3] - m[1] * m[2] || 1e-6;
    return [(m[3] * dx - m[2] * dy) / det, (-m[1] * dx + m[0] * dy) / det];
  };
  /** Nominal board points from the anchor, as a board point. */
  const boardOf = (w, qx, qy) => {
    const a = anchorOf(w), m = a.m;
    return [a.x + m[0] * qx + m[2] * qy, a.y + m[1] * qx + m[3] * qy];
  };

  let caster = null, screen = null;
  /** The ray of a board point, in world space. The camera's nominal frustum: a crop does not change it. */
  const rayAt = (w, x, y) => {
    if (!caster) { caster = new THREE.Raycaster(); screen = new THREE.Vector2(); }
    nominalCamera(w);
    const q = nominalOf(w, x, y);
    screen.set(q[0] / (w.w / 2), -q[1] / (w.h / 2));
    caster.setFromCamera(screen, w.camera);
    return caster.ray;
  };

  /** Triangles of a geometry against a local ray. The t of the nearest hit below 'best', or best. Null: the clock ran out first. */
  const hitTriangles = (g, ray, best, deadline) => {
    const position = g.attributes.position;
    if (!position || !position.array || position.isInterleavedBufferAttribute || position.itemSize !== 3) return best;
    const v = position.array, index = g.index ? g.index.array : null, count = index ? index.length : position.count;
    const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z, dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;
    for (let i = 0; i + 2 < count; i += 3) {
      if ((i & (CLOCK_EVERY - 1)) === 0 && i > 0 && realNow() > deadline) return best;
      const a = (index ? index[i] : i) * 3, b = (index ? index[i + 1] : i + 1) * 3, c = (index ? index[i + 2] : i + 2) * 3;
      const ax = v[a], ay = v[a + 1], az = v[a + 2];
      const e1x = v[b] - ax, e1y = v[b + 1] - ay, e1z = v[b + 2] - az, e2x = v[c] - ax, e2y = v[c + 1] - ay, e2z = v[c + 2] - az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det, tx = ox - ax, ty = oy - ay, tz = oz - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const s = (dx * qx + dy * qy + dz * qz) * inv;
      if (s < 0 || u + s > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 0 && t < best) best = t;
    }
    return best;
  };

  /** The nearest hit of a ray in world space. Null when none. It keeps its time limit at any size. */
  const pickRay = (w, ray) => {
    const end = realNow() + PICK_MS;
    let deadline = end;
    const inverse = new THREE.Matrix4(), instance = new THREE.Matrix4(), local = new THREE.Ray(), inner = new THREE.Ray(), at = new THREE.Vector3();
    let best = null;
    const take = (o, point, instanceId) => {
      const distance = point.distanceTo(ray.origin);
      if (!best || distance < best.distance) best = { object: o, point: point.clone(), distance, instanceId };
    };
    const tolerance = (PICK_TOLERANCE / w.h) * 2 * Math.tan(THREE.MathUtils.degToRad(w.camera.fov || 24) / 2);
    const visit = (o) => {
      const g = o.geometry;
      if (g && g.attributes && g.attributes.position) {
        inverse.copy(o.matrixWorld).invert();
        local.copy(ray).applyMatrix4(inverse);
        local.direction.normalize();
        if (o.isInstancedMesh) visitInstances(o, g);
        else if (o.isPoints) visitPoints(o, g);
        else if (o.isMesh) {
          if (!g.boundingSphere) g.computeBoundingSphere();
          const t = local.intersectsSphere(g.boundingSphere) || g.attributes.position.version ? hitTriangles(g, local, Infinity, deadline) : Infinity;
          if (t < Infinity) take(o, at.copy(local.direction).multiplyScalar(t).add(local.origin).applyMatrix4(o.matrixWorld), undefined);
        } else {
          const lines = new THREE.Raycaster(ray.origin, ray.direction);
          lines.params.Line.threshold = tolerance * Math.max(1, ray.origin.length());
          const found = [];
          o.raycast(lines, found);
          if (found.length) take(o, found[0].point, undefined);
        }
      } else if (o.isSprite) {
        const lines = new THREE.Raycaster(ray.origin, ray.direction);
        lines.camera = w.camera;
        const found = [];
        o.raycast(lines, found);
        if (found.length) take(o, found[0].point, undefined);
      }
    };
    const visitInstances = (o, g) => {
      if (!g.boundingSphere) g.computeBoundingSphere();
      const m = o.instanceMatrix.array, n = o.count, gs = g.boundingSphere, reach = gs.radius + gs.center.length();
      const ox = local.origin.x, oy = local.origin.y, oz = local.origin.z, dx = local.direction.x, dy = local.direction.y, dz = local.direction.z;
      const near = [];
      for (let i = 0, k = 0; i < n; i++, k += 16) {
        if ((i & 65535) === 65535 && realNow() > deadline) break;
        const cx = m[k + 12] - ox, cy = m[k + 13] - oy, cz = m[k + 14] - oz, along = cx * dx + cy * dy + cz * dz;
        const off = cx * cx + cy * cy + cz * cz - along * along, scale = m[k] * m[k] + m[k + 1] * m[k + 1] + m[k + 2] * m[k + 2], r2 = reach * reach * scale;
        if (off <= r2 && along + Math.sqrt(r2) >= 0) near.push(along, i);
      }
      const order = [];
      for (let i = 0; i < near.length; i += 2) order.push(i);
      order.sort((a, b) => near[a] - near[b]);
      const count = Math.min(PICK_CANDIDATES, order.length);
      // The nearest candidates get their own time, so a scan that used up the limit still gives a hit.
      const exact = realNow() + PICK_MS / 2;
      for (let i = 0; i < count && realNow() < exact; i++) {
        const id = near[order[i] + 1];
        instance.fromArray(m, id * 16);
        inner.copy(local).applyMatrix4(instance.clone().invert());
        const length = inner.direction.length();
        inner.direction.divideScalar(length);
        const t = hitTriangles(g, inner, Infinity, exact);
        if (t < Infinity) {
          take(o, at.copy(inner.direction).multiplyScalar(t).add(inner.origin).applyMatrix4(instance).applyMatrix4(o.matrixWorld), id);
          return;
        }
      }
    };
    const visitPoints = (o, g) => {
      const position = g.attributes.position;
      if (!position.array || position.isInterleavedBufferAttribute) return;
      const v = position.array, stride = position.itemSize, n = position.count;
      const ox = local.origin.x, oy = local.origin.y, oz = local.origin.z, dx = local.direction.x, dy = local.direction.y, dz = local.direction.z;
      let id = -1, near = Infinity;
      const t2 = tolerance * tolerance;
      for (let i = 0, k = 0; i < n; i++, k += stride) {
        if ((i & 65535) === 65535 && realNow() > deadline) break;
        const cx = v[k] - ox, cy = v[k + 1] - oy, cz = v[k + 2] - oz, along = cx * dx + cy * dy + cz * dz;
        if (along > 0 && along < near && cx * cx + cy * cy + cz * cz - along * along <= along * along * t2) { near = along; id = i; }
      }
      if (id >= 0) { take(o, at.fromBufferAttribute(position, id).applyMatrix4(o.matrixWorld), id); best.pointIndex = id; }
    };
    w.scene.updateMatrixWorld();
    // Small objects first, and each one gets its share of the time left, so one huge object cannot hide the others.
    const targets = [];
    const collect = (o) => {
      if (!o.visible || o === w.stage) return;
      if ((o.geometry && o.geometry.attributes && o.geometry.attributes.position) || o.isSprite) targets.push(o);
      for (const child of o.children) collect(child);
    };
    for (const child of w.scene.children) collect(child);
    const size = (o) => (o.isInstancedMesh ? o.count * 16 : o.geometry ? o.geometry.attributes.position.count : 0);
    targets.sort((a, b) => size(a) - size(b));
    targets.forEach((o, i) => {
      deadline = realNow() + Math.max(0, end - realNow()) / (targets.length - i);
      visit(o);
    });
    if (!best) return null;
    // The nearest published ancestor names the part.
    for (let o = best.object; o && !best.partName; o = o.parent) for (const [name, part] of w.parts) if (part.target === o) { best.partName = name; best.partObject = o; break; }
    const space = best.partObject || best.object;
    return { part: best.partName || null, point: best.point, local: space.worldToLocal(best.point.clone()), object: best.object, distance: best.distance, instanceId: best.instanceId };
  };
  const pickAt = (w, x, y) => pickRay(w, rayAt(w, x, y));
  const pickedOf = (hit) => (hit ? { part: hit.part, local: hit.local.toArray(), point: hit.point.toArray() } : null);

  const floorPlane = (w) => new THREE.Plane(new THREE.Vector3(0, 1, 0), -w.floorY);
  /** A board point on a plane, the floor by default. Null when the ray leaves the plane. */
  const toWorld = (w, x, y, plane) => rayAt(w, x, y).intersectPlane(plane || floorPlane(w), new THREE.Vector3());
  /** A world point on the board: x, y, and visible false behind the camera. */
  const toBoard = (w, point) => {
    nominalCamera(w);
    const c = w.camera, v = point.clone().applyMatrix4(c.matrixWorldInverse), front = !c.isPerspectiveCamera || v.z < -c.near;
    v.applyMatrix4(c.projectionMatrix);
    const at = boardOf(w, (v.x * w.w) / 2, (-v.y * w.h) / 2);
    return { x: at[0], y: at[1], visible: front };
  };

  /** Pin normal: of the surface nearest to the pin, once, in the part's space. A pin with no surface near points out from the part's origin. */
  const pinNormal = (pin, part) => {
    if (pin.normal) return pin.normal;
    const inverse = part.matrixWorld.clone().invert(), m = new THREE.Matrix4(), tri = new THREE.Triangle(), near = new THREE.Vector3();
    let best = Infinity;
    const normal = new THREE.Vector3();
    part.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.geometry.attributes.position) return;
      m.multiplyMatrices(inverse, o.matrixWorld);
      const position = o.geometry.attributes.position, index = o.geometry.index, count = index ? index.count : position.count;
      const step = Math.max(1, Math.floor(count / 3 / 200000)) * 3;
      for (let i = 0; i + 2 < count; i += step) {
        tri.a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(m);
        tri.b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(m);
        tri.c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(m);
        const d = tri.closestPointToPoint(pin.local, near).distanceToSquared(pin.local);
        if (d < best) { best = d; tri.getNormal(normal); }
      }
    });
    if (best === Infinity) normal.copy(pin.local).normalize();
    pin.normal = normal;
    return normal;
  };

  /** The world's strokes so far. A point of stroke.world lies on the floor plane. */
  const addStroke = (w, stroke) => {
    const made = { id: stroke.id, points: stroke.points, world: [] };
    for (const p of stroke.points) { const at = toWorld(w, p[0], p[1]); if (at) made.world.push(at); }
    const old = w.strokes.findIndex((s) => s.id === stroke.id);
    if (old >= 0) w.strokes[old] = made; else w.strokes.push(made);
    emit(w, 'ink', { stroke: made, id: made.id, points: made.points, world: made.world });
    w.stale = true;
  };
  const dropStroke = (w, id) => {
    const old = w.strokes.findIndex((s) => s.id === id);
    if (old < 0) return;
    w.strokes.splice(old, 1);
    emit(w, 'inkgone', { id });
    w.stale = true;
  };

  /** Page kinds to world events. */
  const POINTER_TYPES = { down: 'pointerdown', move: 'pointermove', up: 'pointerup', cancel: 'pointercancel', wheel: 'wheel', enter: 'pointerenter', leave: 'pointerleave' };
  const POINTER_LISTENERS = Object.values(POINTER_TYPES);
  /** An event of the hand. Ray, hit and ground are computed when the code reads them. */
  const pointerEvent = (w, m) => {
    const type = POINTER_TYPES[m.kind];
    const list = type && w.events.get(type);
    if (!list || !list.size) return;
    const e = Object.assign({}, m, { type });
    delete e.kind;
    const lazy = (name, make) => {
      let value, made = false;
      Object.defineProperty(e, name, { enumerable: true, get() { if (!made) { made = true; value = make(); } return value; } });
    };
    lazy('ray', () => rayAt(w, m.x, m.y).clone());
    lazy('hit', () => pickAt(w, m.x, m.y));
    lazy('ground', () => toWorld(w, m.x, m.y));
    for (const fn of [...list]) inside(w, () => { try { fn(e); } catch (x) { fail(w, x); } });
    w.stale = true;
  };
  /** Tell the page which input the world wants. Only changes go out. */
  const subscribe = (w) => {
    let pointer = false;
    for (const type of POINTER_LISTENERS) { const list = w.events.get(type); if (list && list.size) pointer = true; }
    const inkList = w.events.get('ink'), ink = !!(inkList && inkList.size);
    if (pointer === w.wants.pointer && ink === w.wants.ink) return;
    w.wants = { pointer, ink };
    post({ type: 'subscribe', key: w.key, pointer, ink });
  };
  /** Move the whole world: its anchor to a board point. It shows in the next picture, and the page hears of it. */
  const moveAnchor = (w, x, y) => {
    const moved = w.moved, a = anchorOf(w), dx = x - (a.x - moved.x), dy = y - (a.y - moved.y);
    if (dx === moved.x && dy === moved.y) return;
    w.moved = { x: dx, y: dy };
    surface.dirty = true;
    post({ type: 'anchor', key: w.key, dx, dy });
    schedule();
  };
`
