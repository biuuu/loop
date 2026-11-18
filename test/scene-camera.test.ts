import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENE, stageSeatXs } from '../src/shared/contracts';
import {
  sceneCamera,
  audienceCamera,
  stageCamera,
  easeCamera,
  reframeCamera,
  screenToWorld,
  worldToScreen,
  clampZoom,
  minZoom,
  DEFAULT_ZOOM,
  MAX_ZOOM,
  stageSeatAt,
  floorTarget,
} from '../src/client/scene-camera';

const catBounds = { left: -58, top: -78, right: 58, bottom: 30 };
const centerX = SCENE.width / 2;
test('audience camera holds its view for small movements and follows only beyond the inner box', () => {
  const safe = { left: 20, top: 90, right: 980, bottom: 540 };
  const base = sceneCamera(1000, 620, 1);
  for (const x of [centerX - 80, centerX, centerX + 80]) {
    const still = audienceCamera(1000, 620, 1, { x, y: 450 }, base, safe);
    assert.deepEqual(still, base);
  }
  const following = audienceCamera(
    1000,
    620,
    1,
    { x: centerX + 230, y: 450 },
    base,
    safe,
  );
  assert.ok(following.x < base.x);
  const reverseWithinBox = audienceCamera(
    1000,
    620,
    1,
    { x: centerX + 200, y: 450 },
    following,
    safe,
  );
  assert.deepEqual(reverseWithinBox, following);
  const edge = audienceCamera(
    1000,
    620,
    1,
    { x: SCENE.walk.right, y: 450 },
    following,
    safe,
  );
  assert.equal(edge.x, 1000 - SCENE.width * edge.scale);
});

test('audience dead zone adapts to portrait view and preserves picking after panning', () => {
  const safe = { left: 16, top: 90, right: 374, bottom: 660 };
  const base = sceneCamera(390, 844, 1);
  const still = audienceCamera(
    390,
    844,
    1,
    { x: centerX + 40, y: 450 },
    base,
    safe,
  );
  assert.equal(still.x, base.x);
  const moving = audienceCamera(
    390,
    844,
    1,
    { x: centerX + 120, y: 450 },
    still,
    safe,
  );
  assert.ok(moving.x < still.x);
  const point = { x: SCENE.walk.right - 10, y: 440 };
  const restored = screenToWorld(worldToScreen(point, moving), moving);
  near(restored.x, point.x);
  near(restored.y, point.y);
  assert.deepEqual(floorTarget(restored), point);
});
function catVisible(
  camera: ReturnType<typeof stageCamera>,
  cat: { x: number; y: number },
  safe: { left: number; top: number; right: number; bottom: number },
) {
  const left = worldToScreen(
    { x: cat.x + catBounds.left, y: cat.y + catBounds.top },
    camera,
  );
  const right = worldToScreen(
    { x: cat.x + catBounds.right, y: cat.y + catBounds.bottom },
    camera,
  );
  assert.ok(left.x >= safe.left - 1e-9);
  assert.ok(left.y >= safe.top - 1e-9);
  assert.ok(right.x <= safe.right + 1e-9);
  assert.ok(right.y <= safe.bottom + 1e-9);
}

test('wide stage seats share composition whenever the full cat is safe', () => {
  for (const [width, height] of [
    [1280, 720],
    [1920, 700],
  ] as const) {
    const safe = { left: 28, top: 92, right: width - 28, bottom: height - 110 };
    const cameras = stageSeatXs(6).map((x) =>
      stageCamera(width, height, 1, { x, y: 255 }, catBounds, safe),
    );
    for (const camera of cameras) {
      near(camera.x, cameras[0]!.x);
      near(camera.y, cameras[0]!.y);
    }
  }
});

test('square and portrait stage views pan only enough to reveal edge-seat cats', () => {
  for (const [width, height] of [
    [700, 700],
    [390, 844],
  ] as const) {
    const safe = { left: 18, top: 95, right: width - 18, bottom: height - 170 };
    const center = sceneCamera(width, height, 1);
    const xs = stageSeatXs(6);
    const left = stageCamera(
      width,
      height,
      1,
      { x: xs[0]!, y: 255 },
      catBounds,
      safe,
    );
    const middle = stageCamera(
      width,
      height,
      1,
      { x: centerX, y: 255 },
      catBounds,
      safe,
    );
    const right = stageCamera(
      width,
      height,
      1,
      { x: xs.at(-1)!, y: 255 },
      catBounds,
      safe,
    );
    assert.ok(left.x > middle.x);
    assert.ok(right.x < middle.x);
    near(middle.x, center.x);
    for (const [camera, x] of [
      [left, xs[0]!],
      [right, xs.at(-1)!],
    ] as const) {
      catVisible(camera, { x, y: 255 }, safe);
      assert.ok(
        camera.x <= 0 && camera.x + SCENE.width * camera.scale >= width,
      );
      const seat = screenToWorld(worldToScreen({ x, y: 255 }, camera), camera);
      assert.equal(stageSeatAt(seat, 6), x === xs[0] ? 0 : 5);
    }
  }
});

