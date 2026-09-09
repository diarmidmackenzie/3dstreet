// Feature flag for the easy-mode move/rotate gizmo.
//
// Default OFF; `?easygizmo=on` turns it on. Decided at load: the URL cannot
// change without a reload, and a consumer that needs the decision frozen
// captures it at module eval, the way `shortcuts.js` captures the WASD flag.
//
// Deliberately without the persisted preference and View-menu entry its nearest
// neighbour (`nav-experimental/flag.js`) carries: that scheme picker exists
// because nav is on by default and users need an opt-out. This feature is off
// by default and has no existing users, so persistence buys nothing and adds a
// reload path to test. It belongs here rather than in the nav module because
// that module's vocabulary is navigation's, and there is no general flag module
// in this repo to join.

export function isEasyGizmo() {
  if (typeof window === 'undefined' || !window.location) return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('easygizmo') === 'on';
}
