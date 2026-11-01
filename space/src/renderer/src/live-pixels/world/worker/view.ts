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
  /** Steps of a crop and of a render target, in pixels. Bloom levels to 1/64 stay fixed on the world too. */
  const GRID = 64;
  /** Room for glow in board points. */
  const GLOW_ROOM = 224;
  /** Room for anything else, in pixels: a soft edge, a thin line on the bounds. */
  const SOFT_ROOM = 32;
  /** Measures of a world between two samples of its stage. */
  const SAMPLE_EVERY = 6;
  /** The share of the distance that reach shrinks per measure. It grows at once. */
  const SHRINK = 0.01;

  /** Points per object in a sample. */
  const PROBES = 256;
  const reachVector = () => reachVector.v || (reachVector.v = new THREE.Vector3());

  /**
   * A sample of what the world draws now, in world space, for the floor and the focus. It can miss a point, so reach does not use it: a
   * floor that stands a little high costs nothing, and a crop that cuts a part is a fault.
   */
  const sampleStage = (w) => {
    const box = w.bounds.makeEmpty(), m = new THREE.Matrix4(), v = reachVector();
    const visit = (o) => {
      if (!o.visible || o === w.stage) return;
      const g = o.geometry, position = g && g.attributes && g.attributes.position;
      if (position && o.isInstancedMesh) {
        if (!g.boundingBox) g.computeBoundingBox();
        const b = g.boundingBox, step = Math.max(1, Math.floor(o.count / (PROBES / 8)));
        for (let i = 0; i < o.count; i += step) {
          o.getMatrixAt(i, m);
          m.premultiply(o.matrixWorld);
          for (let c = 0; c < 8; c++) box.expandByPoint(v.set(c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z).applyMatrix4(m));
        }
      } else if (position) {
        const step = Math.max(1, Math.floor(position.count / PROBES));
        for (let i = 0; i < position.count; i += step) box.expandByPoint(v.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld));
      } else if (o.isSprite) box.expandByPoint(v.setFromMatrixPosition(o.matrixWorld));
      for (const child of o.children) visit(child);
    };
    for (const child of w.scene.children) if (child !== w.camera) visit(child);
    if (box.isEmpty()) return;
    if (floorOn(w)) fitFloor(w, box); else if (!w.floorBuilt) placeFloorPlane(w, box);
  };

  // Bounds. Each drawn object gives a box that holds all it can draw, under the matrices of this moment, so reach never cuts it. A geometry
  // keeps what is costly to find, and only a new attribute or version finds it again. So a measure costs one small sum per object.
  const versionOf = (a) => (a.isInterleavedBufferAttribute ? a.data.version : a.version);
  /** The array of an attribute when its numbers are the values, or null: an interleaved, normalized or half-float attribute needs its own getX. */
  const plainArray = (a) => (!a.isInterleavedBufferAttribute && !a.normalized && a.getX === THREE.BufferAttribute.prototype.getX ? a.array : null);
  const attributeIds = new WeakMap();
  let lastAttributeId = 0;
  /** A number of its own for each attribute: a new attribute can have the version of the old one. */
  const attributeId = (a) => {
    let id = attributeIds.get(a);
    if (!id) attributeIds.set(a, (id = ++lastAttributeId));
    return id;
  };

  /** out: the smallest and largest x, y, z of an attribute. */
  const measureAttribute = (a, out) => {
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
    const flat = plainArray(a), size = a.itemSize, deep = size > 2;
    for (let i = 0, k = 0; i < a.count; i++, k += size) {
      const x = flat ? flat[k] : a.getX(i), y = flat ? flat[k + 1] : a.getY(i), z = !deep ? 0 : flat ? flat[k + 2] : a.getZ(i);
      if (x < lx) lx = x;
      if (x > hx) hx = x;
      if (y < ly) ly = y;
      if (y > hy) hy = y;
      if (z < lz) lz = z;
      if (z > hz) hz = z;
    }
    out[0] = lx; out[1] = ly; out[2] = lz; out[3] = hx; out[4] = hy; out[5] = hz;
  };

  const shapes = new WeakMap();
  /** What a geometry holds, for the version of its positions that three draws: box, centre, radius. */
  const shapeOf = (g) => {
    let s = shapes.get(g);
    if (!s) shapes.set(g, (s = { position: null, version: -1, stamp: 0, box: new Float64Array(6), x: 0, y: 0, z: 0, radius: 0, empty: true, deltas: null, skin: null, flat: null }));
    const p = g.attributes.position, version = versionOf(p);
    if (s.position === p && s.version === version) return s;
    const changed = !!s.position, b = s.box;
    s.position = p; s.version = version; s.stamp++; s.deltas = null; s.skin = null; s.flat = null;
    measureAttribute(p, b);
    s.empty = !(b[3] >= b[0]);
    if (s.empty) return s;
    const x = (s.x = (b[0] + b[3]) / 2), y = (s.y = (b[1] + b[4]) / 2), z = (s.z = (b[2] + b[5]) / 2);
    let far = 0;
    for (let i = 0; i < p.count; i++) {
      const dx = p.getX(i) - x, dy = p.getY(i) - y, dz = p.itemSize > 2 ? p.getZ(i) - z : -z, d = dx * dx + dy * dy + dz * dz;
      if (d > far) far = d;
    }
    s.radius = Math.sqrt(far);
    // three keeps the sphere of its first look for its culling, and a crop then takes away a part that moved its vertices.
    if (changed && g.boundingSphere) { g.boundingSphere.center.set(x, y, z); g.boundingSphere.radius = s.radius; }
    return s;
  };

  /** Per morph target, the box of how far a vertex can move from its base. */
  const deltasOf = (g, s) => {
    const list = g.morphAttributes.position;
    if (!list || !list.length) return null;
    let d = s.deltas;
    if (d && d.list.length === list.length && d.list.every((a, i) => a === list[i] && d.versions[i] === versionOf(a)) && d.relative === g.morphTargetsRelative) return d;
    d = s.deltas = { list: [...list], versions: list.map(versionOf), relative: g.morphTargetsRelative, boxes: new Float64Array(list.length * 6) };
    const base = g.attributes.position, out = new Float64Array(6);
    list.forEach((a, t) => {
      if (g.morphTargetsRelative) measureAttribute(a, out);
      else {
        out[0] = out[1] = out[2] = Infinity; out[3] = out[4] = out[5] = -Infinity;
        for (let i = 0; i < a.count; i++) {
          const x = a.getX(i) - base.getX(i), y = a.getY(i) - base.getY(i), z = a.getZ(i) - base.getZ(i);
          out[0] = Math.min(out[0], x); out[1] = Math.min(out[1], y); out[2] = Math.min(out[2], z);
          out[3] = Math.max(out[3], x); out[4] = Math.max(out[4], y); out[5] = Math.max(out[5], z);
        }
      }
      d.boxes.set(out, t * 6);
    });
    return d;
  };

  /** Per bone, the box of the vertices that it moves. A skinned vertex is a mean of what its bones do with it, so these boxes under their bones hold it. */
  const skinOf = (g, s) => {
    const index = g.attributes.skinIndex, weight = g.attributes.skinWeight;
    if (!index || !weight) return null;
    let k = s.skin;
    if (k && k.index === index && k.weight === weight && k.iv === versionOf(index) && k.wv === versionOf(weight)) return k;
    const p = g.attributes.position;
    let top = 0;
    for (let i = 0; i < index.count; i++) for (let j = 0; j < 4; j++) top = Math.max(top, index.getComponent(i, j));
    const boxes = new Float64Array((top + 1) * 6);
    for (let b = 0; b <= top; b++) boxes.fill(Infinity, b * 6, b * 6 + 3), boxes.fill(-Infinity, b * 6 + 3, b * 6 + 6);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      for (let j = 0; j < 4; j++) {
        if (!(weight.getComponent(i, j) > 0)) continue;
        const at = index.getComponent(i, j) * 6;
        if (x < boxes[at]) boxes[at] = x;
        if (y < boxes[at + 1]) boxes[at + 1] = y;
        if (z < boxes[at + 2]) boxes[at + 2] = z;
        if (x > boxes[at + 3]) boxes[at + 3] = x;
        if (y > boxes[at + 4]) boxes[at + 4] = y;
        if (z > boxes[at + 5]) boxes[at + 5] = z;
      }
    }
    return (s.skin = k = { index, weight, iv: versionOf(index), wv: versionOf(weight), boxes, bones: top + 1 });
  };

  /** How far the morph targets of an instance can move a vertex. */
  const instanceSlack = (o, s) => {
    const d = o.morphTexture ? deltasOf(o.geometry, s) : null;
    if (!d) return 0;
    let slack = 0;
    for (let i = 0; i < d.boxes.length; i++) slack = Math.max(slack, Math.abs(d.boxes[i]));
    return slack * d.list.length * Math.sqrt(3);
  };

  const instanceBoxes = new WeakMap();
  /** The box of all instances in the space of the mesh. Only a new instance matrix finds it again. It also serves three's culling. */
  const instanceBox = (o, s) => {
    let c = instanceBoxes.get(o);
    if (!c) instanceBoxes.set(o, (c = { matrix: null, version: -1, count: -1, shape: null, stamp: -1, box: new Float64Array(6), slack: 0 }));
    const a = o.instanceMatrix;
    const slack = instanceSlack(o, s);
    if (c.matrix === a && c.version === a.version && c.count === o.count && c.shape === s && c.stamp === s.stamp && c.slack === slack) return c.box;
    c.matrix = a; c.version = a.version; c.count = o.count; c.shape = s; c.stamp = s.stamp; c.slack = slack;
    const m = a.array, r = s.radius + slack, x = s.x, y = s.y, z = s.z;
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
    for (let i = 0, k = 0; i < o.count; i++, k += 16) {
      const px = m[k] * x + m[k + 4] * y + m[k + 8] * z + m[k + 12], py = m[k + 1] * x + m[k + 5] * y + m[k + 9] * z + m[k + 13], pz = m[k + 2] * x + m[k + 6] * y + m[k + 10] * z + m[k + 14];
      const e = r * Math.sqrt(stretchOf(m, k));
      if (px - e < lx) lx = px - e;
      if (px + e > hx) hx = px + e;
      if (py - e < ly) ly = py - e;
      if (py + e > hy) hy = py + e;
      if (pz - e < lz) lz = pz - e;
      if (pz + e > hz) hz = pz + e;
    }
    const b = c.box;
    b[0] = lx; b[1] = ly; b[2] = lz; b[3] = hx; b[4] = hy; b[5] = hz;
    if (hx >= lx) {
      if (!o.boundingSphere) o.boundingSphere = new THREE.Sphere();
      o.boundingSphere.center.set((lx + hx) / 2, (ly + hy) / 2, (lz + hz) / 2);
      o.boundingSphere.radius = Math.hypot(hx - lx, hy - ly, hz - lz) / 2;
    }
    return b;
  };

  /** The box of a geometry whose class knows where it draws (fat lines, text). Null: it draws what only its shader knows. */
  const classBox = (g, out) => {
    if (g.computeBoundingBox === THREE.BufferGeometry.prototype.computeBoundingBox) return false;
    let key = 0;
    for (const name in g.attributes) key += (attributeId(g.attributes[name]) * 65599 + versionOf(g.attributes[name])) * 31 + g.attributes[name].count;
    if (g.lsBoxKey !== key || !g.boundingBox) { g.computeBoundingBox(); g.lsBoxKey = key; }
    const b = g.boundingBox;
    out[0] = b.min.x; out[1] = b.min.y; out[2] = b.min.z; out[3] = b.max.x; out[4] = b.max.y; out[5] = b.max.z;
    return true;
  };

  /**
   * The square of an upper bound of how much the 3 x 3 part of the 16 numbers m at k stretches a length: of its largest singular value. The longest
   * column alone (getMaxScaleOnAxis) falls short under a shear. By Gershgorin's rule on the columns' dot products, each column adds what it shares with
   * the others. Columns at right angles, as a rotation and a scale give, share nothing, and the bound is exact.
   */
  const stretchOf = (m, k) => {
    const ax = m[k], ay = m[k + 1], az = m[k + 2], bx = m[k + 4], by = m[k + 5], bz = m[k + 6], cx = m[k + 8], cy = m[k + 9], cz = m[k + 10];
    const ab = Math.abs(ax * bx + ay * by + az * bz), ac = Math.abs(ax * cx + ay * cy + az * cz), bc = Math.abs(bx * cx + by * cy + bz * cz);
    const x = ax * ax + ay * ay + az * az + ab + ac, y = bx * bx + by * by + bz * bz + ab + bc, z = cx * cx + cy * cy + cz * cz + ac + bc;
    return x > y ? (x > z ? x : z) : y > z ? y : z;
  };

  // One measure runs at a time: its state stays here, so a measure allocates nothing.
  let tools = null, P = null, near = 0, perspective = false, simple = false, halfW = 0, halfH = 0, onFloor = false;
  // The bounds of the world, of the object now, its points in front of the camera and behind it.
  let wl = 0, wt = 0, wr = 0, wb = 0, ol = 0, ot = 0, or = 0, ob = 0, front = 0, behind = 0, open = false, room2 = 0;

  /** A point in the camera's space. */
  const point = (x, y, z) => {
    const cw = P[3] * x + P[7] * y + P[11] * z + P[15];
    if (cw <= 1e-9 || (perspective && z > -near)) { behind++; return; }
    front++;
    const px = ((P[0] * x + P[4] * y + P[8] * z + P[12]) / cw) * halfW, py = (-(P[1] * x + P[5] * y + P[9] * z + P[13]) / cw) * halfH;
    if (px < ol) ol = px;
    if (px > or) or = px;
    if (py < ot) ot = py;
    if (py > ob) ob = py;
  };
  /** A point in world space. */
  const worldPoint = (x, y, z) => {
    const e = tools.view.elements;
    point(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
  };
  const startObject = () => { ol = ot = Infinity; or = ob = -Infinity; front = behind = 0; };
  /** What lies behind the camera does not draw. What crosses its near plane can reach any place. */
  const endObject = () => {
    if (behind && front) open = true;
    if (!front) return;
    if (ol < wl) wl = ol;
    if (or > wr) wr = or;
    if (ot < wt) wt = ot;
    if (ob > wb) wb = ob;
  };
  /** The eight corners of box b under a matrix to the camera's space. */
  const corners = (e, b) => {
    const dx = b[3] - b[0], dy = b[4] - b[1], dz = b[5] - b[2];
    const x = e[0] * b[0] + e[4] * b[1] + e[8] * b[2] + e[12], y = e[1] * b[0] + e[5] * b[1] + e[9] * b[2] + e[13], z = e[2] * b[0] + e[6] * b[1] + e[10] * b[2] + e[14];
    const ax = e[0] * dx, ay = e[1] * dx, az = e[2] * dx, bx = e[4] * dy, by = e[5] * dy, bz = e[6] * dy, cx = e[8] * dz, cy = e[9] * dz, cz = e[10] * dz;
    for (let c = 0; c < 8; c++) point(x + (c & 1 ? ax : 0) + (c & 2 ? bx : 0) + (c & 4 ? cx : 0), y + (c & 1 ? ay : 0) + (c & 2 ? by : 0) + (c & 4 ? cy : 0), z + (c & 1 ? az : 0) + (c & 2 ? bz : 0) + (c & 4 ? cz : 0));
  };
  /** A round object: the bounds of its sphere also hold it, so the object's bounds keep only the part that both hold. */
  const tighten = (x, y, z, r) => {
    if (!simple || behind) return;
    // Depth divides in perspective: the near side of the sphere gives the widest point on the outside of the view, the far side on the inside.
    const dn = perspective ? -z - r : 1, df = perspective ? -z + r : 1, ox = perspective ? -P[8] : P[12], oy = perspective ? -P[9] : P[13];
    if (perspective && dn < near) return;
    const hx = x + r, lx = x - r, hy = y + r, ly = y - r;
    const right = (hx > 0 ? hx / dn : hx / df) * P[0] + ox, left = (lx < 0 ? lx / dn : lx / df) * P[0] + ox;
    const top = (hy > 0 ? hy / dn : hy / df) * P[5] + oy, bottom = (ly < 0 ? ly / dn : ly / df) * P[5] + oy;
    if (left * halfW > ol) ol = left * halfW;
    if (right * halfW < or) or = right * halfW;
    if (-top * halfH > ot) ot = -top * halfH;
    if (-bottom * halfH < ob) ob = -bottom * halfH;
  };
  /** The floor shows the mirror image of what stands on it and its shadow, with the blur of its height. e: to world space. */
  const onTheFloor = (w, e, b) => {
    const dx = b[3] - b[0], dy = b[4] - b[1], dz = b[5] - b[2], sx = w.lightSlope.x, sz = w.lightSlope.y, y0 = w.floorY, soft = w.look.softness * 1.5;
    for (let c = 0; c < 8; c++) {
      const lx = b[0] + (c & 1 ? dx : 0), ly = b[1] + (c & 2 ? dy : 0), lz = b[2] + (c & 4 ? dz : 0);
      const x = e[0] * lx + e[4] * ly + e[8] * lz + e[12], y = e[1] * lx + e[5] * ly + e[9] * lz + e[13], z = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
      const h = Math.max(0, y - y0), px = x - h * sx, pz = z - h * sz, blur = h * soft;
      worldPoint(x, 2 * y0 - y, z);
      worldPoint(px - blur, y0, pz - blur);
      worldPoint(px + blur, y0, pz + blur);
      worldPoint(px - blur, y0, pz + blur);
      worldPoint(px + blur, y0, pz - blur);
    }
  };
  /** A box under matrix m, to world space. r: the radius of the same thing around centre c, when it has one. */
  const placeBox = (w, m, b, r, c) => {
    const t = tools, e = t.toCamera.multiplyMatrices(t.view, m).elements;
    startObject();
    corners(e, b);
    if (r > 0) tighten(e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12], e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13], e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14], r * Math.sqrt(stretchOf(m.elements, 0)));
    if (onFloor) onTheFloor(w, m.elements, b);
    endObject();
  };
  const boundObject = (w, o) => {
    if (o.isSprite) {
      const e = o.matrixWorld.elements, sx = Math.hypot(e[0], e[1], e[2]), sy = Math.hypot(e[4], e[5], e[6]), c = o.center;
      const r = Math.hypot(sx * Math.max(c.x, 1 - c.x), sy * Math.max(c.y, 1 - c.y));
      const x = e[12], y = e[13], z = e[14], view = tools.view.elements;
      startObject();
      for (let i = 0; i < 8; i++) worldPoint(x + (i & 1 ? r : -r), y + (i & 2 ? r : -r), z + (i & 4 ? r : -r));
      tighten(view[0] * x + view[4] * y + view[8] * z + view[12], view[1] * x + view[5] * y + view[9] * z + view[13], view[2] * x + view[6] * y + view[10] * z + view[14], r);
      endObject();
      return;
    }
    const g = o.geometry, position = g && g.attributes && g.attributes.position;
    if (!position) return;
    const b = tools.box, material = Array.isArray(o.material) ? null : o.material;
    // three's culling scales a sphere by the longest column, so under a shear it can drop a part that shows.
    const longest = o.matrixWorld.getMaxScaleOnAxis();
    if (o.frustumCulled && stretchOf(o.matrixWorld.elements, 0) > longest * longest * 1.000001) o.frustumCulled = false;
    if (g.isInstancedBufferGeometry && !o.isInstancedMesh) {
      if (!classBox(g, b)) { open = true; return; }
      if (material && material.isLineMaterial) {
        const e = material.worldUnits ? material.linewidth / 2 : 0;
        for (let i = 0; i < 3; i++) { b[i] -= e; b[i + 3] += e; }
        if (!material.worldUnits) room2 = Math.max(room2, material.linewidth);
      }
      placeBox(w, o.matrixWorld, b, 0, null);
      return;
    }
    const s = shapeOf(g);
    if (s.empty) return;
    if (o.isBatchedMesh) {
      o.computeBoundingBox();
      const k = o.boundingBox;
      b[0] = k.min.x; b[1] = k.min.y; b[2] = k.min.z; b[3] = k.max.x; b[4] = k.max.y; b[5] = k.max.z;
      placeBox(w, o.matrixWorld, b, 0, null);
      return;
    }
    if (o.isInstancedMesh) {
      const box = instanceBox(o, s);
      if (box[3] >= box[0]) placeBox(w, o.matrixWorld, box, 0, null);
      return;
    }
    // Morph targets add to each coordinate, up to what their influences allow.
    const influences = o.morphTargetInfluences, d = influences ? deltasOf(g, s) : null;
    let lx = 0, ly = 0, lz = 0, hx = 0, hy = 0, hz = 0;
    if (d) {
      for (let i = 0, k = 0; i < d.list.length; i++, k += 6) {
        const v = influences[i] || 0, a = v > 0 ? 0 : 3, z = v > 0 ? 3 : 0;
        lx += v * d.boxes[k + a]; ly += v * d.boxes[k + a + 1]; lz += v * d.boxes[k + a + 2];
        hx += v * d.boxes[k + z]; hy += v * d.boxes[k + z + 1]; hz += v * d.boxes[k + z + 2];
      }
    }
    const k = o.isSkinnedMesh ? skinOf(g, s) : null;
    if (d || k) o.frustumCulled = false;
    if (k) {
      const t = tools, skeleton = o.skeleton;
      t.before.multiplyMatrices(o.matrixWorld, o.bindMatrixInverse);
      for (let i = 0; i < k.bones; i++) {
        const at = i * 6;
        if (!(k.boxes[at + 3] >= k.boxes[at]) || !skeleton.boneInverses[i]) continue;
        const bone = skeleton.bones[i];
        t.bone.multiplyMatrices(bone ? bone.matrixWorld : t.none, skeleton.boneInverses[i]);
        t.whole.multiplyMatrices(t.before, t.bone).multiply(o.bindMatrix);
        b[0] = k.boxes[at] + lx; b[1] = k.boxes[at + 1] + ly; b[2] = k.boxes[at + 2] + lz; b[3] = k.boxes[at + 3] + hx; b[4] = k.boxes[at + 4] + hy; b[5] = k.boxes[at + 5] + hz;
        placeBox(w, t.whole, b, 0, null);
      }
      return;
    }
    // A point has a size of its own: in world units with attenuation, in pixels without it.
    let grow = 0;
    if (material && material.isPointsMaterial) {
      if (material.sizeAttenuation && perspective) grow = (material.size / 2) * Math.sqrt(stretchOf(tools.before.copy(o.matrixWorld).invert().elements, 0));
      else room2 = Math.max(room2, material.size / 2);
    }
    const box = s.box;
    b[0] = box[0] + lx - grow; b[1] = box[1] + ly - grow; b[2] = box[2] + lz - grow; b[3] = box[3] + hx + grow; b[4] = box[4] + hy + grow; b[5] = box[5] + hz + grow;
    placeBox(w, o.matrixWorld, b, d || grow ? 0 : s.radius, s);
  };

  const walkReach = (w, o) => {
    if (!o.visible || o === w.stage) return;
    boundObject(w, o);
    const list = o.children;
    for (let i = 0; i < list.length; i++) walkReach(w, list[i]);
  };

  // In a paint no code of a world runs, so one walk of the matrices serves the check, the bounds, the points and all render passes of that world.
  let paintId = 0, painting = false;
  const worldMatrices = (w) => {
    if (painting && w.matrixAt === paintId) return;
    w.matrixAt = paintId;
    w.scene.updateMatrixWorld();
  };

  /** The camera with its nominal frustum, no crop. */
  const nominalCamera = (w) => {
    const c = w.camera;
    if (c.isPerspectiveCamera) c.aspect = w.w / w.h;
    if (c.view && c.view.enabled) c.clearViewOffset(); else c.updateProjectionMatrix();
    c.updateMatrixWorld();
  };

  /**
   * Measure the world and update reach: it grows at once and shrinks slowly. It holds all that the world draws at this moment, skinned and
   * morphed parts too. Only vertices moved in a shader pass it: world.reach() is for those. stage: sample the stage now.
   */
  const measureReach = (w, stage) => {
    if (typeof w.reachSet === 'number') {
      const n = w.reachSet;
      w.reach = { l: -n, t: -n, r: n, b: n, full: false };
      return;
    }
    if (w.reachSet === 'full') { w.reach = { l: 0, t: 0, r: 0, b: 0, full: true }; return; }
    worldMatrices(w);
    const floor = floorOn(w);
    if (stage || (floor && !w.floorBuilt) || ((w.look.name === 'toon' ? w.floor && !w.floorBuilt : true) && w.samples++ % SAMPLE_EVERY === 0)) {
      sampleStage(w);
      // A fit moves the floor and the light.
      w.matrixAt = -1;
      worldMatrices(w);
    }
    nominalCamera(w);
    if (!tools) tools = { view: new THREE.Matrix4(), toCamera: new THREE.Matrix4(), before: new THREE.Matrix4(), bone: new THREE.Matrix4(), whole: new THREE.Matrix4(), none: new THREE.Matrix4(), box: new Float64Array(6) };
    const c = w.camera;
    tools.view.copy(c.matrixWorldInverse);
    P = c.projectionMatrix.elements; near = c.near; perspective = !!c.isPerspectiveCamera; halfW = w.w / 2; halfH = w.h / 2;
    simple = P[4] === 0 && P[1] === 0 && P[0] > 0 && P[5] > 0 && (perspective ? P[11] === -1 && P[3] === 0 && P[7] === 0 : P[11] === 0 && P[3] === 0 && P[7] === 0 && P[15] === 1);
    wl = wt = Infinity; wr = wb = -Infinity; open = false; room2 = 0;
    const list = w.scene.children;
    onFloor = floor && w.floorBuilt;
    for (let i = 0; i < list.length; i++) if (list[i] !== c) walkReach(w, list[i]);
    // What hangs on the camera counts for reach, and not for the floor.
    onFloor = false;
    if (c.parent === w.scene) walkReach(w, c);
    w.pointRoom = room2;
    if (open) { w.reach = { l: 0, t: 0, r: 0, b: 0, full: true }; return; }
    if (!(wr >= wl)) { w.reach = null; return; }
    const r = { l: wl, t: wt, r: wr, b: wb, full: false }, old = w.reach;
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
    const out = w.place;
    if (painting && w.placeAt === paintId) return out;
    w.placeAt = paintId;
    const p = w.placement, cam = surface.camera, dpr = surface.dpr, m = p.matrix;
    const k = Math.max(1e-4, Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])));
    const a = m[0] / k, b = m[1] / k, c = m[2] / k, d = m[3] / k;
    const plain = Math.abs(a - 1) < 1e-4 && Math.abs(d - 1) < 1e-4 && Math.abs(b) < 1e-4 && Math.abs(c) < 1e-4;
    const bx = p.x + p.w / 2 + m[4] + w.moved.x, by = p.y + p.h / 2 + m[5] + w.moved.y;
    let cx = ((bx - cam.x) * cam.zoom + surface.margin) * dpr;
    let cy = ((by - cam.y) * cam.zoom + surface.margin) * dpr;
    // A crop has whole pixels from the anchor, so a whole anchor keeps the output sharp in a pan.
    if (plain) { cx = Math.round(cx); cy = Math.round(cy); }
    out.s = cam.zoom * dpr * k; out.cx = cx; out.cy = cy; out.a = a; out.b = b; out.c = c; out.d = d; out.plain = plain;
    return out;
  };

  /** A box in nominal pixels, snapped out to the grid, or null when empty. */
  const snapped = (l, t, r, b) => {
    if (!(r > l) || !(b > t)) return null;
    return { l: Math.floor(l / GRID) * GRID, t: Math.floor(t / GRID) * GRID, r: Math.ceil(r / GRID) * GRID, b: Math.ceil(b / GRID) * GRID };
  };

  /** Room for what passes the bounds by its own size, in pixels. */
  const softRoom = (w) => Math.max(SOFT_ROOM, (w.pointRoom || 0) + SOFT_ROOM / 2);
  const room = (w, s) => (lookOf(w).bloom > 0 ? Math.max(GLOW_ROOM * s, softRoom(w)) : softRoom(w));

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
    const s = place.s, pad = room(w, s);
    return snapped(Math.max(sl, reach.l * s - pad), Math.max(st, reach.t * s - pad), Math.min(sr, reach.r * s + pad), Math.min(sb, reach.b * s + pad));
  };

  /** The part of a crop that holds the scene: reach and a soft edge. Outside it, only glow. */
  const innerOf = (w, s, crop) => {
    const reach = w.reach;
    if (reach.full || !(lookOf(w).bloom > 0)) return crop;
    const pad = softRoom(w), inner = snapped(reach.l * s - pad, reach.t * s - pad, reach.r * s + pad, reach.b * s + pad);
    return { l: Math.max(crop.l, inner.l), t: Math.max(crop.t, inner.t), r: Math.min(crop.r, inner.r), b: Math.min(crop.b, inner.b) };
  };

  const contains = (a, b) => a.l <= b.l && a.t <= b.t && a.r >= b.r && a.b >= b.b;

  /** Aim the world's camera at a crop. s: nominal pixels per board point. */
  const aimCamera = (w, s, crop) => {
    const c = w.camera, nw = w.w * s, nh = w.h * s;
    if (c.isPerspectiveCamera) c.aspect = w.w / w.h;
    c.setViewOffset(nw, nh, nw / 2 + crop.l, nh / 2 + crop.t, crop.r - crop.l, crop.b - crop.t);
    c.updateMatrixWorld();
  };

  // Render targets. Shared targets hold the passes of one world and are free again after that pass. Outputs belong to one world until it gives
  // them back. The pool has a limit in bytes and drops what no picture used for the longest time. When no picture came for a while, it holds nothing.
  const shared = new Map();
  const spareOutputs = [];
  const IDLE_MS = 3000, GIGABYTE_BYTES = 64e6, MOST_BYTES = 512e6;
  /** The limit of the pool. Chromium gives memory in steps up to 8 GB, Safari gives none. */
  const poolLimit = Math.min(MOST_BYTES, (scope.navigator.deviceMemory || 4) * GIGABYTE_BYTES);
  let useCount = 0, poolBytes = 0, lastUse = 0, idleTimer = 0;
  const targetBytes = (t) => {
    const samples = t.samples || 0, pixel = t.texture.type === THREE.UnsignedByteType ? 4 : 8;
    return t.width * t.height * (pixel * (1 + samples) + (t.depthBuffer ? 4 * Math.max(1, samples) : 0));
  };
  const itemBytes = (item) => (item.isRenderTarget ? targetBytes(item) : item.down.concat(item.up).reduce((sum, t) => sum + (t ? targetBytes(t) : 0), 0));
  const sharedOf = (kind, W, H, make) => {
    const id = kind + ':' + W + 'x' + H;
    let entry = shared.get(id);
    if (!entry) {
      const item = make();
      entry = { item, used: 0, bytes: itemBytes(item) };
      shared.set(id, entry);
      poolBytes += entry.bytes;
    }
    entry.used = useCount;
    return entry.item;
  };
  const dropShared = (id, entry) => { entry.item.dispose(); shared.delete(id); poolBytes -= entry.bytes; };
  const dropSpare = (t) => { spareOutputs.splice(spareOutputs.indexOf(t), 1); poolBytes -= targetBytes(t); t.dispose(); };
  const freeIdle = () => {
    idleTimer = 0;
    if (realNow() - lastUse < IDLE_MS) { idleTimer = nativeSetTimeout(freeIdle, IDLE_MS); return; }
    for (const [id, entry] of shared) dropShared(id, entry);
    while (spareOutputs.length) dropSpare(spareOutputs[0]);
  };
  /** After each picture. What this picture used stays, so a limit under one picture's needs slows nothing but the others. */
  const trimTargets = () => {
    const now = useCount++;
    lastUse = realNow();
    if (!idleTimer) idleTimer = nativeSetTimeout(freeIdle, IDLE_MS);
    while (poolBytes > poolLimit) {
      let oldest = Infinity, spare = null, id = null;
      for (const t of spareOutputs) if (t.used < oldest) { oldest = t.used; spare = t; }
      for (const [key, entry] of shared) if (entry.used < now && entry.used < oldest) { oldest = entry.used; id = key; spare = null; }
      if (spare) dropSpare(spare);
      else if (id !== null) dropShared(id, shared.get(id));
      else return;
    }
  };

  /**
   * An output has room: it is larger than the size in use now, in steps of OUTPUT_STEP. A zoom moves the crop by GRID at each step, and the same
   * output serves many of those steps, so a zoom allocates seldom. OUTPUT_WASTE: the most area that an output can hold beyond what is in use.
   */
  const OUTPUT_STEP = 128, OUTPUT_WASTE = 1.6;
  const stepUp = (n) => Math.ceil(n / OUTPUT_STEP) * OUTPUT_STEP;
  /** direct: the scene renders for this output. With samples it renders in a shared target and comes here as a copy, and with no samples it renders here, so the output has depth. */
  const fitsOutput = (t, W, H, direct, samples) => t.direct === !!direct && (!direct || t.depthBuffer === !samples) && t.width >= W && t.height >= H
    && t.width * t.height <= Math.max(W * H * OUTPUT_WASTE, stepUp(W) * stepUp(H));
  /** Use the corner of t that holds W x H. Three renders there, and the composite reads there. */
  const useOutput = (t, W, H) => {
    t.useW = W; t.useH = H;
    t.viewport.set(0, 0, W, H);
    t.scissor.set(0, 0, W, H);
    t.scissorTest = true;
    return t;
  };
  /** Its texture holds display colours, in plain RGBA8. */
  const takeOutput = (W, H, direct, samples) => {
    let best = null;
    for (const t of spareOutputs) if (fitsOutput(t, W, H, direct, samples) && (!best || t.width * t.height < best.width * best.height)) best = t;
    if (best) {
      spareOutputs.splice(spareOutputs.indexOf(best), 1);
      poolBytes -= targetBytes(best);
      return useOutput(best, W, H);
    }
    const t = new THREE.WebGLRenderTarget(stepUp(W), stepUp(H), { type: THREE.UnsignedByteType, depthBuffer: !!direct && !samples, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    if (direct) { t.isXRRenderTarget = true; t.texture.colorSpace = THREE.SRGBColorSpace; t.texture.internalFormat = 'RGBA8'; }
    t.direct = !!direct;
    return useOutput(t, W, H);
  };
  const giveOutput = (t) => {
    t.used = useCount;
    spareOutputs.push(t);
    poolBytes += targetBytes(t);
  };
  /**
   * Where a direct render with samples draws: a target of the pool with room, as an output has. Samples and depth last for one render and are 9 times the
   * bytes of the picture, so worlds of like size share them, and a world at rest keeps only its output.
   */
  const multisampleTarget = (W, H, samples) => useOutput(sharedOf('multisample' + samples, stepUp(W), stepUp(H), () => {
    const t = new THREE.WebGLRenderTarget(stepUp(W), stepUp(H), { type: THREE.UnsignedByteType, depthBuffer: true, resolveDepthBuffer: false, samples, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    t.isXRRenderTarget = true;
    t.texture.colorSpace = THREE.SRGBColorSpace;
    t.texture.internalFormat = 'RGBA8';
    return t;
  }), W, H);
  /** The resolved picture of a multisample target into an output, on the GPU. The scissor of both targets holds the copy to W x H. */
  const copyPicture = (from, to, W, H) => {
    const gl = renderer.getContext(), state = renderer.state;
    renderer.initRenderTarget(to);
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, renderer.properties.get(from).__webglFramebuffer);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, renderer.properties.get(to).__webglFramebuffer);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  };
`
