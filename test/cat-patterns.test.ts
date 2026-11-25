import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAT_PATTERN_PATCHES,
  getPatternMask,
  type CatPattern,
} from '../src/client/cat-patterns';
import { CAT_ANIMATIONS, type CatAnimation } from '../src/client/cat-sprite';
import { recolorCatPixels } from '../src/client/cat-appearance';
import { sourcePixels, frameIndex, frameRgb } from './helpers/cat-source';

const source = sourcePixels();
const main = 0xfb8c00;
const shadow = 0xef6c00;
const ink = 0x482a00;
const socks = recolorCatPixels(source, { coat: 'orange', pattern: 'socks' });
const tabby = recolorCatPixels(source, { coat: 'orange', pattern: 'tabby' });
const marked = (
  pattern: CatPattern,
  animation: CatAnimation,
  frame: number,
  x: number,
  y: number,
) => {
  const expected =
    pattern === 'tabby'
      ? 0xc85c00
      : frameRgb(source, animation, frame, x, y) === shadow
        ? 0xe8dbc8
        : 0xfff7e9;
  assert.ok(
    [main, shadow].includes(frameRgb(source, animation, frame, x, y)),
    `source coat at ${animation}/${frame}/${x},${y}`,
  );
  assert.equal(
    frameRgb(pattern === 'socks' ? socks : tabby, animation, frame, x, y),
    expected,
    `${pattern} at ${animation}/${frame}/${x},${y}`,
  );
};
const unmarked = (
  pattern: CatPattern,
  animation: CatAnimation,
  frame: number,
  x: number,
  y: number,
) => {
  assert.equal(
    frameRgb(pattern === 'socks' ? socks : tabby, animation, frame, x, y),
    frameRgb(source, animation, frame, x, y),
    `unmarked ${pattern} at ${animation}/${frame}/${x},${y}`,
  );
};

