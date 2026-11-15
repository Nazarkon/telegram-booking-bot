import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DENIAL_THROTTLE_MAX_ENTRIES, DenialThrottle } from '../src/bot/middleware/access.js';
import { uk } from '../src/i18n/uk.js';
import { createPersonalLibrary } from '../src/db/repositories/libraries.js';
import { getUser, upsertUser } from '../src/db/repositories/users.js';
import {
  addInvite,
  callbackUpdate,
  channelPostUpdate,
  createHarness,
  createLibraryFor,
  HOUR_MS,
  messageUpdate,
  myChatMemberUpdate,
  userCount,
} from './helpers/botHarness.js';
import type { Harness } from './helpers/botHarness.js';

// Literal on purpose: the documented denial window is 10 minutes.
const DENIAL_WINDOW_MS = 10 * 60 * 1000;

const ALLOWED = 100;
const MEMBER = 200;
const STRANGER = 300;
const OWNER = 400;

let h: Harness;
let db: Database;

beforeEach(() => {
  h = createHarness({ allowedUserIds: [ALLOWED] });
  db = h.db;
});

afterEach(() => {
  db.close();
});

function expectOneDenial(chatId: number): void {
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.method).toBe('sendMessage');
  expect(h.calls[0]?.payload).toMatchObject({ chat_id: chatId, text: uk.accessDenied });
}

describe('access gate: who gets through', () => {
  it('lets an allowlisted user through', async () => {
    const update = messageUpdate({ id: ALLOWED }, 'hi');

    await h.send(update);

    expect(h.handled).toEqual([update.update_id]);
    expect(h.calls).toEqual([]);
  });

  it('lets a library member who is not allowlisted through', async () => {
    upsertUser(db, { id: MEMBER, username: null, firstName: 'Member' });
    createPersonalLibrary(db, MEMBER, 'Mine');
    const update = messageUpdate({ id: MEMBER }, 'hi');

    await h.send(update);

    expect(h.handled).toEqual([update.update_id]);
    expect(h.calls).toEqual([]);
  });

  it('lets a pending username invite through, matching the current username case-insensitively', async () => {
    const library = createLibraryFor(db, OWNER);
    addInvite(db, { libraryId: library, createdBy: OWNER, username: 'Bob_Reader' });
    const update = messageUpdate({ id: STRANGER, username: 'BOB_reader' }, 'hi');

    await h.send(update);

    expect(h.handled).toEqual([update.update_id]);
    expect(h.calls).toEqual([]);
  });

  it('lets a callback query from a pending username invite through', async () => {
    const library = createLibraryFor(db, OWNER);
    addInvite(db, { libraryId: library, createdBy: OWNER, username: 'bob_reader' });
    const update = callbackUpdate({ id: STRANGER, username: 'bob_reader' }, 'x');

    await h.send(update);

    expect(h.handled).toEqual([update.update_id]);
  });

  describe.each([
    [
      'the username changed since the invite',
      { username: 'bob_reader' },
      { username: 'bob_renamed' },
    ],
    [
      'the invite expired',
      { username: 'bob_reader', expiresAt: new Date(Date.now() - HOUR_MS).toISOString() },
      { username: 'bob_reader' },
    ],
    [
      'the invite was revoked',
      { username: 'bob_reader', revokedAt: new Date(Date.now() - HOUR_MS).toISOString() },
      { username: 'bob_reader' },
    ],
    [
      'the invite was accepted',
      { username: 'bob_reader', acceptedAt: new Date(Date.now() - HOUR_MS).toISOString() },
      { username: 'bob_reader' },
    ],
    ['the user has no username', { username: 'bob_reader' }, {}],
  ])('a username invite does not help when %s', (_label, seed, sender) => {
    it('denies access', async () => {
      const library = createLibraryFor(db, OWNER);
      addInvite(db, { libraryId: library, createdBy: OWNER, ...seed });

      await h.send(messageUpdate({ id: STRANGER, ...sender }, 'hi'));

      expect(h.handled).toEqual([]);
      expectOneDenial(STRANGER + 1000);
    });
  });
});

