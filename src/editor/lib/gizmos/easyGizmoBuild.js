/* global THREE */
// Geometry and material factories for the easy gizmo, and the registry that
// tears them all down again.
//
// Everything the gizmo draws is created ONCE, here, at construction. attach()
// and detach() only show, hide and re-lay-out — which makes a per-selection
// leak structurally impossible rather than merely fixed.

import {
  ARC_HEAD_RADIUS,
  ARC_PICK_WIDTH_MULT,
  ARC_RADIAL_SEGMENTS,
  ARC_TUBE_RADIUS,
  ARC_TUBULAR_SEGMENTS,
  ARC_HALF_SWEEP_DEG,
  COLOR_MOVE,
  COLOR_ROTATE,
  OPACITY_ACTION,
  OPACITY_DIM,
  OPACITY_HOVER,
  OPACITY_REST
} from './easyGizmoConstants.js';

/**
 * One list, holding every long-lived resource the gizmo creates — and not only
 * the geometry and materials. The idle probe timer, the scene-update
 * subscription and any in-flight transition are none of those three, so a
 * registry that held geometry alone would leak all of them while reporting
 * itself clean: the event emitter lives for the life of the app, and a
 * transition driver left running against a disposed subsystem is worse than a
 * leak.
 */
export class DisposalRegistry {
  constructor() {
    this.entries = [];
  }

  /** Register anything with a `dispose()`, and hand it straight back. */
  add(resource) {
    if (resource && typeof resource.dispose === 'function') {
      this.entries.push(resource);
    }
    return resource;
  }

  /** Register a teardown that is not itself a disposable — a timer, a
   * subscription, a running animation. */
  addTeardown(fn) {
    const entry = { dispose: fn };
    this.entries.push(entry);
    return entry;
  }

  has(resource) {
    return this.entries.indexOf(resource) !== -1;
  }

  dispose() {
    for (let i = 0; i < this.entries.length; i++) {
      this.entries[i].dispose();
    }
    this.entries.length = 0;
  }
}

/**
 * A flat isoceles triangle in the XY plane: apex at +Y, base spanning X, unit
 * extents both ways. Scale X for the base width and Y for the length.
 *
 * Flat rather than a cone, because a cone has a base CAP — a disc wider than
 * whatever it is attached to — and with depth testing off that disc draws
 * straight over the end of the tube it is meant to finish. A flat head has no
 * cap to draw and reads as an arrow from every angle.
 *
 * The plane a flat head lies in has to be CHOSEN, where a cone's did not, so
 * every caller orients it per frame rather than baking a rotation here.
 */
export function makeArrowheadGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0],
      3
    )
  );
  // Explicit, because a lit material with no normals renders black. Winding is
  // counter-clockwise in XY, so +Z is the front face.
  g.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3)
  );
  g.setIndex([0, 1, 2]);
  return g;
}

/**
 * Every gizmo material draws over occluding geometry, which is a requirement
 * rather than a style: the gizmo has to be visible when the object is behind
 * something, and the square has to paint over the object standing in it.
 *
 * `renderOrder` alone does not deliver that — it only sorts WITHIN a render
 * list, so an opaque helper is still painted under any transparent surface in
 * the scene. Turning the depth test off is what does it, and the material must
 * be transparent to join the list that is sorted at all.
 *
 * `solid` says whether the shape is three-dimensional (a tube, a cone) or flat
 * (a plane, a ring). Solids draw FRONT FACES ONLY: with no depth test, a
 * double-sided solid composites its near and far faces together, which erases
 * the shading step that makes an edge read as an edge — and it means apparent
 * opacity and material alpha are the same number, so the constants can be
 * written in what the eye sees. A flat piece drawn front-side only would be
 * invisible from one side, so those stay double-sided.
 */
export function makeMaterial(color, opacity, solid) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    side: solid ? THREE.FrontSide : THREE.DoubleSide
  });
}

export const EMPHASIS_LEVELS = ['rest', 'hover', 'dim', 'action'];

const LEVEL_OPACITY = {
  rest: OPACITY_REST,
  hover: OPACITY_HOVER,
  dim: OPACITY_DIM,
  action: OPACITY_ACTION
};

