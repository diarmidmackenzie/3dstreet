import { describe, it, expect } from 'vitest';
import {
  evaluatePath,
  isGizmoGroundHit,
  isUserImportedMeshHit,
  pickSupportBelow,
  pickSurfaceAbove
} from '@/editor/lib/gizmos/easyGizmoGround.js';
import {
  PATH_PROBE_BUDGET,
  STEP_METRES,
  SUBSTEP_METRES
} from '@/editor/lib/gizmos/easyGizmoConstants.js';

/** A raycast hit whose owning entity carries the given attributes. */
function hitOn(attributes, y, extras = {}) {
  const el = {
    hasAttribute: (name) => Object.hasOwn(attributes, name),
    getAttribute: (name) => attributes[name],
    ...extras
  };
  const object = { el, material: { visible: true }, visible: true };
  return { object, point: { x: 0, y, z: 0 } };
}

const segment = (y) => hitOn({ 'street-segment': '' }, y);
const scatter = (y) => hitOn({ mixin: 'bench-1' }, y);
const cloudMesh = (y) =>
  hitOn(
    {
      'gltf-model': 'url(x)',
      'data-asset-id': 'a',
      'data-asset-owner-uid': 'u'
    },
    y
  );
const localMesh = (y) =>
  hitOn({ 'gltf-model': 'url(blob:x)', 'data-temporary-file': 'true' }, y);
const importedImage = (y) =>
  hitOn(
    { src: 'url(x)', 'data-asset-id': 'a', 'data-asset-owner-uid': 'u' },
    y
  );
const importedSplat = (y) =>
  hitOn({ splat: 'src: x', 'data-temporary-file': 'true' }, y);

/** A tiles hit: the owning entity's ancestor chain carries the tiles marker. */
function tiles(y) {
  const root = {
    id: 'google3d',
    hasAttribute: () => false,
    getAttribute: (n) => (n === 'data-layer-name' ? 'Google 3D Tiles' : null)
  };
  const offsetEl = { hasAttribute: () => false, getAttribute: () => null };
  const rootNode = { el: root, parent: null };
  const offsetNode = { el: offsetEl, parent: rootNode };
  const object = {
    el: offsetEl,
    parent: offsetNode,
    material: { visible: true },
    visible: true
  };
  return { object, point: { x: 0, y, z: 0 } };
}

describe('what the gizmo counts as ground', () => {
  it('passes the three surfaces the camera already stands on', () => {
    expect(isGizmoGroundHit(segment(0))).toBe(true);
    expect(isGizmoGroundHit(tiles(0))).toBe(true);
  });

  it('rejects scatter, exactly as the camera does', () => {
    expect(isGizmoGroundHit(scatter(0))).toBe(false);
  });

  it('admits an imported glTF, which is the one branch it adds', () => {
    expect(isUserImportedMeshHit(cloudMesh(0))).toBe(true);
    expect(isUserImportedMeshHit(localMesh(0))).toBe(true);
    expect(isGizmoGroundHit(cloudMesh(0))).toBe(true);
  });

  it('excludes an imported image or splat carrying the same markers', () => {
    // The upload path stamps those markers on every asset it places, not only
    // on meshes — and an uploaded logo becomes a flat plane, which lying over a
    // road would swallow the road's footprint.
    expect(isUserImportedMeshHit(importedImage(0))).toBe(false);
    expect(isUserImportedMeshHit(importedSplat(0))).toBe(false);
  });

  it('rejects a hit with no owning entity, which is how editor chrome falls out', () => {
    expect(isGizmoGroundHit({ object: {}, point: { x: 0, y: 0, z: 0 } })).toBe(
      false
    );
  });
});