describe('access gate: strangers', () => {
  it('sends exactly one «Доступ заборонено» and runs no handler', async () => {
    await h.send(messageUpdate({ id: STRANGER }, 'hi'));

    expect(h.handled).toEqual([]);
    expectOneDenial(STRANGER + 1000);
  });

  it('writes no users row for a stranger', async () => {
    await h.send(messageUpdate({ id: STRANGER, username: 'nobody' }, 'hi'));
    await h.send(callbackUpdate({ id: STRANGER, username: 'nobody' }, 'x'));

    expect(getUser(db, STRANGER)).toBeNull();
    expect(userCount(db)).toBe(0);
  });

  it('sends nothing for a second denial inside the window', async () => {
    await h.send(messageUpdate({ id: STRANGER }, 'one'));
    h.clock.now += DENIAL_WINDOW_MS - 1;
    await h.send(messageUpdate({ id: STRANGER }, 'two'));
    await h.send(callbackUpdate({ id: STRANGER }, 'x'));

    expect(h.calls).toHaveLength(1);
    expect(h.handled).toEqual([]);
  });

  it('answers again once the window has passed', async () => {
    await h.send(messageUpdate({ id: STRANGER }, 'one'));
    h.clock.now += DENIAL_WINDOW_MS;
    await h.send(messageUpdate({ id: STRANGER }, 'two'));

    expect(h.calls).toHaveLength(2);
  });

  it('throttles per user: another stranger is still answered', async () => {
    await h.send(messageUpdate({ id: STRANGER }, 'hi'));
    await h.send(messageUpdate({ id: STRANGER + 1 }, 'hi'));

    expect(h.calls).toHaveLength(2);
    expect(h.calls.map((call) => call.payload.chat_id)).toEqual([STRANGER + 1000, STRANGER + 1001]);
  });

  it('answers a callback query from a stranger with the denial text, not a message', async () => {
    const update = callbackUpdate({ id: STRANGER }, 'book:1');

    await h.send(update);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.method).toBe('answerCallbackQuery');
    expect(h.calls[0]?.payload).toMatchObject({ text: uk.accessDenied });
    expect(h.handled).toEqual([]);
  });

  it('gives the same denial whether or not an expired invite exists', async () => {
    const library = createLibraryFor(db, OWNER);
    addInvite(db, {
      libraryId: library,
      createdBy: OWNER,
      username: 'with_invite',
      expiresAt: new Date(Date.now() - HOUR_MS).toISOString(),
    });

    await h.send(messageUpdate({ id: STRANGER, username: 'with_invite' }, 'hi'));
    await h.send(messageUpdate({ id: STRANGER + 1, username: 'without_invite' }, 'hi'));

    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]?.method).toBe(h.calls[1]?.method);
    expect(h.calls[0]?.payload.text).toBe(h.calls[1]?.payload.text);
  });

  it('drops an update that has no sender silently', async () => {
    await h.send(channelPostUpdate('news'));

    expect(h.handled).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('drops a non-message update from a stranger silently (nothing to reply to)', async () => {
    await h.send(myChatMemberUpdate({ id: STRANGER }));

    expect(h.handled).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(userCount(db)).toBe(0);
  });

  it('lets a non-message update from an allowed user through', async () => {
    const update = myChatMemberUpdate({ id: ALLOWED });

    await h.send(update);

    expect(h.handled).toEqual([update.update_id]);
  });
});

describe('DenialThrottle', () => {
  it('stays bounded: past the cap the oldest entry is forgotten', () => {
    const now = 0;
    const throttle = new DenialThrottle(1000, 2, () => now);

    expect(throttle.tryAcquire(1)).toBe(true);
    expect(throttle.tryAcquire(2)).toBe(true);
    expect(throttle.tryAcquire(3)).toBe(true);

    // User 1 was evicted to make room, so they can be answered again; 3 is still throttled.
    expect(throttle.tryAcquire(3)).toBe(false);
    expect(throttle.tryAcquire(1)).toBe(true);
  });

  it('forgets the oldest entries first and keeps the newer ones throttled', () => {
    const now = 0;
    const throttle = new DenialThrottle(1000, 3, () => now);
    throttle.tryAcquire(1);
    throttle.tryAcquire(2);
    throttle.tryAcquire(3);

    throttle.tryAcquire(4);

    expect(throttle.tryAcquire(2)).toBe(false);
    expect(throttle.tryAcquire(3)).toBe(false);
    expect(throttle.tryAcquire(4)).toBe(false);
  });

  it('caps the number of remembered strangers at 10,000', () => {
    expect(DENIAL_THROTTLE_MAX_ENTRIES).toBe(10_000);
  });

  it('moves a stranger to the newest slot when they are answered again', () => {
    let now = 0;
    const throttle = new DenialThrottle(1000, 3, () => now);
    throttle.tryAcquire(1);
    throttle.tryAcquire(2);

    // User 1's window has expired, so they are answered again and become the newest entry.
    now = 1000;
    expect(throttle.tryAcquire(1)).toBe(true);
    throttle.tryAcquire(3);
    // The cap is reached: the oldest entry (user 2, not the re-answered user 1) is dropped.
    throttle.tryAcquire(4);

    expect(throttle.tryAcquire(1)).toBe(false);
  });
});
