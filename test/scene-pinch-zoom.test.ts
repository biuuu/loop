import test from 'node:test';
import assert from 'node:assert/strict';
import { createScenePinchZoom } from '../src/client/scene-pinch-zoom';
import { clampZoom, MAX_ZOOM, minZoom } from '../src/client/scene-camera';

function touch(pointerId: number, clientX: number, clientY = 0) {
  return { pointerId, clientX, clientY, pointerType: 'touch' };
}

test('single touches and non-touch inputs retain their room taps', () => {
  const pinch = createScenePinchZoom();
  const first = touch(1, 0);
  const second = touch(2, 100);
  const mouse = { ...second, pointerType: 'mouse' };
  pinch.begin(first, false);
  pinch.begin(mouse, false);
  assert.equal(pinch.move(touch(1, 10), 1), undefined);
  assert.equal(pinch.move(second, 1), undefined);
  assert.equal(pinch.suppressesTap(first), false);
  assert.equal(pinch.suppressesTap(mouse), false);
  pinch.end(first);

  pinch.begin(second, false);
  assert.equal(pinch.move(touch(2, 110), 1), undefined);
  assert.equal(pinch.suppressesTap(second), false);
});

test('pinch zoom follows the changing distance and reverses immediately at either zoom limit', () => {
  const pinch = createScenePinchZoom();
  const first = touch(1, 40, 30);
  pinch.begin(first, false);
  pinch.move(touch(1, 50, 40), 1);
  pinch.begin(touch(2, 50, 140), false);
  assert.equal(pinch.move(touch(2, 50, 250), 1), 2.1);
  let zoom = clampZoom(2.1, 390, 844);
  assert.equal(zoom, MAX_ZOOM);

  const requested = pinch.move(touch(2, 50, 230), zoom)!;
  assert.ok(requested < MAX_ZOOM);
  zoom = clampZoom(pinch.move(touch(2, 50, 41), requested)!, 390, 844);
  assert.equal(zoom, minZoom(390, 844));

  assert.equal(pinch.move(touch(2, 50, 40), zoom), undefined);
  assert.equal(pinch.move(touch(2, 50, 42), zoom), zoom * 2);
});

test('both fingers stay suppressed through their own release in either order', () => {
  const pinch = createScenePinchZoom();
  const first = touch(1, 0);
  const second = touch(2, 100);
  for (const [lifting, remaining] of [
    [first, second],
    [second, first],
  ]) {
    pinch.begin(first, false);
    pinch.begin(second, false);
    assert.equal(pinch.suppressesTap(lifting), true);
    pinch.end(lifting);
    assert.equal(pinch.suppressesTap(lifting), false);
    assert.equal(pinch.suppressesTap(remaining), true);
    assert.equal(pinch.move(remaining, 1), undefined);
    pinch.end(remaining);
    assert.equal(pinch.suppressesTap(remaining), false);
  }

  pinch.begin(first, false);
  assert.equal(pinch.suppressesTap(first), false);
});

test('removing one pinch finger allows a replacement without a zoom jump', () => {
  const pinch = createScenePinchZoom();
  const first = touch(1, 0);
  const second = touch(2, 100);
  const third = touch(3, 200);
  pinch.begin(first, false);
  pinch.begin(second, false);
  pinch.begin(third, false);
  assert.equal(pinch.suppressesTap(third), true);
  assert.equal(pinch.move(third, 1), undefined);
  pinch.end(first);
  assert.equal(pinch.move(touch(3, 210), 1), 1.1);
});

test('a modal interruption or cancellation ends zoom but keeps pending taps suppressed', () => {
  const first = touch(1, 0);
  const second = touch(2, 100);
  const third = touch(3, 200);
  const pinch = createScenePinchZoom();
  pinch.begin(first, false);
  pinch.begin(second, false);
  pinch.end(first, true);
  assert.equal(pinch.suppressesTap(first), false);
  assert.equal(pinch.suppressesTap(second), true);
  pinch.begin(third, false);
  assert.equal(pinch.move(touch(3, 210), 1), undefined);

  pinch.interrupt();
  assert.equal(pinch.suppressesTap(third), true);
  pinch.begin(first, true);
  assert.equal(pinch.suppressesTap(first), true);
  assert.equal(pinch.move(touch(1, 10), 1), undefined);
  pinch.end(first);
  pinch.end(second);
  pinch.end(third);

  pinch.begin(first, false);
  pinch.begin(second, false);
  assert.equal(pinch.move(touch(2, 110), 1), 1.1);
});