describe('which surface in a column supports the object', () => {
  it('lets a street beat a nearer tiles drape below the base', () => {
    // The photogrammetric skin drapes OVER real geometry, so the nearest hit
    // below is systematically the drape rather than the road it covers. Without
    // this the gizmo would rest an object on the drape while navigation stood
    // the camera on the street underneath — a permanent disagreement of the
    // drape's thickness.
    const picked = pickSupportBelow([tiles(-0.2), segment(-0.5)], 0);
    expect(picked.y).toBeCloseTo(-0.5, 9);
  });

  it('ranks a user import with the street, not with the drape', () => {
    const picked = pickSupportBelow([tiles(-0.2), cloudMesh(-0.5)], 0);
    expect(picked.y).toBeCloseTo(-0.5, 9);
  });

  it('takes the nearest within a class', () => {
    const picked = pickSupportBelow([segment(-3), segment(-0.5)], 0);
    expect(picked.y).toBeCloseTo(-0.5, 9);
  });

  it('takes the NEAREST above the base, with no class preference', () => {
    // The asymmetry is the point. Looking up the drape's bias is absent and
    // inverts: a photogrammetric roof three metres overhead is the real
    // surface, and a building slab forty metres up is not the one anyone would
    // name. A build carrying the downward precedence upward picks the slab.
    const picked = pickSurfaceAbove([segment(40), tiles(3)], 0);
    expect(picked.y).toBeCloseTo(3, 9);
  });
});

describe('the continuity rule along a frame of travel', () => {
  const at = (y) => ({ below: { y } });

  /** A uniform ramp of the given angle, measured from the frame's start. */
  const ramp = (degrees) => (x, z) => ({
    below: { y: Math.hypot(x, z) * Math.tan((degrees * Math.PI) / 180) }
  });

  const run = (to, probeAt, fromSupportY = 0, budget = PATH_PROBE_BUDGET) =>
    evaluatePath({
      from: { x: 0, z: 0 },
      to,
      fromSupportY,
      probeAt,
      budget
    });

  it('follows a 30 degree ramp for a whole frame, because the reference advances', () => {
    // Five full sub-spans rising 0.117 m each: the frame's total climb is 0.6 m,
    // which is well over one step. A build comparing every sample against the
    // frame's STARTING support calls this discontinuous and the object does not
    // climb the ramp at all — and the followable rise would then be capped per
    // FRAME, making the followable angle a function of drag speed and camera
    // distance.
    const result = run({ x: 1.04, z: 0 }, ramp(30));
    expect(result.continuous).toBe(true);
    expect(result.supportY).toBeCloseTo(1.04 * Math.tan(Math.PI / 6), 6);
    expect(result.supportY).toBeGreaterThan(STEP_METRES);
  });

  it('refuses a 70 degree face over the same frame', () => {
    const result = run({ x: 1.04, z: 0 }, ramp(70));
    expect(result.continuous).toBe(false);
    expect(result.supportY).toBe(0);
  });

  it('discards the whole frame rather than crediting the samples before a riser', () => {
    // Every other fixture here is uniform, and a frame with one profile
    // throughout fails at its first pair if it fails at all — so "returns the
    // seeded value" is true of a partial-credit build too. This one climbs four
    // sub-spans and then meets a half-metre riser.
    const riserAt = 4 * SUBSTEP_METRES;
    const ramp = (x) => x * Math.tan(Math.PI / 6);
    const probeAt = (x) => ({
      below: { y: x > riserAt + 1e-9 ? ramp(x) + 0.5 : ramp(x) }
    });
    const result = run({ x: 5 * SUBSTEP_METRES + 0.01, z: 0 }, probeAt);
    expect(result.continuous).toBe(false);
    // A build that latched the last accepted sample instead would return the
    // 0.47 m it had climbed before the riser.
    expect(result.supportY).toBe(0);
  });

  it('steps down a shallow drop as readily as it steps up', () => {
    const result = run({ x: 0.1, z: 0 }, () => at(-0.15));
    expect(result.continuous).toBe(true);
    expect(result.supportY).toBeCloseTo(-0.15, 9);
  });

  it('holds the remembered support when the probe finds nothing', () => {
    // The safe failure here is to leave the object where it is; the camera's own
    // probe answers a different question and treats a miss as "no floor".
    const result = run({ x: 0.1, z: 0 }, () => ({ below: null }), 1.25);
    expect(result.continuous).toBe(true);
    expect(result.supportY).toBeCloseTo(1.25, 9);
  });

  it('refuses a half-metre riser at EVERY sub-span length up to the sampling bound', () => {
    // The property the whole sampling bound exists for: at a sub-span of
    // SUBSTEP or shorter the two-term allowance collapses to a HEIGHT, so the
    // answer stops depending on how fast the cursor was moving.
    //
    // Scoped deliberately. Past about 0.29 m the slope term carries the
    // allowance beyond half a metre and a CORRECT build calls the same step
    // continuous, so an unscoped assertion would fail one.
    for (const d of [0.02, 0.05, 0.1, SUBSTEP_METRES]) {
      expect(run({ x: d, z: 0 }, () => at(0.5)).continuous).toBe(false);
    }
  });

  it('follows a kerb-height step at every one of those lengths', () => {
    for (const d of [0.02, 0.05, 0.1, SUBSTEP_METRES]) {
      expect(run({ x: d, z: 0 }, () => at(0.15)).continuous).toBe(true);
    }
  });
});

