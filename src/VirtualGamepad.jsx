import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dispatchGamepadKey } from './easyrpgBridge.js';

const KEY_BINDINGS = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  a: 'K',
  b: 'X',
  start: 'Z',
};

const DPAD_DIRECTIONS = ['up', 'down', 'left', 'right'];

export default function VirtualGamepad({ visible = true }) {
  const [activeKeys, setActiveKeys] = useState(() => new Set());
  const dpadRef = useRef(null);
  const pointerIdRef = useRef(null);
  const activeKeysRef = useRef(activeKeys);

  useEffect(() => {
    activeKeysRef.current = activeKeys;
  }, [activeKeys]);

  const setKeyPressed = useCallback((action, pressed) => {
    const key = KEY_BINDINGS[action];
    if (!key) {
      return;
    }

    setActiveKeys((current) => {
      const next = new Set(current);
      const isPressed = next.has(action);
      if (pressed === isPressed) {
        return current;
      }

      if (pressed) {
        next.add(action);
      } else {
        next.delete(action);
      }

      dispatchGamepadKey(key, pressed);
      return next;
    });
  }, []);

  const releaseActions = useCallback((actions) => {
    actions.forEach((action) => setKeyPressed(action, false));
  }, [setKeyPressed]);

  const updateDpadFromPointer = useCallback((event) => {
    const node = dpadRef.current;
    if (!node) {
      return;
    }

    const rect = node.getBoundingClientRect();
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    const deadZone = Math.min(rect.width, rect.height) * 0.13;
    const next = new Set();

    if (Math.abs(x) > deadZone || Math.abs(y) > deadZone) {
      if (Math.abs(x) >= deadZone) {
        next.add(x < 0 ? 'left' : 'right');
      }

      if (Math.abs(y) >= deadZone) {
        next.add(y < 0 ? 'up' : 'down');
      }
    }

    DPAD_DIRECTIONS.forEach((direction) => {
      setKeyPressed(direction, next.has(direction));
    });
  }, [setKeyPressed]);

  const handleDpadPointerDown = useCallback((event) => {
    event.preventDefault();
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateDpadFromPointer(event);
  }, [updateDpadFromPointer]);

  const handleDpadPointerMove = useCallback((event) => {
    if (pointerIdRef.current !== event.pointerId) {
      return;
    }

    event.preventDefault();
    updateDpadFromPointer(event);
  }, [updateDpadFromPointer]);

  const handleDpadPointerEnd = useCallback((event) => {
    if (pointerIdRef.current !== event.pointerId) {
      return;
    }

    pointerIdRef.current = null;
    releaseActions(DPAD_DIRECTIONS);
  }, [releaseActions]);

  const createButtonHandlers = useCallback((action) => ({
    onPointerDown: (event) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setKeyPressed(action, true);
    },
    onPointerUp: (event) => {
      event.preventDefault();
      setKeyPressed(action, false);
    },
    onPointerCancel: () => setKeyPressed(action, false),
    onPointerLeave: (event) => {
      if (event.buttons === 0) {
        setKeyPressed(action, false);
      }
    },
  }), [setKeyPressed]);

  useEffect(() => {
    if (visible) {
      return undefined;
    }

    releaseActions([...activeKeysRef.current]);
    return undefined;
  }, [visible, releaseActions]);

  useEffect(() => () => {
    releaseActions([...activeKeysRef.current]);
  }, [releaseActions]);

  const dpadClassName = useMemo(() => {
    const parts = ['dpad'];
    activeKeys.forEach((action) => {
      if (DPAD_DIRECTIONS.includes(action)) {
        parts.push(`is-${action}`);
      }
    });
    return parts.join(' ');
  }, [activeKeys]);

  if (!visible) {
    return null;
  }

  return (
    <div className="virtual-gamepad" aria-label="仮想ゲームパッド">
      <div
        ref={dpadRef}
        className={dpadClassName}
        role="group"
        aria-label="スライド式十字キー"
        onPointerDown={handleDpadPointerDown}
        onPointerMove={handleDpadPointerMove}
        onPointerUp={handleDpadPointerEnd}
        onPointerCancel={handleDpadPointerEnd}
      >
        <span className="dpad-arm dpad-up" />
        <span className="dpad-arm dpad-right" />
        <span className="dpad-arm dpad-down" />
        <span className="dpad-arm dpad-left" />
        <span className="dpad-thumb" />
      </div>

      <div className="action-cluster" aria-label="アクションボタン">
        <button
          type="button"
          className={`pad-button pad-button-b ${activeKeys.has('b') ? 'is-active' : ''}`}
          aria-label="B button"
          {...createButtonHandlers('b')}
        >
          B
        </button>
        <button
          type="button"
          className={`pad-button pad-button-a ${activeKeys.has('a') ? 'is-active' : ''}`}
          aria-label="A button"
          {...createButtonHandlers('a')}
        >
          A
        </button>
        <button
          type="button"
          className={`start-button ${activeKeys.has('start') ? 'is-active' : ''}`}
          aria-label="START button"
          {...createButtonHandlers('start')}
        >
          START
        </button>
      </div>
    </div>
  );
}
