import assert from 'node:assert/strict';
import test from 'node:test';
import { directoryRoomAccess } from '../src/client/room-directory.ts';
import type { RoomSummary } from '../src/shared/contracts.ts';

const room = {
  ownerId: 'owner',
  joinPolicy: 'open',
  full: false,
} as RoomSummary;

test('directory cards follow public admission for open, closed and full rooms', () => {
  assert.deepEqual(directoryRoomAccess(room, undefined), {
    label: '开放中',
    blocked: false,
  });
  assert.deepEqual(
    directoryRoomAccess({ ...room, joinPolicy: 'closed' }, 'visitor'),
    {
      label: '暂停新访客',
      blocked: true,
    },
  );
  assert.deepEqual(
    directoryRoomAccess({ ...room, joinPolicy: 'closed' }, 'owner'),
    {
      label: '访客暂停进入',
      blocked: false,
    },
  );
  assert.deepEqual(directoryRoomAccess({ ...room, full: true }, 'owner'), {
    label: '已满',
    blocked: true,
  });
});
