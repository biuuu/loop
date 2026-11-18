import test from 'node:test';
import assert from 'node:assert/strict';
import {
  combineLyrics,
  currentLyricIndex,
  lyricSelection,
  lyricTime,
  lyricWheelFrame,
  lyricWheelLayout,
  parseLrc,
} from '../src/client/lyrics';

test('LRC parses zero, fractional and repeated timestamps in chronological order', () => {
  assert.deepEqual(
    parseLrc(
      '\uFEFF[ar:Artist]\n[00:03.123]third\n[00:00]start\n[00:01.2][00:02.34]repeat\r\n[00:04:12]fourth',
    ),
    [
      { timeMs: 0, text: 'start' },
      { timeMs: 1200, text: 'repeat' },
      { timeMs: 2340, text: 'repeat' },
      { timeMs: 3123, text: 'third' },
      { timeMs: 4120, text: 'fourth' },
    ],
  );
});

test('LRC ignores metadata and malformed timestamps, preserving timed blanks', () => {
  assert.deepEqual(
    parseLrc(
      '[offset:100]\nplain words\n[00:60]bad\n[xx:00]bad\n[-1:00]bad\n[00:01.1234]bad\n[00:01]one\n[00:02]  \n[00:03]last',
    ),
    [
      { timeMs: 1000, text: 'one' },
      { timeMs: 2000, text: '' },
      { timeMs: 3000, text: 'last' },
    ],
  );
  assert.deepEqual(parseLrc(''), []);
});

test('same-time lines remain one stable group without duplicate words', () => {
  assert.deepEqual(
    parseLrc(
      '[00:01]first\n[00:00]intro\n[00:01]second\n[00:01]first\n[00:02]old\n[00:02]',
    ),
    [
      { timeMs: 0, text: 'intro' },
      { timeMs: 1000, text: 'first\nsecond' },
      { timeMs: 2000, text: '' },
    ],
  );
});

test('translation matches exact or closest timestamps within an inclusive 200ms', () => {
  assert.deepEqual(
    combineLyrics(
      '[00:01]one\n[00:02]two\n[00:03]three\n[00:04]four',
      '[00:01]一\n[00:02.2]二\n[00:02.799]too far\n[00:04.199]四',
    ).map((line) => line.translation),
    ['一', '二', '', '四'],
  );
});

test('nearby fast lyrics do not receive the same translation twice', () => {
  const lines = combineLyrics(
    '[00:01]one\n[00:01.1]two\n[00:02]\n[00:03]three',
    '[00:01.08]二\n[00:01.1]第二行\n[00:02]must stay blank\n[00:03]三',
  );
  assert.deepEqual(
    lines.map((line) => line.translation),
    ['', '二\n第二行', '', '三'],
  );
  assert.equal(
    lines.filter((line) => line.translation.includes('二')).length,
    1,
  );
  assert.deepEqual(combineLyrics('', '[00:00]translation only'), []);
});

test('current/next includes prelude, zero timestamp, clearing and the final line', () => {
  const lines = parseLrc('[00:01]first\n[00:02]\n[00:03]final');
  assert.deepEqual(lyricSelection(lines, 0), { current: -1, next: 0 });
  assert.deepEqual(lyricSelection(lines, 1000), { current: 0, next: 1 });
  assert.equal(lines[currentLyricIndex(lines, 2500)]!.text, '');
  assert.deepEqual(lyricSelection(lines, 3000), { current: 2, next: -1 });
  assert.deepEqual(lyricSelection(lines, 100_000), { current: 2, next: -1 });
  assert.equal(currentLyricIndex(parseLrc('[00:00]start'), 0), 0);
  assert.deepEqual(lyricSelection([], 0), { current: -1, next: -1 });
});

test('room timeline uses server start time and full-song preview offset', () => {
  assert.equal(lyricTime({ startedAt: 10_000 }, 12_300), 2300);
  assert.equal(lyricTime({ startedAt: 10_000 }, 9000), 0);
  assert.equal(
    lyricTime({ startedAt: 10_000, lyricOffsetMs: 60_000 }, 12_300),
    62_300,
  );
  assert.equal(
    lyricTime({ startedAt: 10_000, lyricOffsetMs: 60_000 }, 9000),
    60_000,
  );
  assert.equal(
    lyricTime({ startedAt: 10_000, lyricOffsetMs: null }, 12_300),
    null,
  );
  assert.equal(
    lyricTime({ startedAt: 10_000, lyricOffsetMs: 0 }, 12_300),
    2300,
  );
  assert.equal(lyricTime({ startedAt: 10_000 }, NaN), null);
});

