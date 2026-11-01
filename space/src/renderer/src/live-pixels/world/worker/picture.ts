/**
 * Would a world's picture differ? A tick that changes nothing must cost no render,
 * because a world with an empty frame callback would otherwise fill the GPU forever.
 *
 * A check reads what a render reads, in a fixed order, and compares each value with
 * the same place in the list of the last check. It writes the new value in that place,
 * so a check allocates nothing. The cost grows with the objects, not with the vertices:
 * a buffer gives its identity and its version, not its values.
 *
 * A false "no change" is worse than a wasted render. So what cannot be read counts as
 * a change: an instance function on a material or an object, a render target's texture,
 * a video, an unknown class. A world can also call world.redraw().
 */
export const PICTURE = String.raw`
  const own = Object.prototype.hasOwnProperty;

  // One check runs at a time. sheet: the list of the last check, written over by this one.
  let sheet = null, sheetAt = 0, sheetDiffers = false, sheetUnknown = false;
  const sheetSeen = new Set();
  const put = (v) => {
    const old = sheet[sheetAt];
    if (old !== v && (old === old || v === v)) sheetDiffers = true;
    sheet[sheetAt++] = v;
  };
  const putMatrix = (m) => { const e = m.elements; for (let i = 0; i < 16; i++) put(e[i]); };

  const readValue = (v, depth) => {
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') { put(v === undefined ? null : v); return; }
    if (typeof v === 'function') { sheetUnknown = true; return; }
    if (v.isTexture) { readTexture(v); return; }
    if (v.isColor) { put(v.r); put(v.g); put(v.b); return; }
    if (v.isVector2) { put(v.x); put(v.y); return; }
    if (v.isVector3) { put(v.x); put(v.y); put(v.z); return; }
    if (v.isVector4 || v.isQuaternion) { put(v.x); put(v.y); put(v.z); put(v.w); return; }
    if (v.isEuler) { put(v.x); put(v.y); put(v.z); put(v.order); return; }
    if (v.isMatrix3 || v.isMatrix4) { for (let i = 0; i < v.elements.length; i++) put(v.elements[i]); return; }
    if (v.isPlane) { readValue(v.normal, depth); put(v.constant); return; }
    if (Array.isArray(v) || ArrayBuffer.isView(v)) { put(v.length); for (let i = 0; i < v.length; i++) readValue(v[i], depth + 1); return; }
    if (depth < 4 && Object.getPrototypeOf(v) === Object.prototype) { for (const key in v) { put(key); readValue(v[key], depth + 1); } return; }
    sheetUnknown = true;
  };

  const readTexture = (t) => {
    put(t);
    if (sheetSeen.has(t)) return;
    sheetSeen.add(t);
    // A target's picture and a video change with no version.
    if (t.isRenderTargetTexture || t.isVideoTexture) { if (t !== environment) sheetUnknown = true; return; }
    put(t.version); put(t.source); put(t.source ? t.source.version : 0);
    readValue(t.offset, 0); readValue(t.repeat, 0); readValue(t.center, 0); put(t.rotation);
  };

  const SKIP = { userData: 1, _listeners: 1, uuid: 1 };
  const readMaterial = (m) => {
    put(m);
    if (sheetSeen.has(m)) return;
    sheetSeen.add(m);
    put(m.version);
    // userData is the world's own, except for the one key that the look reads in every render.
    put(m.userData.toon === false);
    for (const key in m) if (!SKIP[key]) readValue(m[key], 0);
  };

  /** An attribute: which buffer, what it holds now, how the shader reads it. An attribute that three does not own has no readable state. */
  const readAttribute = (a) => {
    put(a || 0);
    if (!a) return;
    if (a.isGLBufferAttribute) { sheetUnknown = true; return; }
    put(a.count); put(a.normalized); put(a.meshPerAttribute === undefined ? 0 : a.meshPerAttribute);
    if (a.isInterleavedBufferAttribute) { put(a.data); put(a.data.version); put(a.offset); put(a.data.meshPerAttribute === undefined ? 0 : a.data.meshPerAttribute); } else put(a.version);
  };
  const readGeometry = (g) => {
    put(g);
    if (sheetSeen.has(g)) return;
    sheetSeen.add(g);
    readAttribute(g.index);
    // The look adds lsInk in its render, and that changes nothing that a render shows.
    for (const name in g.attributes) if (name !== 'lsInk') { put(name); readAttribute(g.attributes[name]); }
    for (const name in g.morphAttributes) { const list = g.morphAttributes[name]; put(name); put(list.length); for (let i = 0; i < list.length; i++) readAttribute(list[i]); }
    put(g.morphTargetsRelative);
    put(g.drawRange.start); put(g.drawRange.count);
    const groups = g.groups;
    put(groups.length);
    for (let i = 0; i < groups.length; i++) { put(groups[i].start); put(groups[i].count); put(groups[i].materialIndex); }
    if (g.isInstancedBufferGeometry) put(g.instanceCount);
  };

  const LIGHT = ['intensity', 'distance', 'decay', 'angle', 'penumbra', 'width', 'height', 'power'];
  const CAMERA = ['fov', 'near', 'far', 'zoom', 'left', 'right', 'top', 'bottom', 'filmGauge', 'filmOffset', 'focus'];
  const readObject = (w, o) => {
    if (o === w.floorGroup || o === w.inkPass) return;
    put(o); put(o.visible);
    if (o.isCamera && o !== w.camera) putMatrix(o.matrixWorld);
    else if (!o.isCamera) putMatrix(o.matrixWorld);
    put(o.layers.mask); put(o.renderOrder); put(o.castShadow); put(o.receiveShadow);
    // A part's fade reaches the floor's shadow through this value.
    put(o.userData.lsFade === undefined ? 1 : o.userData.lsFade);
    if (own.call(o, 'onBeforeRender') || own.call(o, 'onAfterRender') || o.isBatchedMesh || o.isLightProbe) sheetUnknown = true;
    if (o.customDepthMaterial) readMaterial(o.customDepthMaterial);
    if (o.customDistanceMaterial) readMaterial(o.customDistanceMaterial);
    if (o.geometry) readGeometry(o.geometry);
    if (Array.isArray(o.material)) for (let i = 0; i < o.material.length; i++) readMaterial(o.material[i]);
    else if (o.material) readMaterial(o.material);
    if (o.isInstancedMesh) { put(o.count); readAttribute(o.instanceMatrix); readAttribute(o.instanceColor); if (o.morphTexture) readTexture(o.morphTexture); }
    if (o.morphTargetInfluences) readValue(o.morphTargetInfluences, 0);
    if (o.isSkinnedMesh) {
      const bones = o.skeleton.bones;
      put(o.skeleton); put(o.bindMode); put(bones.length); putMatrix(o.bindMatrix);
      for (let i = 0; i < bones.length; i++) if (bones[i]) putMatrix(bones[i].matrixWorld);
    }
    if (o.isSprite) readValue(o.center, 0);
    if (o.isLight) {
      readValue(o.color, 0); readValue(o.groundColor, 0);
      for (let i = 0; i < LIGHT.length; i++) readValue(o[LIGHT[i]], 0);
      if (o.target) putMatrix(o.target.matrixWorld);
      if (o.shadow) { put(o.shadow.bias); put(o.shadow.normalBias); put(o.shadow.radius); readValue(o.shadow.mapSize, 0); }
    }
    const list = o.children;
    for (let i = 0; i < list.length; i++) readObject(w, list[i]);
  };

  const readWorld = (w) => {
    const c = w.camera, s = w.scene;
    worldMatrices(w);
    c.updateMatrixWorld();
    putMatrix(c.matrixWorld);
    for (let i = 0; i < CAMERA.length; i++) readValue(c[CAMERA[i]], 0);
    readValue(s.background, 0); readValue(s.fog, 0); put(s.environmentIntensity); put(s.backgroundIntensity); put(s.backgroundBlurriness);
    if (s.overrideMaterial) readMaterial(s.overrideMaterial);
    for (const key in w.look) { const v = w.look[key]; if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') { put(key); put(v); } else if (Array.isArray(v)) readValue(v, 0); }
    readValue(typeof w.floor === 'object' ? w.floor.y : w.floor, 0);
    readValue(typeof w.reachSet === 'number' || typeof w.reachSet === 'string' ? w.reachSet : null, 0);
    const list = s.children;
    for (let i = 0; i < list.length; i++) if (list[i] !== c) readObject(w, list[i]);
    if (c.parent === s) for (let i = 0; i < c.children.length; i++) readObject(w, c.children[i]);
    // A point published as a function can move with nothing on screen, and a label follows it.
    for (const part of w.parts.values()) {
      const t = part.target;
      if (typeof t === 'function') readValue(inside(w, () => { try { return t(); } catch (e) { return null; } }), 0);
      else if (t && t.isVector3) readValue(t, 0);
    }
  };

  /** True when a picture of w now would differ from the last check. */
  const pictureChanged = (w) => {
    sheet = w.pictureState || (w.pictureState = []);
    sheetAt = 0; sheetDiffers = false; sheetUnknown = false;
    readWorld(w);
    if (sheet.length !== sheetAt) { sheet.length = sheetAt; sheetDiffers = true; }
    sheet = null;
    sheetSeen.clear();
    return sheetDiffers || sheetUnknown;
  };
`