test('all 45 source frames have bounded anatomical patches that select only actual coat pixels', () => {
  assert.deepEqual(
    Object.keys(CAT_PATTERN_PATCHES).sort(),
    Object.keys(CAT_ANIMATIONS).sort(),
  );
  let frames = 0;
  for (const animation of Object.keys(CAT_ANIMATIONS) as CatAnimation[]) {
    assert.equal(
      CAT_PATTERN_PATCHES[animation].length,
      CAT_ANIMATIONS[animation].frames,
    );
    for (let frame = 0; frame < CAT_ANIMATIONS[animation].frames; frame++) {
      frames++;
      for (const pattern of ['socks', 'tabby'] as const) {
        const patches = CAT_PATTERN_PATCHES[animation][frame]![pattern];
        assert.ok(patches.length > 0);
        const mask = getPatternMask(pattern, animation, frame);
        assert.equal(mask.length, 4096);
        let selected = 0;
        for (const patch of patches) {
          assert.ok(
            [
              'bib',
              'frontPaw',
              'rearPaw',
              'forehead',
              'flank',
              'back',
            ].includes(patch.part),
          );
          assert.equal(
            Number.isInteger(patch.x) && Number.isInteger(patch.y),
            true,
          );
          assert.ok(patch.x >= 0 && patch.y >= 0 && patch.rows.length > 0);
          const width = patch.rows[0]!.length;
          assert.ok(
            width > 0 &&
              patch.x + width <= 64 &&
              patch.y + patch.rows.length <= 64,
          );
          for (const row of patch.rows) {
            assert.equal(row.length, width);
            assert.match(row, /^[#.]+$/);
          }
        }
        for (let y = 0; y < 64; y++)
          for (let x = 0; x < 64; x++) {
            const value = mask[y * 64 + x]!;
            assert.ok(value === 0 || value === 1);
            if (!value) continue;
            selected++;
            const index = frameIndex(animation, frame, x, y);
            assert.equal(
              source[index + 3],
              255,
              `${pattern}/${animation}/${frame}/${x},${y} alpha`,
            );
            assert.ok(
              [main, shadow].includes(frameRgb(source, animation, frame, x, y)),
              `${pattern}/${animation}/${frame}/${x},${y} is coat`,
            );
          }
        assert.ok(selected > 0 && selected < 64);
      }
    }
  }
  assert.equal(frames, 45);
});

test('paw grooming preserves the tongue and white paw tips while forehead stripes follow the lift', () => {
  const tongue = 0xe84e40;
  const poses = [
    { ear: 31, tongueRows: [] },
    { ear: 31, tongueRows: [40] },
    { ear: 30, tongueRows: [39, 40] },
    { ear: 30, tongueRows: [39, 40] },
  ];
  for (const [frame, { ear, tongueRows }] of poses.entries()) {
    assert.equal(frameRgb(source, 'groom', frame, 26, ear), ink);
    for (const x of [28, 34]) {
      marked('tabby', 'groom', frame, x, ear + 3);
      marked('tabby', 'groom', frame, x, ear + 4);
      unmarked('tabby', 'groom', frame, x, ear === 31 ? 33 : 35);
    }
    for (const y of [39, 40]) {
      assert.equal(
        frameRgb(source, 'groom', frame, 30, y) === tongue,
        tongueRows.includes(y),
      );
      unmarked('socks', 'groom', frame, 30, y);
      unmarked('tabby', 'groom', frame, 30, y);
    }

    marked('socks', 'groom', frame, 29, 41);
    marked('socks', 'groom', frame, 27, 42);
    assert.equal(frameRgb(source, 'groom', frame, 30, 41), ink);
    unmarked('socks', 'groom', frame, 30, 41);
    marked('socks', 'groom', frame, 31, 41);
    marked('socks', 'groom', frame, 32, 43);
    unmarked('socks', 'groom', frame, 33, 43);
    for (const x of [29, 30, 36, 37]) marked('socks', 'groom', frame, x, 46);
    marked('tabby', 'groom', frame, 34, 43);
    marked('tabby', 'groom', frame, 36, 45);
  }
});

test('sleep forehead follows independently breathing ears while flank, paw tips and bib bottom stay anchored', () => {
  // Source landmarks were read from the PNG, independently of the authored data:
  // ears and closed eyes move down in pairs; the lower body outline stays at47.
  const headRows = [
    35, 35, 36, 36, 35, 35, 36, 36, 35, 35, 36, 36, 35, 35, 36, 36,
  ];
  for (let frame = 0; frame < headRows.length; frame++) {
    const ear = headRows[frame]!;
    const lowered = ear === 36;
    assert.equal(frameRgb(source, 'sleep', frame, 26, ear), ink);
    assert.equal(frameRgb(source, 'sleep', frame, 27, ear + 6), ink);
    assert.equal(frameRgb(source, 'sleep', frame, 26, 47), ink);
    for (const x of [28, 34]) {
      marked('tabby', 'sleep', frame, x, ear + 3);
      marked('tabby', 'sleep', frame, x, ear + 4);
      unmarked('tabby', 'sleep', frame, x, lowered ? 38 : 40);
    }
    for (const x of [36, 38])
      for (const y of [44, 45]) marked('tabby', 'sleep', frame, x, y);
    for (const x of [26, 27, 35, 36]) marked('socks', 'sleep', frame, x, 46);
    for (const x of [29, 30, 31]) marked('socks', 'sleep', frame, x, 44);
    marked('socks', 'sleep', frame, 30, 45);
    unmarked('socks', 'sleep', frame, 30, 43);
    // Orange gaps keep the white paws separated from the bib and each other.
    for (const x of [28, 29, 30, 31, 32, 33, 34])
      unmarked('socks', 'sleep', frame, x, 46);
  }
});

test('side markings follow the one-pixel torso bob and independently stepping front and rear paws', () => {
  const stances = [
    {
      ear: 31,
      front: [
        [28, 46],
        [30, 47],
      ],
      rear: [
        [37, 46],
        [36, 47],
      ],
    },
    {
      ear: 30,
      front: [
        [27, 45],
        [31, 47],
      ],
      rear: [
        [38, 46],
        [33, 47],
      ],
    },
    {
      ear: 31,
      front: [
        [28, 46],
        [29, 46],
      ],
      rear: [
        [35, 46],
        [36, 46],
      ],
    },
    {
      ear: 31,
      front: [
        [28, 46],
        [29, 46],
      ],
      rear: [
        [36, 46],
        [37, 46],
      ],
    },
    {
      ear: 30,
      front: [
        [27, 46],
        [29, 46],
      ],
      rear: [
        [35, 45],
        [36, 47],
      ],
    },
    {
      ear: 31,
      front: [
        [29, 46],
        [30, 46],
      ],
      rear: [
        [35, 46],
        [37, 46],
      ],
    },
  ];
  for (const [frame, stance] of stances.entries()) {
    assert.equal(frameRgb(source, 'side', frame, 26, stance.ear), ink);
    for (const x of [28, 34]) {
      marked('tabby', 'side', frame, x, stance.ear + 3);
      marked('tabby', 'side', frame, x, stance.ear + 4);
      unmarked('tabby', 'side', frame, x, stance.ear === 30 ? 35 : 33);
    }
    marked('socks', 'side', frame, 28, stance.ear + 10);
    for (const [x, y] of [...stance.front, ...stance.rear])
      marked('socks', 'side', frame, x!, y!);
    marked('tabby', 'side', frame, 35, stance.ear + 11);
    marked('tabby', 'side', frame, 38, stance.ear + 12);
  }
  // The lifted torso in frame1 does not translate all feet up: a far paw still
  // reaches47, while frame2 (lower torso) has both tips ending46.
  marked('socks', 'side', 1, 31, 47);
  assert.equal(source[frameIndex('side', 2, 31, 47) + 3], 0);
  unmarked('socks', 'side', 4, 28, 45);
  unmarked('socks', 'side', 0, 35, 45);
});

test('rear walk hides bib and forehead; independently lifted hind paws follow their real source tips', () => {
  const tips = [
    [
      [28, 51],
      [32, 51],
    ],
    [
      [28, 49],
      [29, 49],
      [32, 50],
      [33, 50],
    ],
    [
      [28, 51],
      [32, 50],
      [32, 51],
    ],
    [
      [27, 50],
      [28, 50],
      [31, 49],
      [32, 49],
    ],
  ];
  for (let frame = 0; frame < 4; frame++) {
    assert.equal(
      CAT_PATTERN_PATCHES.up[frame]!.socks.some(
        (patch) => patch.part === 'bib',
      ),
      false,
    );
    assert.equal(
      CAT_PATTERN_PATCHES.up[frame]!.tabby.some(
        (patch) => patch.part === 'forehead',
      ),
      false,
    );
    for (const [x, y] of tips[frame]!) marked('socks', 'up', frame, x!, y!);
    const ear = frame === 0 || frame === 2 ? 32 : 31;
    assert.equal(frameRgb(source, 'up', frame, 26, ear), ink);
    marked('tabby', 'up', frame, 28, ear + 3);
    marked('tabby', 'up', frame, 32, ear + 4);
    marked('tabby', 'up', frame, 27, 44);
    marked('tabby', 'up', frame, 33, 47);
  }
});

test('front-facing down steps retain white paws without chest or tail markings', () => {
  unmarked('socks', 'down', 1, 30, 39);
  marked('socks', 'down', 1, 28, 44);
  marked('socks', 'down', 1, 32, 44);
  marked('tabby', 'down', 1, 28, 34);
  marked('tabby', 'down', 1, 34, 34);
  marked('tabby', 'down', 1, 30, 30);
  unmarked('tabby', 'down', 1, 30, 44);
  for (let y = 23; y <= 25; y++)
    for (let x = 26; x <= 34; x++) {
      unmarked('socks', 'down', 1, x, y);
      unmarked('tabby', 'down', 1, x, y);
    }
  // The two other front steps expose only one coat-colored paw at a time.
  marked('socks', 'down', 0, 28, 44);
  assert.equal(frameRgb(source, 'down', 0, 32, 44), 0);
  marked('socks', 'down', 2, 32, 44);
  assert.equal(frameRgb(source, 'down', 2, 28, 44), 0);
  for (let frame = 0; frame < 3; frame++) {
    assert.equal(
      CAT_PATTERN_PATCHES.down[frame]!.socks.some(
        (patch) => patch.part === 'bib',
      ),
      false,
    );
    for (let y = 39; y <= 41; y++)
      for (let x = 29; x <= 31; x++) unmarked('socks', 'down', frame, x, y);
  }
});

test('pattern cache reuses a frame raster and rejects unsupported identifiers and invalid frames', () => {
  const mask = getPatternMask('tabby', 'sleep', 2);
  assert.equal(mask, getPatternMask('tabby', 'sleep', 2));
  assert.notEqual(mask, getPatternMask('socks', 'sleep', 2));
  assert.notEqual(mask, getPatternMask('tabby', 'sleep', 3));
  assert.notDeepEqual(mask, getPatternMask('tabby', 'sleep', 0));
  assert.throws(
    () => getPatternMask('solid' as CatPattern, 'idle', 0),
    /pattern/,
  );
  assert.throws(
    () => getPatternMask('socks', 'missing' as CatAnimation, 0),
    /animation/,
  );
  assert.throws(
    () => getPatternMask('socks', 'toString' as CatAnimation, 0),
    /animation/,
  );
  for (const frame of [-1, 16, 1.5, NaN, Infinity])
    assert.throws(() => getPatternMask('socks', 'sleep', frame), /frame/);
  assert.throws(() => getPatternMask('tabby', 'up', 4), /frame/);
});
