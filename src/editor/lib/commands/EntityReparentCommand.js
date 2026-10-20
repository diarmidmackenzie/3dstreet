/* global THREE, STREET */
import Events from '../Events.js';
import { Command } from '../command.js';
import { createUniqueId } from '../entity.jsx';
import { groupMessage } from '../groups/groupMessages.js';
import { localPoseFromWorld } from '../groups/groupTransformMath.js';

// Ids of entities being moved: from the moment the command takes the original
// out of the scene until the element that replaces it has loaded. The layer
// panel refuses to drag such a row, so a second move cannot start from an
// element that is about to be discarded.
const inFlight = new Set();

/** Is a move of the entity with this id still settling? */
export function isReparentInFlight(id) {
  return !!id && inFlight.has(id);
}

let poseScratch = null;
function scratch() {
  poseScratch ??= {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    scale: new THREE.Vector3(),
    euler: new THREE.Euler()
  };
  return poseScratch;
}

const vec3String = (v) => `${v.x} ${v.y} ${v.z}`;

export class EntityReparentCommand extends Command {
  // Deliberately NOT exposed as an LLM tool (no `static llmTool`):
  // agent-driven reparents can produce unexpected scene structure.
  constructor(editor, payload = null) {
    super(editor);

    this.type = 'entityreparent';
    this.name = 'Reparent Entity';
    this.updatable = false;

    if (payload !== null) {
      const entity = payload.entity;
      if (!entity.id) {
        entity.id = createUniqueId();
      }

      this.entityId = entity.id;
      this.newParentEl = payload.parentEl; // this is the id
      // A batch that selects once at the end (wrapping an item in a new
      // group) keeps the selection where it is, as entitycreate does.
      this.noSelectEntity = !!payload.noSelectEntity;
      this.newIndexInParent = payload.indexInParent;

      // Store current state for undo
      this.oldParentEl = entity.parentNode.id;
      this.oldIndexInParent = Array.from(entity.parentNode.children).indexOf(
        entity
      );

      // Serialize using the exact same function the save/load pipeline uses.
      // This is the proven format that createEntityFromObj can recreate
      // losslessly, including correct component dependency resolution. A
      // pending upload is included, marker and all: the save path skips it,
      // but a move must not lose it.
      this.entityData = STREET.utils.getElementData(entity, {
        includeTemporary: true
      });

      // The world pose to keep when the parent changes.
      entity.object3D.updateWorldMatrix(true, false);
      this.worldMatrix = entity.object3D.matrixWorld.clone();
    }
  }

  // Write into `data` the local pose that keeps the entity's world pose under
  // `newParent`. Returns false when no position/rotation/scale can hold it.
  applyLocalPose(data, newParent) {
    const pose = scratch();
    newParent.object3D.updateWorldMatrix(true, false);
    if (
      !localPoseFromWorld(
        newParent.object3D.matrixWorld,
        this.worldMatrix,
        pose
      )
    ) {
      return false;
    }
    pose.euler.setFromQuaternion(pose.quaternion, 'YXZ');
    const toDeg = THREE.MathUtils.radToDeg;
    data.components ??= {};
    data.components.position = vec3String(pose.position);
    data.components.rotation = `${toDeg(pose.euler.x)} ${toDeg(pose.euler.y)} ${toDeg(pose.euler.z)}`;
    data.components.scale = vec3String(pose.scale);
    return true;
  }

