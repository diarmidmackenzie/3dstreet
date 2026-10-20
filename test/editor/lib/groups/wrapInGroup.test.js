import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { wrapInGroup } from '@/editor/lib/entity.jsx';
import {
  groupAnchor,
  newGroupPlacement
} from '@/editor/lib/groups/groupPlacement.js';
import {
  canReparent,
  canWrapInGroup,
  keepsItsParent
} from '@/editor/lib/groups/groupModel.js';
import { isReparentInFlight } from '@/editor/lib/commands/EntityReparentCommand.js';
import {
  entityIn,
  memberWithBox,
  mountPlacementScene
} from './_placementHarness.js';

// Putting one item into a new group from the layer row's menu, and where the
// New group button puts a group, over the placement harness: real commands,
// guard and History, and entities whose object3D follows their pose.

let scene;
let root;
let inspector;

// What the serializer and loader do for a move, reduced to what it needs: the
// pose the command writes is applied, and the element's children go with it.
const originals = new Map();
let failNextRecreate = false;
// False to leave the old element's children with it, as the real loader does.
let carryChildren = true;
const serializer = {
  getElementData: (el) => {
    originals.set(el.id, el);
    const pose = (name) => {
      const v = el.getAttribute(name);
      return v ? `${v.x} ${v.y} ${v.z}` : undefined;
    };
    return {
      id: el.id,
      class: el.className || undefined,
      attributes: [...el.attributes]
        .filter(
          (a) =>
            !['id', 'class', 'position', 'rotation', 'scale'].includes(a.name)
        )
        .map((a) => [a.name, a.value]),
      components: {
        position: pose('position'),
        rotation: pose('rotation'),
        scale: pose('scale')
      }
    };
  },
  createEntityFromObj: (data, parent, before) => {
    if (failNextRecreate) {
      failNextRecreate = false;
      throw new Error('recreate failed');
    }
    const el = data.entityElement;
    el.id = data.id;
    if (data.class) el.className = data.class;
    for (const [name, value] of data.attributes) el.setAttribute(name, value);
    for (const name of ['position', 'rotation', 'scale']) {
      if (data.components[name]) el.setAttribute(name, data.components[name]);
    }
    // The element this one replaces is the last one built under its id.
    const carried = carryChildren ? originals.get(data.id)?.children : [];
    for (const child of [...(carried ?? [])]) {
      el.append(child);
    }
    originals.set(data.id, el);
    parent.insertBefore(el, before);
    return el;
  }
};

// Send `loaded` to every entity that has not had it, as A-Frame does once an
// element's components are ready, until a batch has run to its end.
const loadedSent = new WeakSet();
function settle() {
  for (let pass = 0; pass < 6; pass++) {
    const fresh = [...document.querySelectorAll('a-entity')].filter(
      (el) => !loadedSent.has(el)
    );
    if (fresh.length === 0) return;
    for (const el of fresh) {
      loadedSent.add(el);
      el.dispatchEvent(new Event('loaded'));
    }
  }
}

const undo = () => {
  inspector.history.undo();
  settle();
};
const redo = () => {
  inspector.history.redo();
  settle();
};
const wrap = (el, options) => {
  wrapInGroup(el, options);
  settle();
};

function worldMatrix(el) {
  el.object3D.updateWorldMatrix(true, false);
  return el.object3D.matrixWorld.clone();
}

function expectSameMatrix(actual, expected) {
  actual.elements.forEach((value, i) =>
    expect(value).toBeCloseTo(expected.elements[i], 9)
  );
}

const userGroups = () => [...document.querySelectorAll('.user-group')];

// Every selection made, in order, by id (null for none), so a selection that is
// replaced within the same step still shows.
let selections;

beforeEach(() => {
  scene = mountPlacementScene();
  root = scene.root;
  inspector = scene.inspector;
  globalThis.STREET.utils = serializer;
  originals.clear();
  failNextRecreate = false;
  carryChildren = true;
  selections = [];
  const select = inspector.selectEntity;
  inspector.selectEntity = function (el) {
    selections.push(el?.id ?? null);
    select.call(this, el);
  };
});