const wheelLines = (translations: boolean[]) =>
  translations.map((translated, index) => ({
    timeMs: index * 1000,
    text: `line ${index}`,
    translation: translated ? `translation ${index}` : '',
  }));

test('wheel geometry keeps original/translation together and compresses untranslated blocks', () => {
  const rows = lyricWheelLayout(wheelLines([true, false, true, false]));
  assert.deepEqual(
    rows.map(({ top, contentHeight, extent, center }) => ({
      top,
      contentHeight,
      extent,
      center,
    })),
    [
      { top: 0, contentHeight: 38, extent: 46, center: 19 },
      { top: 46, contentHeight: 22, extent: 28, center: 57 },
      { top: 74, contentHeight: 38, extent: 46, center: 93 },
      { top: 120, contentHeight: 22, extent: 28, center: 131 },
    ],
  );
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1]!;
    assert.ok(previous.top + previous.contentHeight < rows[index]!.top);
  }
});

test('wheel advances every rendered row by one identical track delta', () => {
  const layout = lyricWheelLayout(wheelLines([true, false, true, false, true]));
  const previous = lyricWheelFrame(layout, 1);
  const current = lyricWheelFrame(layout, 2);
  const delta = current.offset - previous.offset;
  assert.ok(delta < 0);
  for (const row of previous.rows) {
    const retained = current.rows.find(
      (candidate) => candidate.index === row.index,
    );
    assert.ok(retained);
    assert.equal(
      retained.top + current.offset - (row.top + previous.offset),
      delta,
    );
  }
  assert.equal(layout[2]!.center + current.offset, 66);
  assert.ok(layout[1]!.center + current.offset < 66);
  assert.ok(layout[3]!.center + current.offset > 66);
});

test('wheel window stays at seven rows and preserves current and its neighbors', () => {
  const layout = lyricWheelLayout(
    wheelLines(Array.from({ length: 30 }, (_, index) => index % 2 === 0)),
  );
  for (let index = 0; index < layout.length; index++) {
    const frame = lyricWheelFrame(layout, index);
    assert.ok(frame.rows.length <= 7);
    assert.ok(frame.rows.some((row) => row.index === index));
    for (const neighbor of [index - 1, index + 1])
      if (neighbor >= 0 && neighbor < layout.length)
        assert.ok(frame.rows.some((row) => row.index === neighbor));
    assert.equal(layout[index]!.center + frame.offset, 66);
    // Recycling outer rows during one forward step happens beyond the viewport.
    if (index + 1 < layout.length) {
      const next = lyricWheelFrame(layout, index + 1);
      for (const removed of frame.rows.filter(
        (row) => !next.rows.includes(row),
      ))
        assert.ok(removed.top + removed.contentHeight + frame.offset <= 0);
      for (const added of next.rows.filter((row) => !frame.rows.includes(row)))
        assert.ok(added.top + next.offset >= 132);
    }
  }
});

test('wheel handles empty lyrics, first/final focus and a virtual blank prelude', () => {
  assert.deepEqual(lyricWheelFrame(lyricWheelLayout([]), -1), {
    offset: 0,
    rows: [],
  });
  for (const translated of [false, true]) {
    const layout = lyricWheelLayout(wheelLines([translated]));
    const prelude = lyricWheelFrame(layout, -1);
    const first = lyricWheelFrame(layout, 0);
    assert.equal(prelude.rows[0], layout[0]);
    assert.equal(layout[0]!.center - layout[0]!.extent + prelude.offset, 66);
    assert.ok(layout[0]!.center + prelude.offset > 66);
    assert.equal(layout[0]!.center + first.offset, 66);
  }
  const layout = lyricWheelLayout(wheelLines([false, true, false]));
  const final = lyricWheelFrame(layout, 2);
  assert.equal(final.rows.at(-1), layout[2]);
  assert.equal(layout[2]!.center + final.offset, 66);
});

test('rapid advances and seeks target the latest fixed geometry without accumulating drift', () => {
  const layout = lyricWheelLayout(
    wheelLines(Array.from({ length: 20 }, (_, index) => index % 3 === 0)),
  );
  for (const target of [1, 2, 3, 4, 12, 2, 3, 19]) {
    const frame = lyricWheelFrame(layout, target);
    assert.equal(layout[target]!.center + frame.offset, 66);
    for (let index = 1; index < frame.rows.length; index++) {
      const before = frame.rows[index - 1]!;
      const after = frame.rows[index]!;
      assert.ok(
        before.top + frame.offset + before.contentHeight <
          after.top + frame.offset,
      );
    }
  }
});