describe('the sampler and its budget', () => {
  const flat = () => ({ below: { y: 0 } });
  const run = (d, probeAt = flat, budget = PATH_PROBE_BUDGET) =>
    evaluatePath({
      from: { x: 0, z: 0 },
      to: { x: d, z: 0 },
      fromSupportY: 0,
      probeAt,
      budget
    });

  it('takes no interior sample when the frame is one sub-span or less', () => {
    const result = run(SUBSTEP_METRES * 0.9);
    expect(result.demanded).toBe(0);
    expect(result.samples).toEqual([]);
  });

  it('takes exactly one just past that', () => {
    expect(run(SUBSTEP_METRES * 1.1).demanded).toBe(1);
  });

  it('costs a flat span exactly what it costs a broken one', () => {
    // There is no early stop, so the cost is a function of the frame's length
    // and of nothing in the scene. This is the check that one has not been
    // reintroduced.
    const result = run(1.0);
    expect(result.demanded).toBe(4);
    expect(result.cast).toBe(4);
    expect(result.continuous).toBe(true);
  });

  it('demands the ceiling of the span over the sub-span, less one', () => {
    for (const d of [0.3, 0.75, 1.4, 2.6]) {
      expect(run(d).demanded).toBe(Math.ceil(d / SUBSTEP_METRES) - 1);
    }
  });

  it('places its samples at whole sub-spans from the start, in order', () => {
    const { samples } = run(1.0);
    samples.forEach((s, i) => {
      expect(s.x).toBeCloseTo((i + 1) * SUBSTEP_METRES, 9);
    });
    // The remainder sub-span is the one left over at the end, and is shorter.
    const last = samples[samples.length - 1];
    expect(1.0 - last.x).toBeLessThan(SUBSTEP_METRES);
  });

  it('declares an over-budget frame discontinuous without casting anything', () => {
    // The outcome is fixed before the first ray, so spending the budget on it
    // buys nothing — and a build that casts the budget and only then gives up
    // passes every other assertion here.
    let casts = 0;
    const counting = (x, z) => {
      casts++;
      return flat(x, z);
    };
    const result = run((PATH_PROBE_BUDGET + 3) * SUBSTEP_METRES, counting);
    expect(result.overBudget).toBe(true);
    expect(result.continuous).toBe(false);
    expect(result.cast).toBe(0);
    expect(casts).toBe(0);
    expect(result.supportY).toBe(0);
  });

  it('resolves the whole budget band at exactly the sampling spacing', () => {
    const band = (PATH_PROBE_BUDGET + 1) * SUBSTEP_METRES;
    const result = run(band - 1e-6);
    expect(result.overBudget).toBe(false);
    expect(result.demanded).toBe(PATH_PROBE_BUDGET);
  });
});
