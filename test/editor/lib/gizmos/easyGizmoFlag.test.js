import { describe, it, expect, afterEach } from 'vitest';
import { isEasyGizmo } from '@/editor/lib/gizmos/easyGizmoFlag.js';

const original = window.location.search;

function withSearch(search) {
  window.history.replaceState(null, '', `${window.location.pathname}${search}`);
}

afterEach(() => {
  withSearch(original);
});

describe('the easy-gizmo flag', () => {
  it('is off by default, which is what makes the whole feature inert', () => {
    withSearch('');
    expect(isEasyGizmo()).toBe(false);
  });

  it('is on with the query parameter', () => {
    withSearch('?easygizmo=on');
    expect(isEasyGizmo()).toBe(true);
  });

  it('stays off for any other value, so a typo does not enable it', () => {
    withSearch('?easygizmo=true');
    expect(isEasyGizmo()).toBe(false);
    withSearch('?easygizmo=off');
    expect(isEasyGizmo()).toBe(false);
  });

  it('survives having no window at all', () => {
    // The module is imported by plain modules that are also evaluated outside a
    // browser, so a bare read of window.location would throw at import time.
    const saved = global.window;
    try {
      global.window = undefined;
      expect(isEasyGizmo()).toBe(false);
    } finally {
      global.window = saved;
    }
  });
});
