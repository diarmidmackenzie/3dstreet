import { useEffect, useState } from 'react';
import { DropdownMenu } from 'radix-ui';
import classNames from 'classnames';
import { useIntl } from 'react-intl';
import Events from '../../../lib/Events';
import styles from './ActionBar.module.scss';
import '../../../style/AppMenu.scss';
import {
  Rotate24Icon,
  Translate24Icon,
  EasyTransform24Icon
} from '@shared/icons';

/**
 * The transform-mode control, collapsed into one button with a flyout, so a
 * third mode can be added without a third slot on a bottom-centred dock.
 *
 * Styled with the app menu's own classes, which the entity context menu already
 * reuses for the same reason: two menus in one editor should look like one
 * thing.
 */

const ICONS = {
  translate: Translate24Icon,
  rotate: Rotate24Icon,
  easy: EasyTransform24Icon
};

const TransformModeMenu = ({
  transformMode,
  changeTransformMode,
  inapplicable
}) => {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  // `transformMode` has four reachable values: the hand and shape tools both
  // set it to 'off', and 'scale' is reachable from the keyboard, and both
  // overwrite the one field — so there is no "last transform mode" anywhere to
  // draw. The trigger keeps the last mode it CAN represent and shows it
  // un-highlighted in the other two, because a blanked trigger in the state
  // after two of the commonest toolbar clicks reads as a broken control, and
  // "not highlighted" already means "not currently active" everywhere else on
  // this bar.
  const [lastMode, setLastMode] = useState('translate');

  useEffect(() => {
    if (ICONS[transformMode]) setLastMode(transformMode);
  }, [transformMode]);

  useEffect(() => {
    // Not the outside press: a selection can arrive from the layers panel, from
    // the AI chat or from an undo, none of which is a click on this menu.
    const close = () => setOpen(false);
    Events.on('objectselect', close);
    return () => {
      Events.off('objectselect', close);
    };
  }, []);

  // Escape closes the flyout on KEYDOWN, while the editor's deselect runs on
  // keyup — different phases, so the dismissal cannot suppress it, and backing
  // out of the menu would throw away the selection the user opened it to
  // transform. Swallow exactly the one keyup that follows.
  const onEscapeKeyDown = () => {
    const swallow = (event) => {
      window.removeEventListener('keyup', swallow, true);
      if (event.key === 'Escape') event.stopPropagation();
    };
    window.addEventListener('keyup', swallow, true);
  };

  const Icon = ICONS[lastMode] || Translate24Icon;
  const items = [
    {
      mode: 'translate',
      shortcut: 't',
      label: intl.formatMessage({
        id: 'actionBar.transformMenu.translate',
        defaultMessage: 'Move'
      })
    },
    {
      mode: 'rotate',
      shortcut: 'e',
      label: intl.formatMessage({
        id: 'actionBar.transformMenu.rotate',
        defaultMessage: 'Rotate'
      })
    },
    {
      mode: 'easy',
      shortcut: 'm',
      label: intl.formatMessage({
        id: 'actionBar.transformMenu.easy',
        defaultMessage: 'Move and rotate'
      })
    }
  ];

  return (
    // Explicitly non-modal. A modal menu puts pointer-events: none on the rest
    // of the document and consumes the dismissing outside press, so selecting an
    // object while this is open would cost two clicks — and this is the first
    // menu in the editor whose dismissal region is the viewport.
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={classNames({
            [styles.active]: !!ICONS[transformMode],
            // Mode is TOOL state, not per-object state: the button stays
            // clickable with a non-transformable entity selected and dims to
            // say the current selection will not be acted on. The gizmo layer
            // independently refuses to attach to such an entity.
            [styles.inapplicable]: inapplicable
          })}
          title={intl.formatMessage({
            id: 'actionBar.transformTool',
            defaultMessage:
              'Transform Tool - move and rotate the selected object'
          })}
        >
          <Icon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="MenubarContent"
          side="top"
          align="center"
          sideOffset={8}
          onEscapeKeyDown={onEscapeKeyDown}
        >
          {items.map((item) => {
            const ItemIcon = ICONS[item.mode];
            return (
              <DropdownMenu.Item
                key={item.mode}
                className="MenubarItem"
                onSelect={() => changeTransformMode(item.mode)}
              >
                <ItemIcon />
                <span className={styles.menuLabel}>{item.label}</span>
                <div className="RightSlot">{item.shortcut}</div>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};

export { TransformModeMenu };