test('stage camera stays stable within safe area and clamps to scene edges', () => {
  const safe = { left: 20, top: 90, right: 370, bottom: 700 };
  const center = stageCamera(
    390,
    844,
    1,
    { x: centerX, y: 255 },
    catBounds,
    safe,
  );
  for (const x of [centerX - 20, centerX, centerX + 20]) {
    const camera = stageCamera(390, 844, 1, { x, y: 255 }, catBounds, safe);
    near(camera.x, center.x);
  }
  const edge = stageCamera(390, 844, 1, { x: 0, y: 255 }, catBounds, safe);
  near(edge.x, 0);
  const contained = stageCamera(
    390,
    844,
    minZoom(390, 844),
    { x: 0, y: 255 },
    catBounds,
    safe,
  );
  near(contained.x, (390 - SCENE.width * contained.scale) / 2);
});

test('stage camera eases seat and resize corrections, then settles exactly', () => {
  const safe = { left: 18, top: 95, right: 372, bottom: 674 };
  const left = stageCamera(
    390,
    844,
    1,
    { x: stageSeatXs(6)[0]!, y: 255 },
    catBounds,
    safe,
  );
  const right = stageCamera(
    390,
    844,
    1,
    { x: stageSeatXs(6)[5]!, y: 255 },
    catBounds,
    safe,
  );
  const halfway = easeCamera(left, right, 180);
  assert.ok(halfway.x < left.x && halfway.x > right.x);
  let current = halfway;
  for (let i = 0; i < 80; i++) current = easeCamera(current, right, 16);
  near(current.x, right.x);
  assert.deepEqual(easeCamera(left, right, 16, true), right);
  const resized = stageCamera(
    700,
    700,
    1,
    { x: stageSeatXs(6)[5]!, y: 255 },
    catBounds,
    {
      left: 18,
      top: 90,
      right: 682,
      bottom: 610,
    },
  );
  assert.deepEqual(easeCamera(right, resized, 16), resized);
});

test('resize reframes the old world view before easing toward the new stage goal', () => {
  const old = sceneCamera(390, 844, 1, { x: centerX, y: 255 });
  const resized = reframeCamera(old, 390, 844, 700, 700, 1);
  const oldCenter = screenToWorld({ x: 195, y: 422 }, old);
  const newCenter = screenToWorld({ x: 350, y: 350 }, resized);
  near(newCenter.x, oldCenter.x);
  near(newCenter.y, oldCenter.y);
  const goal = stageCamera(
    700,
    700,
    1,
    { x: stageSeatXs(6)[0]!, y: 255 },
    catBounds,
    {
      left: 18,
      top: 90,
      right: 682,
      bottom: 610,
    },
  );
  const eased = easeCamera(resized, goal, 16);
  assert.ok(Math.abs(eased.x - goal.x) < Math.abs(resized.x - goal.x));
});

const viewports = [
  [390, 844],
  [844, 390],
  [1920, 700],
  [SCENE.width, SCENE.height],
] as const;
const focuses = [
  { x: SCENE.walk.left, y: SCENE.walk.top },
  { x: SCENE.walk.right, y: SCENE.walk.bottom },
  undefined,
];
const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

test('minimum zoom contains and centers the whole room regardless of cat position', () => {
  for (const [width, height] of viewports) {
    const minimum = minZoom(width, height);
    assert.ok(minimum > 0 && minimum <= DEFAULT_ZOOM);
    for (const focus of focuses) {
      const camera = sceneCamera(width, height, minimum, focus);
      near(camera.scale, Math.min(width / SCENE.width, height / SCENE.height));
      assert.ok(camera.x >= -1e-9 && camera.y >= -1e-9);
      assert.ok(camera.x + SCENE.width * camera.scale <= width + 1e-9);
      assert.ok(camera.y + SCENE.height * camera.scale <= height + 1e-9);
      near(camera.x, (width - SCENE.width * camera.scale) / 2);
      near(camera.y, (height - SCENE.height * camera.scale) / 2);
    }
  }
  assert.equal(minZoom(SCENE.width, SCENE.height), 1);
});

test('100% remains the cover baseline and maximum is 125% of cover', () => {
  assert.equal(DEFAULT_ZOOM, 1);
  assert.equal(MAX_ZOOM, 1.25);
  for (const [width, height] of viewports) {
    for (const zoom of [DEFAULT_ZOOM, MAX_ZOOM]) {
      for (const focus of focuses) {
        const camera = sceneCamera(width, height, zoom, focus);
        near(
          camera.scale,
          Math.max(width / SCENE.width, height / SCENE.height) * zoom,
        );
        assert.ok(camera.x <= 1e-9 && camera.y <= 1e-9);
        assert.ok(camera.x + SCENE.width * camera.scale >= width - 1e-9);
        assert.ok(camera.y + SCENE.height * camera.scale >= height - 1e-9);
      }
    }
  }
});

