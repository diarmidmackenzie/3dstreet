/* global THREE */
// TEMP diagnostics (not for merge): tests for the gizmo trace.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EasyGizmoControls } from '@/editor/lib/gizmos/EasyGizmoControls.js';
import {
  TRACE_LIMITS,
  resetTrace,
  trace,
  traceRecord,
  traceStage
} from '@/editor/lib/gizmos/easyGizmoTrace.js';

const fixtures = [];

function setFlag(value) {
  window.history.replaceState(null, '', value ? `/?gizmotrace=${value}` : '/');
  resetTrace();
}

beforeEach(() => setFlag(null));
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.controls.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  setFlag(null);
});

function fixture() {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  canvas.getBoundingClientRect = () => ({
    width: 1200,
    height: 800,
    left: 0,
    top: 0
  });
  Object.defineProperty(canvas, 'clientHeight', { value: 800 });
  vi.stubGlobal('AFRAME', { INSPECTOR: { opened: true, container: canvas } });
  const sceneEl = document.createElement('div');
  document.body.append(sceneEl);
  sceneEl.object3D = new THREE.Scene();
  sceneEl.time = 0;
  const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 1000);
  camera.position.set(0, 10, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const el = document.createElement('div');
  sceneEl.append(el);
  const object = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 1, 0.2),
    new THREE.MeshBasicMaterial()
  );
  mesh.position.y = 0.5;
  object.add(mesh);
  object.el = el;
  el.object3D = object;
  const nativeGet = el.getAttribute.bind(el);
  const nativeSet = el.setAttribute.bind(el);
  el.getAttribute = (name) =>
    name === 'position'
      ? { x: object.position.x, y: object.position.y, z: object.position.z }
      : name === 'rotation'
        ? {
            x: THREE.MathUtils.radToDeg(object.rotation.x),
            y: THREE.MathUtils.radToDeg(object.rotation.y),
            z: THREE.MathUtils.radToDeg(object.rotation.z)
          }
        : nativeGet(name);
  el.setAttribute = (name, value) => {
    if (name === 'position') object.position.set(value.x, value.y, value.z);
    else if (name === 'rotation') {
      object.rotation.set(
        THREE.MathUtils.degToRad(value.x),
        THREE.MathUtils.degToRad(value.y),
        THREE.MathUtils.degToRad(value.z)
      );
    } else nativeSet(name, value);
    object.updateMatrixWorld(true);
  };
  el.getObject3D = () => undefined;
  sceneEl.object3D.add(object);
  const controls = new EasyGizmoControls(camera, canvas, sceneEl);
  new THREE.Scene().add(controls);
  const f = { canvas, sceneEl, camera, el, object, mesh, controls };
  f.frame = () => {
    sceneEl.time += 16;
    sceneEl.object3D.updateMatrixWorld(true);
    controls.updateMatrixWorld(true);
  };
  f.attach = () => {
    controls.attach(el);
    f.frame();
  };
  f.pointer = (type, world) => {
    const point = world.clone().project(camera);
    const event = new MouseEvent(type, {
      clientX: (point.x + 1) * 600,
      clientY: (1 - point.y) * 400,
      button: 0,
      bubbles: true,
      cancelable: true
    });
    Object.defineProperties(event, {
      pointerType: { value: 'mouse' },
      pointerId: { value: 1 },
      isPrimary: { value: true }
    });
    canvas.dispatchEvent(event);
  };
  f.start = () => {
    f.pointer('pointerdown', controls.moveGroup.position.clone());
    expect(controls.isDragging).toBe(true);
  };
  fixtures.push(f);
  return f;
}

const theLog = () => window.__gizmoTraceLog;

