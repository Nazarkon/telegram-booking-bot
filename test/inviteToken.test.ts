import { timingSafeEqual } from 'node:crypto';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractInviteToken } from '../src/bot/middleware/access.js';
import { findPendingLinkInvite } from '../src/db/repositories/invites.js';
import type { PendingLinkInvite } from '../src/db/repositories/invites.js';
import {
  addInvite,
  callbackUpdate,
  createHarness,
  createLibraryFor,
  generateInviteToken,
  HOUR_MS,
  messageUpdate,
  sha256Hex,
  userCount,
} from './helpers/botHarness.js';
import type { Harness } from './helpers/botHarness.js';

// Spy on the two things the invite-link check must use, while keeping their real behaviour.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
vi.mock('../src/db/repositories/invites.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db/repositories/invites.js')>();
  return { ...actual, findPendingLinkInvite: vi.fn(actual.findPendingLinkInvite) };
});

// Literal on purpose (not imported from the source): 16 random bytes are 22 base64url
// characters, and Telegram deep-link payloads are capped at 64 characters, 4 of which are "inv_".
const MIN_TOKEN_LENGTH = 22;
const MAX_TOKEN_LENGTH = 60;

const ALLOWED = 100;
const STRANGER = 300;
const OWNER = 400;

let h: Harness;
let db: Database;
let library: number;

beforeEach(() => {
  vi.mocked(timingSafeEqual).mockClear();
  vi.mocked(findPendingLinkInvite).mockClear();
  h = createHarness({ allowedUserIds: [ALLOWED] });
  db = h.db;
  library = createLibraryFor(db, OWNER);
});

afterEach(() => {
  db.close();
});

const inThePast = (): string => new Date(Date.now() - HOUR_MS).toISOString();

async function expectAllowed(text: string): Promise<void> {
  const update = messageUpdate({ id: STRANGER }, text);
  await h.send(update);
  expect(h.handled).toEqual([update.update_id]);
  expect(h.calls).toEqual([]);
}

async function expectDenied(text: string): Promise<void> {
  await h.send(messageUpdate({ id: STRANGER }, text));
  expect(h.handled).toEqual([]);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.payload.text).toBe('Доступ заборонено');
}

