/* global VERSION */
/**
 * TEMPORARY diagnostic tracing for the easy gizmo. NOT FOR MERGE.
 *
 * Turned on with ?gizmotrace=on in the URL, before the #. Everything is kept
 * in window.__gizmoTraceLog, which copies out in one go with
 * copy(JSON.stringify(__gizmoTraceLog)). ?gizmotrace=verbose also writes each
 * entry to the console; that is off by default because a console write per
 * event changes the timing of the very races this is meant to catch.
 *
 * The log holds:
 * - `build`: the build it came from;
 * - `gestures`: one record per drag, from press to end, with the reason it
 *   ended and whether it committed or reverted (the last 20);
 * - `attaches`: what the gizmo found when it attached to an entity, and again
 *   when that entity's model loaded (the last 20);
 * - `events`: everything else, in order (the last 500).
 *
 * Every entry carries `t` (performance.now(), unrounded) and `seq`, a single
 * counter across all three lists, so their order can be interleaved.
 *
 * Payloads are passed as functions and only called while tracing is on, so
 * with it off none of the capture code runs. A payload that throws is recorded
 * as a failure rather than breaking the gizmo.
 */

export const TRACE_LIMITS = { gestures: 20, attaches: 20, events: 500 };

let mode = null;
let seq = 0;

function readMode() {
  if (mode === null) {
    let value = null;
    try {
      value = new URLSearchParams(window.location.search).get('gizmotrace');
    } catch {
      value = null;
    }
    mode = value === 'on' || value === 'verbose' ? value : 'off';
  }
  return mode;
}

export function traceEnabled() {
  return readMode() !== 'off';
}

/** Forget the cached flag, the counter and the log. For tests. */
export function resetTrace() {
  mode = null;
  seq = 0;
  if (typeof window !== 'undefined') delete window.__gizmoTraceLog;
}

function theLog() {
  if (!window.__gizmoTraceLog) {
    window.__gizmoTraceLog = {
      build: typeof VERSION !== 'undefined' ? VERSION : 'unknown',
      gestures: [],
      attaches: [],
      events: []
    };
  }
  return window.__gizmoTraceLog;
}

function stamp(tag, makePayload) {
  const entry = { seq: ++seq, t: performance.now(), tag };
  try {
    Object.assign(entry, makePayload ? makePayload() : null);
  } catch (error) {
    entry.payloadError = String((error && error.message) || error);
  }
  return entry;
}

function push(list, entry, cap) {
  list.push(entry);
  if (list.length > cap) list.splice(0, list.length - cap);
}

function echo(entry) {
  if (mode === 'verbose') console.log('[gizmotrace]', entry.tag, entry);
}

/** One event, into the rolling event list. */
export function trace(tag, makePayload) {
  if (!traceEnabled()) return;
  const entry = stamp(tag, makePayload);
  push(theLog().events, entry, TRACE_LIMITS.events);
  echo(entry);
}

/**
 * Start a record in `gestures` or `attaches` and hand it back, so later stages
 * can be added to it with `traceStage`. Returns null with tracing off.
 */
export function traceRecord(list, tag, makePayload) {
  if (!traceEnabled()) return null;
  const entry = stamp(tag, makePayload);
  push(theLog()[list], entry, TRACE_LIMITS[list]);
  echo(entry);
  return entry;
}

/** Add a timestamped stage to a record started with `traceRecord`. */
export function traceStage(record, key, makePayload) {
  if (!record || !traceEnabled()) return;
  record[key] = stamp(key, makePayload);
  echo(record[key]);
}

/** A short, stable identifier for an entity, for reading a log at a glance. */
export function describeEl(el) {
  if (!el) return null;
  const parts = [];
  if (el.id) parts.push('#' + el.id);
  const mixin = el.getAttribute?.('mixin');
  if (mixin) parts.push(mixin);
  if (el.className && typeof el.className === 'string') {
    parts.push('.' + el.className.trim().split(/\s+/).join('.'));
  }
  if (!parts.length && el.tagName) parts.push(el.tagName.toLowerCase());
  return parts.join(' ');
}

export function vectorOf(v) {
  return v ? [v.x, v.y, v.z] : null;
}

/**
 * What the bounding-box derivation will find on an object, read without
 * changing anything: which source it takes, and every mesh the traverse would
 * visit. Mirrors deriveLocalBoxOf, and must be read BEFORE it runs, because
 * that computes the boxes this reports as missing.
 */
export function describeBoxSources(object) {
  if (!object) return { boxSource: 'none', meshes: [] };
  const cached = object._batchLocalBbox;
  if (cached && !cached.isEmpty()) {
    return { boxSource: 'batch-cache', meshes: [] };
  }
  const meshes = [];
  object.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    if (meshes.length >= 50) return;
    meshes.push({
      type: node.type,
      ownBox:
        node.boundingBox === undefined
          ? 'none'
          : node.boundingBox === null
            ? 'uncomputed'
            : 'computed',
      hadGeometryBox: !!node.geometry.boundingBox
    });
  });
  return {
    boxSource: meshes.length ? 'traverse' : 'traverse-empty',
    meshes
  };
}