describe('the gizmo trace buffers', () => {
  it('keeps only the most recent entries of each kind', () => {
    setFlag('on');
    for (let i = 0; i < TRACE_LIMITS.events + 100; i++) {
      trace('e', () => ({ i }));
    }
    for (let i = 0; i < TRACE_LIMITS.gestures + 5; i++) {
      traceRecord('gestures', 'g', () => ({ i }));
    }
    for (let i = 0; i < TRACE_LIMITS.attaches + 5; i++) {
      traceRecord('attaches', 'a', () => ({ i }));
    }
    const log = theLog();
    expect(log.events).toHaveLength(TRACE_LIMITS.events);
    expect(log.events[0].i).toBe(100);
    expect(log.gestures).toHaveLength(TRACE_LIMITS.gestures);
    expect(log.gestures[0].i).toBe(5);
    expect(log.attaches).toHaveLength(TRACE_LIMITS.attaches);
  });

  it('numbers every entry in one sequence, with an unrounded time', () => {
    setFlag('on');
    vi.spyOn(performance, 'now').mockReturnValue(12.345);
    trace('a');
    const record = traceRecord('gestures', 'g');
    traceStage(record, 'end', () => ({ outcome: 'x' }));
    trace('b');
    const log = theLog();
    expect(log.events.map((e) => e.seq)).toEqual([1, 4]);
    expect(record.seq).toBe(2);
    expect(record.end.seq).toBe(3);
    expect(record.end.t).toBe(12.345);
  });

  it('records a payload that throws instead of throwing', () => {
    setFlag('on');
    expect(() =>
      trace('bad', () => {
        throw new Error('boom');
      })
    ).not.toThrow();
    expect(theLog().events[0].payloadError).toBe('boom');
  });

  it('does nothing at all with the flag off', () => {
    const payload = vi.fn(() => ({}));
    const log = vi.spyOn(console, 'log');
    trace('e', payload);
    const record = traceRecord('gestures', 'g', payload);
    traceStage(record, 'end', payload);
    expect(record).toBeNull();
    expect(payload).not.toHaveBeenCalled();
    expect(theLog()).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it('writes to the console only when verbose', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    setFlag('on');
    trace('quiet');
    expect(log).not.toHaveBeenCalled();
    setFlag('verbose');
    trace('loud');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('round-trips through JSON', () => {
    setFlag('on');
    const f = fixture();
    f.attach();
    f.start();
    f.controls.detach();
    const log = theLog();
    expect(log.gestures).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
  });
});

describe('what the gizmo records', () => {
  for (const flag of [null, 'on']) {
    it(`re-derives the box when the model loads, trace ${flag || 'off'}`, () => {
      setFlag(flag);
      const f = fixture();
      f.attach();
      f.mesh.geometry = new THREE.BoxGeometry(2, 3, 2);
      expect(() => f.el.dispatchEvent(new Event('model-loaded'))).not.toThrow();
      expect(f.controls.localBox.max.y).toBeCloseTo(0.5 + 1.5, 6);
      if (!flag) {
        expect(theLog()).toBeUndefined();
        return;
      }
      const changed = theLog().events.find(
        (e) => e.tag === 'geometrychanged' && e.type === 'model-loaded'
      );
      expect(changed).toBeDefined();
      expect(changed.isSelf).toBe(true);
      const attaches = theLog().attaches;
      expect(attaches.map((a) => a.tag)).toEqual(['attach', 'model-loaded']);
      expect(attaches[1].boxSource).toBe('traverse');
      expect(attaches[1].meshes[0].type).toBe('Mesh');
      expect(attaches[1].derived.derivedNull).toBe(false);
      // Each record's placement is taken at the first layout after it: the
      // base moves down once the taller box is known.
      expect(attaches[0].placement.baseY).toBe(0);
      f.frame();
      expect(attaches[1].placement.baseY).toBeCloseTo(-1, 6);
      expect(attaches[1].placement.moveHandleWorld[1]).toBeCloseTo(-1, 6);
    });
  }

  it('marks a gesture ended by a detach as restored, after the detach', () => {
    setFlag('on');
    const f = fixture();
    f.attach();
    f.start();
    f.pointer('pointermove', new THREE.Vector3(1, 0, 0));
    f.frame();
    f.controls.detach();
    const [gesture] = theLog().gestures;
    expect(gesture.press.pointerId).toBe(1);
    expect(gesture.end.reason).toBe('detach');
    expect(gesture.end.outcome).toBe('restored');
    const detach = theLog().events.find((e) => e.tag === 'detach');
    expect(detach.seq).toBeLessThan(gesture.end.seq);
    expect(detach.parentChanged).toBe(false);
  });

  it('marks a release where the object did not move as unchanged', () => {
    setFlag('on');
    const f = fixture();
    f.attach();
    const at = f.controls.moveGroup.position.clone();
    f.start();
    f.pointer('pointerup', at);
    f.frame();
    const [gesture] = theLog().gestures;
    expect(gesture.end.reason).toBe('pointerup');
    expect(gesture.end.outcome).toBe('unchanged');
    const up = theLog().events.find((e) => e.tag === 'pointerup');
    expect(up).toMatchObject({ owned: true, deferred: true });
    expect(
      theLog().events.find((e) => e.tag === 'releaseconsumed').seq
    ).toBeGreaterThan(up.seq);
  });

  it('notices an entity re-parented under a drag', () => {
    setFlag('on');
    const f = fixture();
    f.attach();
    f.start();
    const newParent = document.createElement('div');
    f.sceneEl.append(newParent);
    newParent.append(f.el);
    f.controls.detach();
    const detach = theLog().events.find((e) => e.tag === 'detach');
    expect(detach.parentChanged).toBe(true);
  });
});
