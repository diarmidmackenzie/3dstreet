/**
 * TEMPORARY diagnostic tracing for the easy gizmo. NOT FOR MERGE.
 *
 * Turned on with ?gizmotrace=on, or `window.__gizmoTrace = true` from the
 * console. Every entry is also pushed to window.__gizmoTraceLog so a repro can
 * be copied out in one go with copy(JSON.stringify(__gizmoTraceLog)).
 *
 * The question it exists to answer: when a gesture ends, WHICH reason ended it.
 * A commit and a restore look identical in a video, and the restore reasons
 * (detach, pointercancel, blur, geometrychanged, escape, editorclosed) are what
 * a snap-back would be.
 */

const MAX_ENTRIES = 2000;

let enabled = null;

export function traceEnabled() {
  if (enabled === null) {
    let flagged = false;
    try {
      flagged =
        typeof window !== 'undefined' &&
        !!window.location &&
        new URLSearchParams(window.location.search).get('gizmotrace') === 'on';
    } catch {
      flagged = false;
    }
    enabled = flagged;
  }
  return enabled || (typeof window !== 'undefined' && !!window.__gizmoTrace);
}

/** A short, stable identifier for an entity, for reading a log at a glance. */
export function describeEl(el) {
  if (!el) return null;
  const parts = [];
  if (el.id) parts.push('#' + el.id);
  const mixin = el.getAttribute?.('mixin');
  if (mixin) parts.push(mixin);
  if (el.className) parts.push('.' + String(el.className).split(' ').join('.'));
  if (!parts.length && el.tagName) parts.push(el.tagName.toLowerCase());
  return parts.join(' ');
}

export function trace(tag, data) {
  if (!traceEnabled()) return;
  const entry = { t: Math.round(performance.now()), tag, ...data };
  if (typeof window !== 'undefined') {
    if (!window.__gizmoTraceLog) window.__gizmoTraceLog = [];
    window.__gizmoTraceLog.push(entry);
    if (window.__gizmoTraceLog.length > MAX_ENTRIES) {
      window.__gizmoTraceLog.shift();
    }
  }
  console.log('[gizmotrace]', tag, entry);
}
