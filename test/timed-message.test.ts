import assert from 'node:assert/strict';
import test from 'node:test';
import { effectScope, watch } from 'vue';
import {
  MESSAGE_DURATION_MS,
  useTimedMessage,
} from '../src/client/timed-message';

test('notifications expire automatically and replacing them gives the new message a full lifetime', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const scope = effectScope();
  context.after(() => scope.stop());
  const message = scope.run(() => useTimedMessage())!;
  message.value = 'first';
  context.mock.timers.tick(4000);
  message.value = 'second';
  context.mock.timers.tick(MESSAGE_DURATION_MS - 1);
  assert.equal(message.value, 'second');
  context.mock.timers.tick(1);
  assert.equal(message.value, '');
});

test('repeating the same error renews its lifetime and manual dismissal cancels expiry', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const scope = effectScope();
  context.after(() => scope.stop());
  const message = scope.run(() => useTimedMessage())!;
  message.value = 'failed';
  context.mock.timers.tick(5000);
  message.value = 'failed';
  context.mock.timers.tick(5000);
  assert.equal(message.value, 'failed');
  message.value = '';
  context.mock.timers.tick(2000);
  message.value = 'retry';
  context.mock.timers.tick(MESSAGE_DURATION_MS - 1);
  assert.equal(message.value, 'retry');
  context.mock.timers.tick(1);
  assert.equal(message.value, '');
});

test('independent messages expire separately and disposal cancels pending callbacks', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const scope = effectScope();
  const [error, notice] = scope.run(() => [
    useTimedMessage(),
    useTimedMessage(),
  ])!;
  error!.value = 'failed';
  context.mock.timers.tick(3000);
  notice!.value = 'saved';
  context.mock.timers.tick(3000);
  assert.equal(error!.value, '');
  assert.equal(notice!.value, 'saved');
  let expiryChanges = 0;
  const stop = watch(notice!, () => expiryChanges++, { flush: 'sync' });
  scope.stop();
  context.mock.timers.tick(10000);
  assert.equal(notice!.value, 'saved');
  assert.equal(expiryChanges, 0);
  stop();
});
