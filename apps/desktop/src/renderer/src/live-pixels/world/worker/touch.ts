/**
 * Touch: the hand reaches into a world (architecture section 5). A board point
 * becomes a ray, a ray becomes a hit with a part name, a pin stays on a part as
 * it turns, ink arrives as strokes.
 *
 * Pick has a time limit. three-mesh-bvh is not a dependency of the app and its
 * build needs a bare `three`, so a pick walks typed arrays with plain loops:
 * about 10 ms for a million instances. It tests what is drawn: the draw range, the
 * groups, the side of a material, morphed and skinned vertices. Objects come nearest
 * first, and a hit ends the walk when nothing can be nearer. At the limit it stops
 * and gives the best hit so far. An event computes e.hit only when the code reads
 * it, so a world that only follows the pointer pays nothing.
 */
export const TOUCH = String.raw`
  /** A pick stops after this time. */
  const PICK_MS = 10;
  /**
   * The nearest objects, and the nearest instances of a round, that a pick tests at any cost. The clock must stop a huge world and not the
   * first touch, when this code still runs cold and a small world can use up the limit.
   */
  const PICK_ALWAYS = 8;
  /** Instances that one round of a pick tests triangle by triangle, nearest first. */
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

  /** The positions of a geometry as tight x, y, z numbers. */
  const flatPositions = (g, s) => {
    const p = g.attributes.position, plain = p.itemSize === 3 ? plainArray(p) : null;
    if (plain) return plain;
    if (s.flat) return s.flat;
    const out = (s.flat = new Float32Array(p.count * 3));
    for (let i = 0; i < p.count; i++) { out[i * 3] = p.getX(i); out[i * 3 + 1] = p.getY(i); out[i * 3 + 2] = p.itemSize > 2 ? p.getZ(i) : 0; }
    return out;
  };

  const shaped = new WeakMap();
  /** Where the vertices of a morphed or skinned mesh are drawn now, in the mesh's own space. Null when the clock runs out first. */
  const drawnPositions = (o, g, s, deadline, influences = o.morphTargetInfluences) => {
    const base = flatPositions(g, s), n = base.length / 3;
    let out = shaped.get(o);
    if (!out || out.length !== base.length) shaped.set(o, (out = new Float32Array(base.length)));
    const morphs = g.morphAttributes.position;
    let keep = 1;
    if (morphs && influences && !g.morphTargetsRelative) for (let t = 0; t < morphs.length; t++) keep -= influences[t] || 0;
    for (let i = 0; i < base.length; i++) out[i] = base[i] * keep;
    if (morphs && influences) {
      for (let t = 0; t < morphs.length; t++) {
        const v = influences[t], a = morphs[t];
        if (!v) continue;
        if (n > 4095 && realNow() > deadline) return null;
        const flat = a.itemSize === 3 ? plainArray(a) : null;
        for (let i = 0, k = 0; i < n; i++, k += 3) {
          out[k] += v * (flat ? flat[k] : a.getX(i)); out[k + 1] += v * (flat ? flat[k + 1] : a.getY(i)); out[k + 2] += v * (flat ? flat[k + 2] : a.getZ(i));
        }
      }
    }
    const index = g.attributes.skinIndex, weight = g.attributes.skinWeight;
    if (!o.isSkinnedMesh || !index || !weight) return out;
    o.skeleton.update();
    const bones = o.skeleton.boneMatrices, b = o.bindMatrix.elements, c = o.bindMatrixInverse.elements;
    const flatIndex = plainArray(index), flatWeight = plainArray(weight);
    for (let i = 0, k = 0; i < n; i++, k += 3) {
      if ((i & 4095) === 4095 && realNow() > deadline) return null;
      const x = out[k], y = out[k + 1], z = out[k + 2];
      const px = b[0] * x + b[4] * y + b[8] * z + b[12], py = b[1] * x + b[5] * y + b[9] * z + b[13], pz = b[2] * x + b[6] * y + b[10] * z + b[14];
      let sx = 0, sy = 0, sz = 0;
      for (let j = 0; j < 4; j++) {
        const u = flatWeight ? flatWeight[i * 4 + j] : weight.getComponent(i, j);
        if (!u) continue;
        const m = (flatIndex ? flatIndex[i * 4 + j] : index.getComponent(i, j)) * 16;
        sx += u * (bones[m] * px + bones[m + 4] * py + bones[m + 8] * pz + bones[m + 12]);
        sy += u * (bones[m + 1] * px + bones[m + 5] * py + bones[m + 9] * pz + bones[m + 13]);
        sz += u * (bones[m + 2] * px + bones[m + 6] * py + bones[m + 10] * pz + bones[m + 14]);
      }
      out[k] = c[0] * sx + c[4] * sy + c[8] * sz + c[12]; out[k + 1] = c[1] * sx + c[5] * sy + c[9] * sz + c[13]; out[k + 2] = c[2] * sx + c[6] * sy + c[10] * sz + c[14];
    }
    return out;
  };

  /** Triangles from..to of an index or of positions v against a local ray. side: 1 front faces, -1 back faces, 0 both. The t of the nearest hit below 'best', or best. */
  const hitRange = (v, index, from, to, ray, best, deadline, side) => {
    const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z, dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;
    for (let i = from - from % 3; i + 2 < to; i += 3) {
      if ((i & (CLOCK_EVERY - 1)) === 0 && realNow() > deadline) return best;
      const a = (index ? index[i] : i) * 3, b = (index ? index[i + 1] : i + 1) * 3, c = (index ? index[i + 2] : i + 2) * 3;
      const ax = v[a], ay = v[a + 1], az = v[a + 2];
      const e1x = v[b] - ax, e1y = v[b + 1] - ay, e1z = v[b + 2] - az, e2x = v[c] - ax, e2y = v[c + 1] - ay, e2z = v[c + 2] - az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if ((det > -1e-12 && det < 1e-12) || det * side < 0) continue;
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
  /**
   * Which faces of a triangle, as they lie in its own space, a material draws. A ray in that space keeps which side it comes from under any matrix, and for
   * a mirrored mesh three turns the winding back, so nothing changes. It does not do that for a mirrored instance: flip says so, and the back of the triangle shows.
   */
  const sideOf = (m, flip) => (m.side === THREE.DoubleSide ? 0 : (m.side === THREE.FrontSide) !== flip ? 1 : -1);
  /** What a mesh draws against a local ray: its draw range, and with several materials its groups. */
  const hitMesh = (o, g, v, ray, best, deadline, flip) => {
    const index = g.index ? g.index.array : null, count = index ? index.length : v.length / 3, range = g.drawRange, material = o.material;
    const from = Math.max(0, range.start), to = Math.min(count, range.start + range.count);
    if (!Array.isArray(material)) return material.visible === false ? best : hitRange(v, index, from, to, ray, best, deadline, sideOf(material, flip));
    for (const group of g.groups) {
      const m = material[group.materialIndex];
      if (m && m.visible !== false) best = hitRange(v, index, Math.max(group.start, from), Math.min(group.start + group.count, to), ray, best, deadline, sideOf(m, flip));
    }
    return best;
  };

  /** The nearest hit of a ray in world space. Null when none. It keeps its time limit at any size. */
  const pickRay = (w, ray) => {
    const end = realNow() + PICK_MS;
    let deadline = end;
    const inverse = new THREE.Matrix4(), instance = new THREE.Matrix4(), toInstance = new THREE.Matrix4(), local = new THREE.Ray(), inner = new THREE.Ray(), at = new THREE.Vector3();
    let best = null;
    const take = (o, point, instanceId) => {
      const distance = point.distanceTo(ray.origin);
      if (!best || distance < best.distance) best = { object: o, point: point.clone(), distance, instanceId };
    };
    const tolerance = (PICK_TOLERANCE / w.h) * 2 * Math.tan(THREE.MathUtils.degToRad(w.camera.fov || 24) / 2);
    const lineRoom = tolerance * Math.max(1, ray.origin.length());
    /** Lines, sprites, batches, fat lines and text: their own raycast. */
    const viaThree = (o) => {
      const caster = new THREE.Raycaster(ray.origin, ray.direction), found = [];
      caster.camera = w.camera;
      caster.params.Line.threshold = lineRoom;
      o.raycast(caster, found);
      let near = null;
      for (const hit of found) if (!near || hit.distance < near.distance) near = hit;
      if (near) take(o, near.point, near.instanceId);
    };
    const visit = (o) => {
      const g = o.geometry;
      if (o.isSprite || o.isBatchedMesh || o.isLine || (g && g.isInstancedBufferGeometry && !o.isInstancedMesh)) { viaThree(o); return; }
      inverse.copy(o.matrixWorld).invert();
      local.copy(ray).applyMatrix4(inverse);
      local.direction.normalize();
      const s = shapeOf(g);
      if (o.isInstancedMesh) visitInstances(o, g, s);
      else if (o.isPoints) visitPoints(o, g);
      else if (o.isMesh) {
        const deformed = o.isSkinnedMesh || (o.morphTargetInfluences && g.morphAttributes.position);
        const v = (deformed && drawnPositions(o, g, s, deadline)) || flatPositions(g, s);
        const t = hitMesh(o, g, v, local, Infinity, deadline, false);
        if (t < Infinity) take(o, at.copy(local.direction).multiplyScalar(t).add(local.origin).applyMatrix4(o.matrixWorld), undefined);
      }
    };
    /**
     * Instances in rounds. A scan keeps the PICK_CANDIDATES that the ray enters first, a sorted short list and no sort of all, and those are
     * tested by their triangles. A next round is needed only when a kept hit lies past the last place tested.
     */
    const visitInstances = (o, g, s) => {
      const m = o.instanceMatrix.array, n = o.count, material = o.material, v = flatPositions(g, s), mine = Math.max(deadline, realNow() + PICK_MS);
      const sx = s.x, sy = s.y, sz = s.z, r = s.radius + instanceSlack(o, s);
      // An instance with its own morph draws its own positions.
      const morph = o.morphTexture && g.morphAttributes.position ? { morphTargetInfluences: new Array(o.morphTexture.image.width - 1).fill(0) } : null;
      const ox = local.origin.x, oy = local.origin.y, oz = local.origin.z, dx = local.direction.x, dy = local.direction.y, dz = local.direction.z;
      const enters = new Float64Array(PICK_CANDIDATES), ids = new Int32Array(PICK_CANDIDATES);
      let after = -Infinity, near = Infinity, hit = -1;
      const point = new THREE.Vector3();
      for (;;) {
        let kept = 0, more = false;
        for (let i = 0, k = 0; i < n; i++, k += 16) {
          if ((i & 65535) === 65535 && realNow() > mine) break;
          const cx = m[k] * sx + m[k + 4] * sy + m[k + 8] * sz + m[k + 12] - ox, cy = m[k + 1] * sx + m[k + 5] * sy + m[k + 9] * sz + m[k + 13] - oy, cz = m[k + 2] * sx + m[k + 6] * sy + m[k + 10] * sz + m[k + 14] - oz;
          const r2 = r * r * stretchOf(m, k);
          if (r2 === 0) continue;
          const along = cx * dx + cy * dy + cz * dz, off = cx * cx + cy * cy + cz * cz - along * along;
          if (off > r2) continue;
          const reach = Math.sqrt(r2 - off), enter = along - reach;
          if (along + reach < 0 || enter <= after || enter >= near) continue;
          if (kept === PICK_CANDIDATES && enter >= enters[kept - 1]) { more = true; continue; }
          if (kept === PICK_CANDIDATES) { more = true; kept--; }
          let place = kept++;
          for (; place > 0 && enters[place - 1] > enter; place--) { enters[place] = enters[place - 1]; ids[place] = ids[place - 1]; }
          enters[place] = enter; ids[place] = i;
        }
        for (let i = 0; i < kept && enters[i] < near && (i < PICK_ALWAYS || realNow() < mine); i++) {
          instance.fromArray(m, ids[i] * 16);
          toInstance.copy(instance).invert();
          inner.copy(local).applyMatrix4(toInstance);
          inner.direction.normalize();
          if (morph) o.getMorphAt(ids[i], morph);
          const drawn = (morph && drawnPositions(o, g, s, mine, morph.morphTargetInfluences)) || v;
          const t = hitMesh(o, g, drawn, inner, Infinity, mine, instance.determinant() < 0);
          if (t === Infinity) continue;
          at.copy(inner.direction).multiplyScalar(t).add(inner.origin).applyMatrix4(instance);
          const along = at.clone().sub(local.origin).dot(local.direction);
          if (along < near) { near = along; hit = ids[i]; point.copy(at); }
        }
        if (!more || !kept || realNow() >= mine || (hit >= 0 && near <= enters[kept - 1])) break;
        after = enters[kept - 1];
      }
      if (hit >= 0) take(o, point.applyMatrix4(o.matrixWorld), hit);
    };
    const visitPoints = (o, g) => {
      const position = g.attributes.position, s = shapeOf(g), v = flatPositions(g, s), range = g.drawRange;
      const ox = local.origin.x, oy = local.origin.y, oz = local.origin.z, dx = local.direction.x, dy = local.direction.y, dz = local.direction.z;
      let id = -1, near = Infinity;
      const t2 = tolerance * tolerance, to = Math.min(position.count, range.start + range.count);
      for (let i = Math.max(0, range.start); i < to; i++) {
        if ((i & 65535) === 65535 && realNow() > deadline) break;
        const k = i * 3, cx = v[k] - ox, cy = v[k + 1] - oy, cz = v[k + 2] - oz, along = cx * dx + cy * dy + cz * dz;
        if (along > 0 && along < near && cx * cx + cy * cy + cz * cz - along * along <= along * along * t2) { near = along; id = i; }
      }
      if (id >= 0) take(o, at.set(v[id * 3], v[id * 3 + 1], v[id * 3 + 2]).applyMatrix4(o.matrixWorld), id);
    };
    /** Where the ray enters what o can draw, or -1 when it passes by. 0: only o's own test can say. */
    const center = new THREE.Vector3();
    const enterOf = (o) => {
      const g = o.geometry;
      if (o.isSprite || o.isBatchedMesh || o.isSkinnedMesh || (g.isInstancedBufferGeometry && !o.isInstancedMesh) || (o.morphTargetInfluences && g.morphAttributes.position)) return 0;
      const s = shapeOf(g);
      if (s.empty) return -1;
      if (o.isInstancedMesh) instanceBox(o, s);
      const sphere = o.isInstancedMesh ? o.boundingSphere : null;
      if (o.isInstancedMesh && !sphere) return -1;
      if (sphere) center.copy(sphere.center); else center.set(s.x, s.y, s.z);
      center.applyMatrix4(o.matrixWorld).sub(ray.origin);
      const r = (sphere ? sphere.radius : s.radius) * Math.sqrt(stretchOf(o.matrixWorld.elements, 0)) + (o.isMesh ? 0 : lineRoom * (1 + center.length()));
      const along = center.dot(ray.direction), off = center.lengthSq() - along * along;
      if (off > r * r) return -1;
      const reach = Math.sqrt(r * r - off);
      return along + reach < 0 ? -1 : Math.max(0, along - reach);
    };
    w.scene.updateMatrixWorld();
    // Nearest first, so a hit can end the walk. Each object gets its share of the time left, so one huge object cannot hide the others.
    const targets = [];
    const collect = (o) => {
      if (!o.visible || o === w.stage) return;
      if (o.layers.test(w.camera.layers) && ((o.geometry && o.geometry.attributes && o.geometry.attributes.position) || o.isSprite)) {
        const enter = enterOf(o);
        if (enter >= 0) targets.push({ o, enter });
      }
      for (const child of o.children) collect(child);
    };
    for (const child of w.scene.children) collect(child);
    targets.sort((a, b) => a.enter - b.enter);
    for (let i = 0; i < targets.length; i++) {
      if (best && targets[i].enter >= best.distance) break;
      const now = realNow();
      if (i >= PICK_ALWAYS && now > end) break;
      deadline = now + Math.max(0, end - now) / (targets.length - i);
      visit(targets[i].o);
    }
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
    const wheelList = w.events.get('wheel'), wheel = !!(wheelList && wheelList.size);
    const inkList = w.events.get('ink'), ink = !!(inkList && inkList.size);
    if (pointer === w.wants.pointer && wheel === w.wants.wheel && ink === w.wants.ink) return;
    w.wants = { pointer, wheel, ink };
    post({ type: 'subscribe', key: w.key, pointer, wheel, ink });
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