afterEach(() => {
  settle();
  // A wrap that did not run to its end would leave its item moving.
  for (const el of document.querySelectorAll('a-entity')) {
    expect(isReparentInFlight(el.id)).toBe(false);
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Group, from a layer row', () => {
  it('puts a rotated item into a new group in its place as one undo step, and undo and redo restore each state (fails if the pose, order, selection or step count is wrong)', () => {
    const parent = entityIn(root, {
      id: 'parent',
      cls: 'user-group',
      position: '10 0 -4',
      rotation: '0 30 0'
    });
    entityIn(parent, { id: 'a' });
    const item = entityIn(parent, {
      id: 'item',
      position: '3 1 2',
      rotation: '0 70 0'
    });
    entityIn(parent, { id: 'b' });
    const before = worldMatrix(item);
    inspector.selectEntity(item);
    selections = [];
    const onGrouped = vi.fn();

    wrap(item, { onGrouped });

    expect(inspector.history.undos).toHaveLength(1);
    expect(inspector.history.undos[0].name).toBe('Group');
    const [group] = userGroups().filter((el) => el !== parent);
    const order = () => [...parent.children].map((el) => el.id);
    expect(order()).toEqual(['a', group.id, 'b']);
    const moved = document.getElementById('item');
    expect(moved.parentNode).toBe(group);
    expect(group.children).toHaveLength(1);
    expectSameMatrix(worldMatrix(moved), before);
    // Neither command selects what it made or moved; the move only clears the
    // selection it took out, and the batch selects the group at the end.
    expect(selections).toEqual([null, group.id]);
    expect(onGrouped.mock.calls).toEqual([[group]]);

    selections = [];
    undo();
    expect(order()).toEqual(['a', 'item', 'b']);
    expect(document.getElementById(group.id)).toBe(null);
    expectSameMatrix(worldMatrix(document.getElementById('item')), before);
    expect(selections.at(-1)).toBe('item');
    expect(onGrouped).toHaveBeenCalledTimes(1);

    selections = [];
    redo();
    const redone = document.getElementById(group.id);
    expect(order()).toEqual(['a', group.id, 'b']);
    expect(document.getElementById('item').parentNode).toBe(redone);
    expectSameMatrix(worldMatrix(document.getElementById('item')), before);
    expect(selections).toEqual([null, group.id]);
    expect(onGrouped.mock.calls).toEqual([[group], [redone]]);
    expect(document.querySelectorAll(`[id="${group.id}"]`)).toHaveLength(1);
  });

  it('on a street segment row puts the whole street into the group, and undo selects the segment again (fails if it wraps the segment or does nothing)', () => {
    const street = entityIn(root, { id: 'street', position: '5 0 0' });
    street.setAttribute('managed-street', '');
    const segment = entityIn(street, { id: 'segment' });
    segment.setAttribute('street-segment', '');
    inspector.selectEntity(segment);

    wrap(segment);

    const [group] = userGroups();
    expect(group.parentNode).toBe(root);
    expect(document.getElementById('street').parentNode).toBe(group);
    expect(document.getElementById('segment').parentNode.id).toBe('street');

    undo();
    expect(userGroups()).toHaveLength(0);
    expect(inspector.selectedEntity?.id).toBe('segment');
  });

  it('does nothing for an item that cannot go into a group (fails if a shape, the Starting View or the panorama is wrapped)', () => {
    const shape = entityIn(root, { id: 'shape' });
    shape.setAttribute('shape', '');
    const start = entityIn(root, { id: 'start' });
    start.setAttribute('viewer-start', '');
    const backdrop = entityIn(root, { id: 'pano', cls: 'scene-backdrop' });

    for (const el of [shape, start, backdrop]) {
      expect(groupAnchor(el)).toBe(null);
      wrap(el);
    }

    expect(scene.executed).toHaveLength(0);
    expect(userGroups()).toHaveLength(0);
  });

  it("on a closed group's row puts it into a new group whose origin is at that group's center, keeping its world pose (fails if the origin is used)", () => {
    const inner = entityIn(root, {
      id: 'inner',
      cls: 'user-group',
      position: '20 0 -10',
      rotation: '0 45 0'
    });
    memberWithBox(inner, [6, 0, 8], [10, 2, 12]);
    const before = worldMatrix(inner);
    inspector.selectEntity(inner);

    wrap(inner);

    const outer = document.getElementById('inner').parentNode;
    expect(outer.classList.contains('user-group')).toBe(true);
    // The inner group's center, (8, 1, 10) in its frame, in the top level's.
    const expected = new THREE.Vector3(8, 1, 10).applyMatrix4(before);
    expect(outer.object3D.position.x).toBeCloseTo(expected.x, 9);
    expect(outer.object3D.position.y).toBeCloseTo(expected.y, 9);
    expect(outer.object3D.position.z).toBeCloseTo(expected.z, 9);
    expectSameMatrix(worldMatrix(document.getElementById('inner')), before);
  });

  it('when the move fails as it runs, leaves an empty group that one undo removes, and a redo makes it once (fails if undo strands the group or redo repeats its id)', () => {
    const item = entityIn(root, { id: 'item' });
    failNextRecreate = true;
    const onGrouped = vi.fn();

    wrap(item, { onGrouped });

    const [group] = userGroups();
    expect(group.children).toHaveLength(0);
    expect(document.getElementById('item').parentNode).toBe(root);
    expect(globalThis.STREET.notify.errorMessage).toHaveBeenCalled();
    expect(onGrouped).not.toHaveBeenCalled();

    undo();
    expect(userGroups()).toHaveLength(0);
    expect(inspector.selectedEntity?.id).toBe('item');

    // The failed move lets the batch finish, so the redone group is selected.
    redo();
    expect(document.querySelectorAll(`[id="${group.id}"]`)).toHaveLength(1);
    expect(document.getElementById('item').parentNode).toBe(root);
    expect(inspector.selectedEntity?.id).toBe(group.id);
    expect(onGrouped).toHaveBeenCalledTimes(1);
  });

  it('when the move fails as it is undone, keeps the item in its group through a redo and a second undo (fails if the group is removed with the item in it)', () => {
    const item = entityIn(root, { id: 'item' });
    const member = entityIn(item, { id: 'item-child' });
    wrap(item);
    const [group] = userGroups();

    failNextRecreate = true;
    undo();
    expect(document.getElementById('item').parentNode).toBe(group);

    redo();
    undo();
    expect(group.isConnected).toBe(true);
    expect(document.getElementById('item').parentNode).toBe(group);
    expect(member.isConnected).toBe(true);
  });
});

describe('a move that leaves the selection to its batch (noSelectEntity)', () => {
  const move = (entity, noSelectEntity) => {
    inspector.execute('entityreparent', {
      entity,
      parentEl: 'target',
      indexInParent: 0,
      noSelectEntity
    });
    settle();
  };

  it('keeps a selection outside the moved item, and clears one inside it (fails if it selects the moved item or leaves a removed child selected)', () => {
    entityIn(root, { id: 'target', cls: 'user-group' });
    const other = entityIn(root, { id: 'other' });
    const item = entityIn(root, { id: 'item' });
    entityIn(item, { id: 'item-child' });

    inspector.selectEntity(other);
    move(item, true);
    expect(document.getElementById('item').parentNode.id).toBe('target');
    expect(inspector.selectedEntity).toBe(other);

    inspector.selectEntity(document.getElementById('item-child'));
    carryChildren = false;
    selections = [];
    move(document.getElementById('item'), true);
    expect(selections).toEqual([null]);
  });

  it('without it, selects the moved item as before (fails if the default changed)', () => {
    entityIn(root, { id: 'target', cls: 'user-group' });
    const item = entityIn(root, { id: 'item' });

    move(item, undefined);

    expect(inspector.selectedEntity).toBe(document.getElementById('item'));
    expect(inspector.selectedEntity.parentNode.id).toBe('target');
  });
});

describe('where the New group button puts a group', () => {
  it("with a closed, turned group selected inside a turned group, at that group's center in its parent's frame (fails if the origin or the world frame is used)", () => {
    const parent = entityIn(root, {
      id: 'parent',
      cls: 'user-group',
      position: '-7 2 5',
      rotation: '0 -35 0'
    });
    const g = entityIn(parent, {
      id: 'g',
      cls: 'user-group',
      position: '40 0 -10',
      rotation: '0 50 0'
    });
    memberWithBox(g, [6, 0, 8], [10, 2, 12]);
    g.object3D.updateMatrix();
    const expected = new THREE.Vector3(8, 1, 10).applyMatrix4(
      g.object3D.matrix
    );

    const { parentEl, beforeEl, position } = newGroupPlacement(g);

    expect(parentEl).toBe(parent);
    expect(beforeEl).toBe(g);
    expect(position.x).toBeCloseTo(expected.x, 9);
    expect(position.y).toBeCloseTo(expected.y, 9);
    expect(position.z).toBeCloseTo(expected.z, 9);
  });

  it('with a shape, the Starting View or the panorama selected, first at the top level at the origin (fails if any of them anchors the group)', () => {
    const first = entityIn(root, { id: 'first' });
    const shape = entityIn(root, { id: 'shape', position: '5 0 5' });
    shape.setAttribute('shape', '');
    const start = entityIn(root, { id: 'start', position: '0 30 40' });
    start.setAttribute('viewer-start', '');
    const backdrop = entityIn(root, { id: 'pano', cls: 'scene-backdrop' });

    for (const el of [shape, start, backdrop]) {
      expect(newGroupPlacement(el)).toEqual({
        parentEl: root,
        beforeEl: first,
        position: { x: 0, y: 0, z: 0 }
      });
    }
  });

  it('with an item that cannot go into a group selected inside the open group, first in that group at its center (fails if the item anchors the group)', () => {
    const open = entityIn(root, { id: 'open', cls: 'user-group' });
    const member = memberWithBox(open, [2, 0, 2], [4, 2, 4], { id: 'm' });
    const shape = entityIn(open, { id: 'shape-in-group' });
    shape.setAttribute('shape', '');
    scene.openGroups('open');

    const { parentEl, beforeEl, position } = newGroupPlacement(shape);

    expect(parentEl).toBe(open);
    expect(beforeEl).toBe(member);
    expect(position.x).toBeCloseTo(3, 9);
    expect(position.y).toBeCloseTo(1, 9);
    expect(position.z).toBeCloseTo(3, 9);
  });
});

describe('which items can be put into a new group', () => {
  it('answers with fixed values for each kind of item, and as canReparent does for a group beside it (fails if the rule drifts)', () => {
    const make = (id, { attr, cls, parent = root } = {}) => {
      const el = entityIn(parent, { id, cls });
      if (attr) el.setAttribute(attr, '');
      return el;
    };
    const street = make('street', { attr: 'managed-street' });
    const items = {
      model: [make('model'), true],
      street: [street, true],
      segment: [
        make('segment', { attr: 'street-segment', parent: street }),
        false
      ],
      shape: [make('shape', { attr: 'shape' }), false],
      start: [make('start', { attr: 'viewer-start' }), false],
      pano: [make('pano', { cls: 'scene-backdrop' }), false],
      generated: [make('generated', { cls: 'autocreated' }), false],
      pinned: [make('pinned', { attr: 'data-transform-no-reparent' }), false],
      rig: [make('cameraRig'), false]
    };
    const sibling = make('sibling-group', { cls: 'user-group' });
    const environment = make('environment', { parent: scene.sceneEl });
    environment.setAttribute('street-environment', '');
    // An ordinary item whose parent takes no children: only the parent half
    // of the rule refuses it.
    const inModel = make('in-model', { parent: items.model[0] });

    for (const [name, [el, expected]] of Object.entries(items)) {
      expect([name, canWrapInGroup(el)]).toEqual([name, expected]);
      expect([name, canReparent(el, sibling)]).toEqual([name, expected]);
    }
    const keeps = Object.fromEntries(
      Object.entries(items).map(([name, [el]]) => [name, keepsItsParent(el)])
    );
    expect(keeps).toEqual({
      model: false,
      street: false,
      segment: true,
      shape: true,
      start: true,
      pano: true,
      generated: true,
      pinned: true,
      rig: true
    });
    expect(keepsItsParent(environment)).toBe(true);
    expect(canWrapInGroup(environment)).toBe(false);
    expect(keepsItsParent(inModel)).toBe(false);
    expect(canWrapInGroup(inModel)).toBe(false);
    expect(keepsItsParent(root)).toBe(true);
  });
});
