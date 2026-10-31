/**
 * Would a world's picture differ? A tick that changes nothing must cost no render,
 * because a world with an empty frame callback would otherwise fill the GPU forever.
 *
 * pictureState reads what a render reads into a flat list, and the list is compared
 * with the list of the last check. The cost grows with the objects, not with the
 * vertices: a buffer gives its version, not its values.
 *
 * A false "no change" is worse than a wasted render. So what cannot be read counts as
 * a change: an instance function on a material or an object, a render target's texture,
 * a video, an unknown class. A world can also call world.redraw().
 */
export const PICTURE = String.raw`
  const own = Object.prototype.hasOwnProperty;

  /** One check. list: the numbers and strings of the state. unknown: something could not be read. */
  const reader = (w) => {
    const r = { list: [], unknown: false, seen: new Set() };
    const put = (v) => { r.list.push(v); };

    const value = (v, depth) => {
      if (v === null || v === undefined || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') { put(v === undefined ? null : v); return; }
      if (typeof v === 'function') { r.unknown = true; return; }
      if (v.isTexture) { texture(v); return; }
      if (v.isColor) { put(v.r); put(v.g); put(v.b); return; }
      if (v.isVector2) { put(v.x); put(v.y); return; }
      if (v.isVector3) { put(v.x); put(v.y); put(v.z); return; }
      if (v.isVector4 || v.isQuaternion) { put(v.x); put(v.y); put(v.z); put(v.w); return; }
      if (v.isEuler) { put(v.x); put(v.y); put(v.z); put(v.order); return; }
      if (v.isMatrix3 || v.isMatrix4) { for (const n of v.elements) put(n); return; }
      if (v.isPlane) { value(v.normal, depth); put(v.constant); return; }
      if (Array.isArray(v) || ArrayBuffer.isView(v)) { put(v.length); for (let i = 0; i < v.length; i++) value(v[i], depth + 1); return; }
      if (depth < 4 && Object.getPrototypeOf(v) === Object.prototype) { for (const key of Object.keys(v)) { put(key); value(v[key], depth + 1); } return; }
      r.unknown = true;
    };

    const texture = (t) => {
      put(t.id);
      if (r.seen.has(t)) return;
      r.seen.add(t);
      // A target's picture and a video change with no version.
      if (t.isRenderTargetTexture || t.isVideoTexture) { if (t !== environment) r.unknown = true; return; }
      put(t.version); put(t.source ? t.source.version : 0);
      value(t.offset, 0); value(t.repeat, 0); value(t.center, 0); put(t.rotation);
    };

    const SKIP = { userData: 1, _listeners: 1, uuid: 1 };
    const material = (m) => {
      put(m.id);
      if (r.seen.has(m)) return;
      r.seen.add(m);
      put(m.version);
      for (const key of Object.keys(m)) if (!SKIP[key]) value(m[key], 0);
    };

    const attribute = (a) => {
      if (!a) { put(0); return; }
      put(a.count); put(a.isInterleavedBufferAttribute ? a.data.version : a.version);
    };
    const geometry = (g) => {
      put(g.id);
      if (r.seen.has(g)) return;
      r.seen.add(g);
      attribute(g.index);
      for (const key of Object.keys(g.attributes)) attribute(g.attributes[key]);
      for (const key of Object.keys(g.morphAttributes)) for (const a of g.morphAttributes[key]) attribute(a);
      put(g.drawRange.start); put(g.drawRange.count); put(g.groups.length);
      if (g.isInstancedBufferGeometry) put(g.instanceCount);
    };

    const LIGHT = ['intensity', 'distance', 'decay', 'angle', 'penumbra', 'width', 'height', 'power'];
    const object = (o) => {
      if (o === w.floorGroup) return;
      put(o.id); put(o.visible);
      if (o.isCamera && o !== w.camera) { for (const n of o.matrixWorld.elements) put(n); }
      else if (!o.isCamera) for (const n of o.matrixWorld.elements) put(n);
      put(o.layers.mask & ~(1 << SHADOW_LAYER)); put(o.renderOrder); put(o.castShadow); put(o.receiveShadow);
      if (own.call(o, 'onBeforeRender') || own.call(o, 'onAfterRender') || o.isBatchedMesh || o.isLightProbe) r.unknown = true;
      if (o.customDepthMaterial) material(o.customDepthMaterial);
      if (o.customDistanceMaterial) material(o.customDistanceMaterial);
      if (o.geometry) geometry(o.geometry);
      if (o.material) for (const m of [].concat(o.material)) material(m);
      if (o.isInstancedMesh) { put(o.count); attribute(o.instanceMatrix); attribute(o.instanceColor); }
      if (o.morphTargetInfluences) value(o.morphTargetInfluences, 0);
      if (o.isSkinnedMesh) for (const bone of o.skeleton.bones) for (const n of bone.matrixWorld.elements) put(n);
      if (o.isSprite) value(o.center, 0);
      if (o.isLight) {
        value(o.color, 0); value(o.groundColor, 0);
        for (const key of LIGHT) value(o[key], 0);
        if (o.target) for (const n of o.target.matrixWorld.elements) put(n);
        if (o.shadow) { put(o.shadow.bias); put(o.shadow.normalBias); put(o.shadow.radius); value(o.shadow.mapSize, 0); }
      }
      for (const child of o.children) object(child);
    };

    const c = w.camera, s = w.scene;
    s.updateMatrixWorld();
    c.updateMatrixWorld();
    for (const n of c.matrixWorld.elements) put(n);
    for (const key of ['fov', 'near', 'far', 'zoom', 'left', 'right', 'top', 'bottom', 'filmGauge', 'filmOffset', 'focus']) value(c[key], 0);
    value(s.background, 0); value(s.fog, 0); put(s.environmentIntensity); put(s.backgroundIntensity); put(s.backgroundBlurriness);
    if (s.overrideMaterial) material(s.overrideMaterial);
    for (const key of Object.keys(w.look)) { const v = w.look[key]; if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') { put(key); put(v); } }
    value(typeof w.floor === 'object' ? { ...w.floor } : w.floor, 0);
    value(typeof w.reachSet === 'number' || typeof w.reachSet === 'string' ? w.reachSet : null, 0);
    for (const child of s.children) if (child !== c) object(child);
    if (c.parent === s) for (const child of c.children) object(child);
    // A point published as a function can move with nothing on screen, and a label follows it.
    for (const part of w.parts.values()) {
      const t = part.target;
      if (typeof t === 'function') value(inside(w, () => { try { return t(); } catch (e) { return null; } }), 0);
      else if (t && t.isVector3) value(t, 0);
    }
    return r;
  };

  const sameList = (a, b) => {
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) { const x = a[i], y = b[i]; if (x !== y && (x === x || y === y)) return false; }
    return true;
  };

  /** True when a picture of w now would differ from the last check. */
  const pictureChanged = (w) => {
    const state = reader(w);
    const same = !state.unknown && sameList(w.pictureState, state.list);
    w.pictureState = state.list;
    return !same;
  };
`