  // Replace `entity` with a copy built from `data` inside `parent`, before
  // `beforeEl`. Everything that can be checked is checked before the original
  // leaves the scene; if building the copy still throws, the original goes
  // back where it was, attributes intact, and the user is told. `during`
  // names the step ('execute' or 'undo') for fail().
  replace(entity, data, parent, beforeEl, nextCommandCallback, during) {
    if (!data) {
      this.fail(null, during);
      return undefined;
    }
    const oldParent = entity.parentNode;
    const oldNext = entity.nextSibling;
    // Built on an element made here, so a copy that fails half way can be
    // taken out again.
    const recreated = document.createElement(data.element || 'a-entity');
    data.entityElement = recreated;

    inFlight.add(this.entityId);
    oldParent.removeChild(entity);
    try {
      STREET.utils.createEntityFromObj(data, parent, beforeEl);
    } catch (error) {
      recreated.parentNode?.removeChild(recreated);
      oldParent.insertBefore(entity, oldNext);
      inFlight.delete(this.entityId);
      this.fail(error, during);
      return undefined;
    }

    recreated.addEventListener(
      'loaded',
      () => {
        inFlight.delete(this.entityId);
        recreated.pause();

        Events.emit('entityremoved', entity);
        Events.emit('entitycreated', recreated);

        if (!this.noSelectEntity) {
          this.editor.selectEntity(recreated);
        } else if (
          this.editor.selectedEntity &&
          entity.contains(this.editor.selectedEntity)
        ) {
          // Never leave a removed element, or one inside it, selected.
          this.editor.selectEntity(null);
        }

        nextCommandCallback?.(recreated);
      },
      { once: true }
    );
    return recreated;
  }

  // `during` is 'execute' or 'undo'. The item is left in the parent it had
  // when that step began: the old one after a failed execute, the new one
  // after a failed undo. No later step moves it again; execute and undo only
  // decide whether a batch may carry on.
  fail(error, during) {
    this.failed = true;
    this.failedDuring = during;
    if (error) console.error('Moving the entity failed', error);
    globalThis.STREET?.notify?.errorMessage(groupMessage('reparentFailed'));
  }

  execute(nextCommandCallback) {
    // Nothing to redo. Let a batch carry on, so its later members and its
    // final callback still run.
    if (this.failed) {
      nextCommandCallback?.(null);
      return undefined;
    }
    const entity = document.getElementById(this.entityId);
    if (!entity) return undefined;

    const newParent = document.getElementById(this.newParentEl);
    if (!newParent) {
      console.error(`Parent element with id ${this.newParentEl} not found`);
      return undefined;
    }

    // Deep-clone because createEntityFromObj mutates the data (deletes
    // geometry/material from components). We need the original intact for undo.
    const entityData = JSON.parse(JSON.stringify(this.entityData ?? null));

    // A reorder keeps the saved local pose as it is; recomputing it would only
    // add float noise.
    if (
      entityData &&
      this.newParentEl !== this.oldParentEl &&
      !this.applyLocalPose(entityData, newParent)
    ) {
      this.fail(null, 'execute');
      return undefined;
    }

    // Determine the insertion point. When moving forward within the same
    // parent, removing the entity shifts subsequent siblings left by 1, so
    // we adjust the target index to compensate.
    let adjustedIndex = this.newIndexInParent;
    if (
      this.newParentEl === this.oldParentEl &&
      this.oldIndexInParent < this.newIndexInParent
    ) {
      adjustedIndex--;
    }
    const siblings = Array.from(newParent.children).filter(
      (child) => child !== entity
    );
    const beforeEl =
      adjustedIndex >= 0 && adjustedIndex < siblings.length
        ? siblings[adjustedIndex]
        : null;

    return this.replace(
      entity,
      entityData,
      newParent,
      beforeEl,
      nextCommandCallback,
      'execute'
    );
  }

  undo(nextCommandCallback) {
    if (this.failed) {
      // A move that failed when run left everything where it was, so a batch
      // may undo its other members. One that failed when undone left the item
      // in its new parent, which an earlier member may have made: undoing that
      // member would take the item with it, so the batch stops here.
      if (this.failedDuring === 'execute') nextCommandCallback?.(null);
      return undefined;
    }
    const entity = document.getElementById(this.entityId);
    if (!entity) return undefined;

    const oldParent = this.oldParentEl
      ? document.getElementById(this.oldParentEl)
      : null;
    if (!oldParent) {
      console.error(
        `Original parent element with id ${this.oldParentEl} not found`
      );
      return undefined;
    }

    // The saved data holds the original local pose, so it is recreated as is.
    const siblings = Array.from(oldParent.children).filter(
      (child) => child !== entity
    );
    const beforeEl =
      this.oldIndexInParent >= 0 && this.oldIndexInParent < siblings.length
        ? siblings[this.oldIndexInParent]
        : null;

    return this.replace(
      entity,
      JSON.parse(JSON.stringify(this.entityData ?? null)),
      oldParent,
      beforeEl,
      nextCommandCallback,
      'undo'
    );
  }
}