describe('access gate: /start inv_<token>', () => {
  it('lets a pending link invite through', async () => {
    const token = generateInviteToken();
    addInvite(db, { libraryId: library, createdBy: OWNER, token });

    await expectAllowed(`/start inv_${token}`);
  });

  it('creates the users row for the invited user (upsert runs after the gate)', async () => {
    const token = generateInviteToken();
    addInvite(db, { libraryId: library, createdBy: OWNER, token });
    const before = userCount(db);

    await h.send(messageUpdate({ id: STRANGER, username: 'guest' }, `/start inv_${token}`));

    expect(userCount(db)).toBe(before + 1);
  });

  it('does not accept the invite: no membership is created by the gate', async () => {
    const token = generateInviteToken();
    addInvite(db, { libraryId: library, createdBy: OWNER, token });

    await h.send(messageUpdate({ id: STRANGER }, `/start inv_${token}`));

    const members = db
      .prepare('SELECT COUNT(*) AS n FROM library_members WHERE user_id = ?')
      .get(STRANGER) as { n: number };
    expect(members.n).toBe(0);
    const invite = db.prepare('SELECT accepted_at FROM invites').get() as { accepted_at: null };
    expect(invite.accepted_at).toBeNull();
  });

  it('denies a well-formed token that matches no invite', async () => {
    addInvite(db, { libraryId: library, createdBy: OWNER });

    await expectDenied(`/start inv_${generateInviteToken()}`);
  });

  it.each([
    ['expired', { expiresAt: inThePast() }],
    ['revoked', { revokedAt: inThePast() }],
    ['accepted', { acceptedAt: inThePast() }],
  ])('denies a token of an invite that is %s', async (_label, seed) => {
    const token = generateInviteToken();
    addInvite(db, { libraryId: library, createdBy: OWNER, token, ...seed });

    await expectDenied(`/start inv_${token}`);
  });

  it('denies a valid token sent in anything but an exact /start message', async () => {
    const token = generateInviteToken();
    addInvite(db, { libraryId: library, createdBy: OWNER, token });

    for (const text of [
      `inv_${token}`,
      token,
      `hello /start inv_${token}`,
      `/help inv_${token}`,
      `/start ${token}`,
      `/start inv_${token} extra`,
      `/start  inv_${token}`,
      `/start inv_${token}\n`,
      `/start@other_bot inv_${token}`,
    ]) {
      await h.send(messageUpdate({ id: STRANGER }, text));
      h.clock.now += 24 * HOUR_MS;
    }

    expect(h.handled).toEqual([]);
  });

  it('denies a valid token carried in a callback query', async () => {
    const token = generateInviteToken();
    addInvite(db, { libraryId: library, createdBy: OWNER, token });

    await h.send(callbackUpdate({ id: STRANGER }, `/start inv_${token}`));

    expect(h.handled).toEqual([]);
    expect(h.calls[0]?.method).toBe('answerCallbackQuery');
  });

  describe('token format is validated before any database lookup', () => {
    const base = generateInviteToken();
    const malformed: [string, string][] = [
      ['one character too short', base.slice(0, MIN_TOKEN_LENGTH - 1)],
      ['one character too long', 'A'.repeat(MAX_TOKEN_LENGTH + 1)],
      ['standard base64 "+"', `${base.slice(0, 10)}+${base.slice(11)}`],
      ['standard base64 "/"', `${base.slice(0, 10)}/${base.slice(11)}`],
      ['base64 padding "="', `${base.slice(0, 21)}=`],
      ['a space inside', `${base.slice(0, 10)} ${base.slice(11)}`],
      ['non-ASCII letters', `${base.slice(0, 10)}ї${base.slice(11)}`],
      ['empty', ''],
    ];

    it.each(malformed)(
      'rejects a token that is %s even if its hash is stored',
      async (_l, token) => {
        // Seed an invite whose hash is exactly the malformed token's, so only the format
        // check (not the database) can reject it.
        db.prepare(
          `INSERT INTO invites (library_id, created_by, kind, token_hash, expires_at)
         VALUES (?, ?, 'link', ?, ?)`,
        ).run(library, OWNER, sha256Hex(token), new Date(Date.now() + HOUR_MS).toISOString());

        await expectDenied(`/start inv_${token}`);

        expect(findPendingLinkInvite).not.toHaveBeenCalled();
      },
    );

    it('accepts the boundary lengths', async () => {
      for (const length of [MIN_TOKEN_LENGTH, MAX_TOKEN_LENGTH]) {
        const token = 'a'.repeat(length - 1) + 'B';
        addInvite(db, { libraryId: library, createdBy: OWNER, token });
        const update = messageUpdate({ id: STRANGER }, `/start inv_${token}`);

        await h.send(update);

        expect(h.handled).toContain(update.update_id);
      }
    });
  });

  describe('constant-time comparison', () => {
    it('compares the computed and stored hashes with timingSafeEqual on equal-length buffers', async () => {
      const token = generateInviteToken();
      addInvite(db, { libraryId: library, createdBy: OWNER, token });

      await expectAllowed(`/start inv_${token}`);

      expect(timingSafeEqual).toHaveBeenCalledTimes(1);
      const [left, right] = vi.mocked(timingSafeEqual).mock.calls[0] ?? [];
      expect(Buffer.isBuffer(left)).toBe(true);
      expect((left as Buffer).length).toBe((right as Buffer).length);
      expect((left as Buffer).toString()).toBe(sha256Hex(token));
    });

    it('denies when the stored hash differs from the computed one', async () => {
      const token = generateInviteToken();
      const lookalike: PendingLinkInvite = {
        id: 1,
        libraryId: library,
        createdBy: OWNER,
        expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
        tokenHash: sha256Hex('some other token'),
      };
      vi.mocked(findPendingLinkInvite).mockReturnValueOnce(lookalike);

      await expectDenied(`/start inv_${token}`);
    });

    it('denies (and does not throw) when the stored hash has a different length', async () => {
      const token = generateInviteToken();
      vi.mocked(findPendingLinkInvite).mockReturnValueOnce({
        id: 1,
        libraryId: library,
        createdBy: OWNER,
        expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
        tokenHash: 'abc',
      });

      await expectDenied(`/start inv_${token}`);
    });
  });
});

describe('extractInviteToken', () => {
  it('returns the payload of an exact /start inv_ message and null otherwise', () => {
    expect(extractInviteToken('/start inv_abc')).toBe('abc');
    expect(extractInviteToken('/start abc')).toBeNull();
    expect(extractInviteToken('/start inv_')).toBeNull();
    expect(extractInviteToken('start inv_abc')).toBeNull();
    expect(extractInviteToken(undefined)).toBeNull();
  });
});
