// Feature flag for the easy-mode move/rotate gizmo.
//
// Default OFF; `?easygizmo=on` opts in for this load. Consumers capture the
// decision at startup rather than reacting to later History API URL changes.

export function isEasyGizmo() {
  if (typeof window === 'undefined' || !window.location) return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('easygizmo') === 'on';
}
