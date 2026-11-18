import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createKeyboardMovement,
  movementPosition,
  type Direction,
} from '../src/client/keyboard-movement';

const key = (code: string, key = code) => ({ code, key });
const right = key('KeyD', 'd');
const left = key('KeyA', 'a');
const up = key('KeyW', 'w');
const arrowUp = key('ArrowUp');
function fixture() {
  const actions: (Direction | 'stop')[] = [];
  const keyboard = createKeyboardMovement({
    sendDirection: (direction) => actions.push(direction),
    stop: () => actions.push('stop'),
  });
  return { keyboard, actions };
}

test('fresh key press emits one semantic direction; holds never resend', () => {
  const f = fixture();
  assert.equal(f.keyboard.press(right), true);
  for (let elapsed = 0; elapsed <= 1500; elapsed += 100)
    assert.equal(f.keyboard.press({ ...right, repeat: true }), true);
  assert.deepEqual(f.actions, ['right']);
  f.keyboard.release(right);
  assert.deepEqual(f.actions, ['right', 'stop']);
});

test('last pressed cardinal direction wins; releasing it resumes the earlier held direction', () => {
  const f = fixture();
  f.keyboard.press(right);
  f.keyboard.press(up);
  f.keyboard.press(left);
  f.keyboard.release(left);
  f.keyboard.release(up);
  f.keyboard.release(right);
  assert.deepEqual(f.actions, ['right', 'up', 'left', 'up', 'right', 'stop']);
});

test('aliases do not restart movement or stop until all same-direction keys release', () => {
  const f = fixture();
  f.keyboard.press(up);
  f.keyboard.press(arrowUp);
  f.keyboard.release(up);
  assert.deepEqual(f.actions, ['up']);
  f.keyboard.release(arrowUp);
  assert.deepEqual(f.actions, ['up', 'stop']);
});

test('reset stops only owned movement and consumes repeats until a fresh press', () => {
  const f = fixture();
  f.keyboard.reset();
  f.keyboard.release(right);
  assert.deepEqual(f.actions, []);
  f.keyboard.press(right);
  f.keyboard.reset();
  f.keyboard.reset();
  f.keyboard.release(right);
  assert.equal(f.keyboard.press({ ...right, repeat: true }), true);
  assert.deepEqual(f.actions, ['right', 'stop']);
  f.keyboard.press(right);
  f.keyboard.reset(false);
  f.keyboard.release(right);
  assert.deepEqual(f.actions, ['right', 'stop', 'right']);
});

test('idle or unrelated keyup never invokes stop or cancels pointer movement', () => {
  const f = fixture();
  assert.equal(f.keyboard.release(left), false);
  assert.equal(f.keyboard.release({ key: 'Enter' }), false);
  f.keyboard.reset();
  assert.deepEqual(f.actions, []);
  f.keyboard.press(right);
  f.keyboard.release(up);
  assert.deepEqual(f.actions, ['right']);
});

test('physical codes win over key labels, with uppercase and unidentified-key fallback', () => {
  const f = fixture();
  assert.equal(f.keyboard.press(key('KeyW', 'z')), true);
  f.keyboard.reset(false);
  assert.equal(f.keyboard.press({ key: 'D' }), true);
  f.keyboard.release({ key: 'd' });
  assert.equal(f.keyboard.press(key('Unidentified', 'A')), true);
  assert.equal(f.keyboard.press(key('KeyQ', 'w')), false);
  assert.equal(f.keyboard.press({ key: 'Enter' }), false);
  assert.deepEqual(f.actions, ['up', 'right', 'stop', 'left']);
});

test('interpolation clamps before/after a segment and treats zero duration as arrived', () => {
  const movement = {
    x: 500,
    y: 450,
    targetX: 925,
    targetY: 450,
    movingSince: 1000,
    durationMs: 1000,
  };
  assert.deepEqual(movementPosition(movement, 0), { x: 500, y: 450 });
  assert.deepEqual(movementPosition(movement, 1500), { x: 712.5, y: 450 });
  assert.deepEqual(movementPosition(movement, 3000), { x: 925, y: 450 });
  assert.deepEqual(movementPosition({ ...movement, durationMs: 0 }, 0), {
    x: 925,
    y: 450,
  });
});