test('between contain and cover the smaller axis centers while the larger follows and clamps', () => {
  for (const [width, height] of viewports.slice(0, 3)) {
    const zoom = (minZoom(width, height) + DEFAULT_ZOOM) / 2;
    const centered = sceneCamera(width, height, zoom, {
      x: centerX,
      y: SCENE.height / 2,
    });
    const corner = sceneCamera(width, height, zoom, { x: 0, y: 0 });
    const farCorner = sceneCamera(width, height, zoom, {
      x: SCENE.width,
      y: SCENE.height,
    });
    near(
      worldToScreen({ x: centerX, y: SCENE.height / 2 }, centered).x,
      width / 2,
    );
    near(
      worldToScreen({ x: centerX, y: SCENE.height / 2 }, centered).y,
      height / 2,
    );
    for (const [axis, viewport, world] of [
      ['x', width, SCENE.width],
      ['y', height, SCENE.height],
    ] as const) {
      const remaining = viewport - world * centered.scale;
      near(corner[axis], remaining > 0 ? remaining / 2 : 0);
      near(farCorner[axis], remaining > 0 ? remaining / 2 : remaining);
    }
  }
});

test('zoom clamps to viewport-dependent minimum, maximum, and default for invalid values', () => {
  for (const [width, height] of viewports) {
    assert.equal(clampZoom(-100, width, height), minZoom(width, height));
    assert.equal(clampZoom(100, width, height), MAX_ZOOM);
    assert.equal(clampZoom(NaN, width, height), DEFAULT_ZOOM);
    assert.equal(clampZoom(Infinity, width, height), DEFAULT_ZOOM);
  }
});

test('resize raises a zoom below the new minimum and preserves valid zoom', () => {
  const portraitMinimum = minZoom(390, 844);
  assert.equal(clampZoom(portraitMinimum, SCENE.width, SCENE.height), 1);
  assert.equal(clampZoom(1.1, 390, 844), 1.1);
  const landscapeZoom = clampZoom(portraitMinimum, 844, 390);
  assert.equal(landscapeZoom, minZoom(844, 390));
  const resized = sceneCamera(844, 390, portraitMinimum, {
    x: SCENE.walk.right,
    y: 555,
  });
  near(resized.scale, 390 / SCENE.height);
  near(resized.x, (844 - SCENE.width * resized.scale) / 2);
  near(resized.y, 0);
});

test('world/screen mappings and stage/floor picking survive zoom and resize', () => {
  for (const [width, height] of viewports) {
    for (const zoom of [minZoom(width, height), DEFAULT_ZOOM, MAX_ZOOM]) {
      const camera = sceneCamera(width, height, zoom, { x: 730, y: 452 });
      for (const point of [
        { x: 780, y: 255 },
        { x: 500, y: 400 },
      ]) {
        const restored = screenToWorld(worldToScreen(point, camera), camera);
        near(restored.x, point.x);
        near(restored.y, point.y);
      }
      for (let capacity = 1; capacity <= 6; capacity++) {
        stageSeatXs(capacity).forEach((x, seat) => {
          const point = screenToWorld(
            worldToScreen({ x, y: 255 }, camera),
            camera,
          );
          assert.equal(stageSeatAt(point, capacity), seat);
        });
      }
      const floor = screenToWorld(
        worldToScreen({ x: 500, y: 400 }, camera),
        camera,
      );
      near(floorTarget(floor)!.x, 500);
      near(floorTarget(floor)!.y, 400);
    }
  }
});

test('gray gutters map outside the world and cannot select a seat or move', () => {
  for (const [width, height] of viewports.slice(0, 3)) {
    const camera = sceneCamera(width, height, minZoom(width, height));
    const gutterPoints =
      camera.x > 1
        ? [
            { x: camera.x / 2, y: height / 2 },
            { x: width - camera.x / 2, y: height / 2 },
          ]
        : [
            { x: width / 2, y: camera.y / 2 },
            { x: width / 2, y: height - camera.y / 2 },
          ];
    for (const screen of gutterPoints) {
      const point = screenToWorld(screen, camera);
      assert.ok(
        point.x < 0 ||
          point.x > SCENE.width ||
          point.y < 0 ||
          point.y > SCENE.height,
      );
      assert.equal(stageSeatAt(point), null);
      assert.equal(floorTarget(point), null);
    }
  }
});

test('stage picking respects stage bounds and floor picking respects walking bounds', () => {
  assert.equal(stageSeatAt({ x: 220, y: 350 }), null);
  assert.equal(stageSeatAt({ x: 138, y: 255 }), null);
  assert.deepEqual(floorTarget({ x: 20, y: 400 }), { x: 75, y: 400 });
  assert.deepEqual(floorTarget({ x: SCENE.width - 1, y: 555 }), {
    x: SCENE.walk.right,
    y: 555,
  });
  assert.equal(floorTarget({ x: 500, y: 556 }), null);
  assert.equal(floorTarget({ x: 500, y: 321 }), null);
});
