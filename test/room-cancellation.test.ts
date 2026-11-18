import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { Store } from '../src/server/db';
import { Room } from '../src/server/room';
import type { MusicService, Track } from '../src/shared/contracts';
const track: Track = {
  id: '1',
  title: 'Song',
  artist: 'Artist',
  album: '',
  cover: '',
  durationMs: 60000,
};
for (const action of ['remove', 'force', 'close'] as const) {
  for (const result of ['success', 'failure', 'never'] as const) {
    test(`${action} cancels pending ${result} resolution without late queue rotation`, async () => {
      const db = new Store(':memory:');
      let finish!: (value: { url: string; durationMs: number }) => void;
      let fail!: (error: Error) => void;
      let started = false;
      const service: MusicService = {
        search: async () => [],
        detail: async () => track,
        resolve: () => {
          started = true;
          return new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          });
        },
      };
      const room = new Room(db, service);
      try {
        const a = db.createGuest('A').guest,
          b = db.createGuest('B').guest;
        room.connect(a, { id: 'a', replaced() {} });
        room.connect(b, { id: 'b', replaced() {} });
        db.add(a.id, track);
        db.add(a.id, { ...track, id: '2' });
        const before = db.playlist(a.id);
        let rotations = 0;
        room.onPlaylistChange = () => {
          rotations++;
        };
        let settled = false;
        const joining = room.join(a.id, 'a').then(() => {
          settled = true;
        });
        while (!started) await immediate();
        if (action === 'remove') await room.removeMember(a.id, 'a');
        else if (action === 'force') await room.forceLeave(a.id);
        else room.close();
        await immediate();
        assert.equal(
          settled,
          true,
          'cancellation must settle the outstanding command without upstream completion',
        );
        await joining;
        if (result === 'success')
          finish({ url: 'https://example.com/a.mp3', durationMs: 60000 });
        if (result === 'failure') fail(new Error('late failure'));
        await immediate();
        assert.equal(rotations, 0);
        assert.deepEqual(db.playlist(a.id), before);
        assert.equal(room.snapshot().playback, null);
        if (action !== 'close')
          assert.equal(room.snapshot().stage.includes(a.id), false);
      } finally {
        room.close();
        db.close();
      }
    });
  }
}
