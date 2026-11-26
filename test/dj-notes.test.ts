import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeDjPlayback,
  DJ_NOTE_COUNT,
  DJ_NOTE_LIFETIME_MS,
  DJ_NOTE_STAGGER_MS,
  MUSIC_NOTE_COLORS,
  djNotePose,
  likeNoteFrame,
} from '../src/client/dj-notes';

const playback = {
  djId: 'current-dj',
  roundId: 'round-one',
  startedAt: 1000,
  durationMs: 60_000,
};

test('only the authoritative current DJ is active during the playable timeline', () => {
  for (const now of [1000, 25_000, 60_999]) {
    assert.equal(activeDjPlayback('current-dj', playback, now), playback);
    assert.equal(activeDjPlayback('other-cat', playback, now), null);
  }
  for (const now of [999, 61_000, 70_000, NaN, Infinity])
    assert.equal(activeDjPlayback('current-dj', playback, now), null);
  for (const missing of [null, undefined])
    assert.equal(activeDjPlayback('current-dj', missing, 2000), null);
  for (const durationMs of [0, -1, NaN, Infinity])
    assert.equal(
      activeDjPlayback('current-dj', { ...playback, durationMs }, 2000),
      null,
    );
});

test('round changes and DJ handoff immediately use only the new playback', () => {
  const next = {
    ...playback,
    djId: 'next-dj',
    roundId: 'round-two',
    startedAt: 2000,
  };
  assert.equal(activeDjPlayback('current-dj', next, 2000), null);
  assert.equal(activeDjPlayback('next-dj', next, 2000), next);
  const repeat = { ...next, roundId: 'round-three', startedAt: 3000 };
  assert.equal(activeDjPlayback('next-dj', repeat, 2999), null);
  assert.equal(
    activeDjPlayback('next-dj', repeat, 3000)?.roundId,
    'round-three',
  );
});

test('the fixed pool stays bounded and clear of nickname/emote zones across cycles', () => {
  const sides = new Set<number>();
  for (let elapsed = 0; elapsed <= DJ_NOTE_LIFETIME_MS * 4; elapsed += 17) {
    for (let index = 0; index < DJ_NOTE_COUNT; index++) {
      const pose = djNotePose(index, elapsed);
      for (const value of Object.values(pose))
        assert.ok(Number.isFinite(value));
      assert.ok(Math.abs(pose.x) <= 72);
      assert.ok(pose.y >= -76 && pose.y <= -8);
      assert.ok(pose.scale >= 0.35 && pose.scale <= 0.6);
      assert.ok(Math.abs(pose.rotation) <= 0.3);
      assert.ok(pose.alpha >= 0 && pose.alpha <= 0.8);
      if (pose.alpha > 0.1) {
        assert.ok(
          pose.y < -42,
          'visible notes remain above the emission origin',
        );
        sides.add(Math.sign(pose.x));
      }
    }
  }
  assert.deepEqual([...sides].sort(), [-1, 1]);
});

test('notes start in staggered order, fade at recycling and remain deterministic', () => {
  for (let index = 0; index < DJ_NOTE_COUNT; index++) {
    const birth = index * DJ_NOTE_STAGGER_MS;
    assert.equal(djNotePose(index, birth - 1).alpha, 0);
    assert.equal(djNotePose(index, birth).alpha, 0);
    assert.ok(djNotePose(index, birth + DJ_NOTE_STAGGER_MS / 2).alpha > 0);
    const peak = djNotePose(index, birth + DJ_NOTE_LIFETIME_MS / 2);
    assert.ok(
      peak.alpha > djNotePose(index, birth + DJ_NOTE_LIFETIME_MS - 1).alpha,
    );
    assert.equal(djNotePose(index, birth + DJ_NOTE_LIFETIME_MS).alpha, 0);
    assert.notDeepEqual(
      peak,
      djNotePose(index, birth + DJ_NOTE_LIFETIME_MS * 1.5),
    );
    assert.deepEqual(peak, djNotePose(index, birth + DJ_NOTE_LIFETIME_MS / 2));
  }
});

test('reduced motion shows one static faint note with no timeline animation', () => {
  for (const elapsed of [0, 250, 3840, 10_000, 1_000_000]) {
    for (let index = 0; index < DJ_NOTE_COUNT; index++) {
      const pose = djNotePose(index, elapsed, true);
      assert.deepEqual(pose, djNotePose(index, 0, true));
      assert.equal(pose.alpha > 0, index === 0);
      if (index === 0) {
        assert.ok(pose.x > 20 && pose.y < -40);
        assert.ok(pose.alpha < 0.5);
      }
    }
  }
});

test('invalid pool indices or time cannot expose stray notes', () => {
  for (const index of [-1, DJ_NOTE_COUNT, 0.5, NaN])
    assert.equal(djNotePose(index, 1000).alpha, 0);
  for (const time of [-1, NaN, Infinity])
    assert.equal(djNotePose(0, time).alpha, 0);
});

test('likes rotate through the playback glyph styles one per animation cycle', () => {
  const seed = 4;
  const styles = Array.from(
    { length: MUSIC_NOTE_COLORS.length + 1 },
    (_, cycle) => {
      const elapsed = cycle * DJ_NOTE_LIFETIME_MS;
      const { index } = likeNoteFrame(seed, elapsed);
      assert.equal(likeNoteFrame(seed, elapsed).pose.alpha, 0);
      const mid = elapsed + DJ_NOTE_LIFETIME_MS / 2;
      assert.deepEqual(likeNoteFrame(seed, mid), {
        index,
        pose: djNotePose(index, mid + index * DJ_NOTE_STAGGER_MS),
      });
      return index;
    },
  );
  assert.deepEqual(styles, [1, 2, 0, 1]);
  assert.equal(likeNoteFrame(5, 0).index, 2);
  assert.deepEqual(likeNoteFrame(seed, 20_000, true), {
    index: 1,
    pose: djNotePose(0, 0, true),
  });
});
