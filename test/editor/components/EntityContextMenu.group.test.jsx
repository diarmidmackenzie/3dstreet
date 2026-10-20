import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import EntityContextMenu from '@/editor/components/scenegraph/EntityContextMenu.jsx';

// The layer row's context menu, with Radix's menu reduced to its items: an
// item is a button that honours `disabled` and calls `onSelect`.
vi.mock('radix-ui', () => {
  /* eslint-disable react/prop-types */
  const Pass = ({ children }) => <div>{children}</div>;
  const Item = ({ children, disabled, onSelect }) => (
    <button type="button" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  );
  /* eslint-enable react/prop-types */
  const ContextMenu = new Proxy(
    {},
    { get: (_, part) => (part === 'Item' ? Item : Pass) }
  );
  return { ContextMenu };
});

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

afterEach(cleanup);

function renderMenu(props) {
  const entity = document.createElement('a-entity');
  render(
    <IntlProvider locale="en" messages={{}}>
      <EntityContextMenu
        entity={entity}
        onSelectEntity={() => {}}
        onRename={() => {}}
        {...props}
      >
        <div>row</div>
      </EntityContextMenu>
    </IntlProvider>
  );
}

describe('the Group item of a layer row menu', () => {
  it('is offered for an item that can go into a group, and choosing it asks for the group (fails if it is missing or does nothing)', () => {
    const onGroup = vi.fn();
    renderMenu({ canGroup: true, onGroup });

    const item = screen.getByRole('button', { name: 'Group' });
    expect(item.disabled).toBe(false);
    fireEvent.click(item);

    expect(onGroup).toHaveBeenCalledTimes(1);
  });

  it('is shown but disabled for an item that cannot (fails if it is hidden or enabled)', () => {
    const onGroup = vi.fn();
    renderMenu({ canGroup: false, onGroup });

    const item = screen.getByRole('button', { name: 'Group' });
    expect(item.disabled).toBe(true);
    fireEvent.click(item);

    expect(onGroup).not.toHaveBeenCalled();
  });
});