/**
 * The shared material set: four emphasis levels in each of the gizmo's two
 * colours, in a solid and a flat variant, created once and pointed at by
 * whichever meshes are currently at that level.
 *
 * Sharing by role rather than per mesh is what keeps the count bounded as the
 * chevron stack grows. Two kinds of surface still need a material of their own,
 * and both carry a genuinely per-mesh ALPHA rather than a level: the pair of
 * arrowheads that fade out across the flattened transition, and each chevron,
 * which fades independently as the stack recycles past the ends of its run.
 */
export function makeMaterialSet(registry) {
  const set = { move: {}, rotate: {} };
  const colours = { move: COLOR_MOVE, rotate: COLOR_ROTATE };
  Object.keys(colours).forEach((name) => {
    EMPHASIS_LEVELS.forEach((level) => {
      set[name][level] = {
        solid: registry.add(
          makeMaterial(colours[name], LEVEL_OPACITY[level], true)
        ),
        flat: registry.add(
          makeMaterial(colours[name], LEVEL_OPACITY[level], false)
        )
      };
    });
  });
  // Invisible, and shared by every pick proxy: a drawn one would paint a solid
  // square over a landing outline or a fat tube over the arc.
  set.pick = registry.add(makeMaterial(COLOR_MOVE, 0, false));
  return set;
}

/**
 * Rebuild a torus's index buffer TUBULAR-MAJOR, so `setDrawRange` shortens the
 * SWEEP, and return the number of indices one tubular step costs.
 *
 * Stock TorusGeometry emits the radial loop outer and the sweep loop inner, so
 * an index prefix is a longitudinal strip running the full arc: a draw range on
 * it peels the tube open lengthwise instead of shortening it. Swapping the
 * loops costs nothing per frame — it happens once, here.
 */
export function reindexTubularMajor(geometry, radialSegments, tubularSegments) {
  const indices = [];
  const row = tubularSegments + 1;
  for (let i = 1; i <= tubularSegments; i++) {
    for (let j = 1; j <= radialSegments; j++) {
      const a = row * j + i - 1;
      const b = row * (j - 1) + i - 1;
      const c = row * (j - 1) + i;
      const d = row * j + i;
      indices.push(a, b, d, b, c, d);
    }
  }
  geometry.setIndex(indices);
  return radialSegments * 6;
}

/**
 * The arc's drawn tube and the fatter invisible copy that is hit-tested in its
 * place. The drawn tube is about three pixels across, so the pickable region
 * would otherwise be the sliver you can see and nothing more; a raycaster
 * threshold exists only for lines and points, and widening the drawn tube would
 * change the look.
 *
 * Both carry the same segment counts, so one step count drives both draw
 * ranges — asserted rather than assumed, because a mismatch would leave the hit
 * region and the drawn arc retracting by different amounts.
 */
export function makeArcGeometries() {
  const sweep = (ARC_HALF_SWEEP_DEG * Math.PI) / 180;
  const drawn = new THREE.TorusGeometry(
    1,
    ARC_TUBE_RADIUS,
    ARC_RADIAL_SEGMENTS,
    ARC_TUBULAR_SEGMENTS,
    sweep
  );
  const pick = new THREE.TorusGeometry(
    1,
    ARC_TUBE_RADIUS * ARC_PICK_WIDTH_MULT,
    ARC_RADIAL_SEGMENTS,
    ARC_TUBULAR_SEGMENTS,
    sweep
  );
  const indicesPerStep = reindexTubularMajor(
    drawn,
    ARC_RADIAL_SEGMENTS,
    ARC_TUBULAR_SEGMENTS
  );
  const pickIndicesPerStep = reindexTubularMajor(
    pick,
    ARC_RADIAL_SEGMENTS,
    ARC_TUBULAR_SEGMENTS
  );
  if (pickIndicesPerStep !== indicesPerStep) {
    throw new Error('easy gizmo: arc pick proxy index stride mismatch');
  }
  return { drawn, pick, indicesPerStep };
}

/**
 * One arc arrowhead: an open-ended cone finished with a ring whose hole is the
 * tube's own section. A solid cone's base cap is a disc wider than the tube it
 * sits on, which with depth testing off draws as a blob straddling the end of
 * the arc and stops the pair reading as one arrow.
 */
export function makeArcHeadGeometries() {
  return {
    cone: new THREE.ConeGeometry(1, 1, 12, 1, true),
    cap: new THREE.RingGeometry(ARC_TUBE_RADIUS / ARC_HEAD_RADIUS, 1, 12)
  };
}
