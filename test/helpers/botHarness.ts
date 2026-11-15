import { createHash, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

import type { Database } from 'better-sqlite3';
import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';

import { createBot } from '../../src/bot/bot.js';
import type { RateLimitSettings } from '../../src/bot/bot.js';
import { createLoggerFromConfig } from '../../src/logger.js';
import { openDatabase, IN_MEMORY_DB_PATH } from '../../src/db/index.js';
import { upsertUser } from '../../src/db/repositories/users.js';
import { createPersonalLibrary } from '../../src/db/repositories/libraries.js';

export const BOT_TOKEN = '123456789:AAFake-Secret_tokenValue';
export const CHAT_ID_OFFSET = 1000;
export const HOUR_MS = 60 * 60 * 1000;

export const FAKE_BOT_INFO: UserFromGetMe = {
  id: 123456789,
  is_bot: true,
  first_name: 'Test bot',
  username: 'test_library_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

// Large enough that tests which are not about the rate limit never hit it.
const UNLIMITED: RateLimitSettings = { windowMs: 60_000, maxUpdates: 1000 };

export interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

export interface Harness {
  readonly bot: Bot;
  readonly db: Database;
  /** Every outgoing Bot API call, in order. No network is ever used. */
  readonly calls: ApiCall[];
  /** Update ids that reached the spy handler registered after the whole middleware chain. */
  readonly handled: number[];
  readonly logLines: () => Record<string, unknown>[];
  readonly rawLog: () => string;
  readonly clock: { now: number };
  readonly send: (update: Update) => Promise<void>;
}

export interface HarnessOptions {
  readonly allowedUserIds?: readonly number[];
  readonly rateLimit?: RateLimitSettings;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const db = openDatabase(IN_MEMORY_DB_PATH);
  const chunks: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const config = {
    botToken: BOT_TOKEN,
    allowedUserIds: options.allowedUserIds ?? [],
    dbPath: IN_MEMORY_DB_PATH,
    coversDir: '/tmp/covers',
    logLevel: 'info',
  } as const;
  const logger = createLoggerFromConfig(config, logStream);
  const clock = { now: 1_700_000_000_000 };

  const bot = createBot({
    config,
    db,
    logger,
    botInfo: FAKE_BOT_INFO,
    rateLimit: options.rateLimit ?? UNLIMITED,
    now: () => clock.now,
  });

  const calls: ApiCall[] = [];
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload: payload });
    return Promise.resolve({ ok: true, result: true } as never);
  });

  const handled: number[] = [];
  bot.use(async (ctx, next) => {
    handled.push(ctx.update.update_id);
    await next();
  });

  const rawLog = (): string => chunks.join('');
  const logLines = (): Record<string, unknown>[] =>
    rawLog()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  return {
    bot,
    db,
    calls,
    handled,
    logLines,
    rawLog,
    clock,
    send: (update) => bot.handleUpdate(update),
  };
}

let nextUpdateId = 1;

export interface Sender {
  readonly id: number;
  readonly username?: string;
  readonly firstName?: string;
}

function fromOf(sender: Sender): {
  id: number;
  is_bot: false;
  first_name: string;
  username?: string;
} {
  return {
    id: sender.id,
    is_bot: false,
    first_name: sender.firstName ?? 'First',
    ...(sender.username === undefined ? {} : { username: sender.username }),
  };
}

export function messageUpdate(sender: Sender, text: string): Update {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      date: 1_700_000_000,
      chat: { id: sender.id + CHAT_ID_OFFSET, type: 'private', first_name: 'First' },
      from: fromOf(sender),
      text,
    },
  };
}

export function callbackUpdate(sender: Sender, data: string): Update {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: `cb-${String(nextUpdateId)}`,
      chat_instance: 'instance',
      from: fromOf(sender),
      data,
    },
  };
}

/** A channel post: it has no `from`. */
export function channelPostUpdate(text: string): Update {
  return {
    update_id: nextUpdateId++,
    channel_post: {
      message_id: nextUpdateId,
      date: 1_700_000_000,
      chat: { id: -100123, type: 'channel', title: 'News' },
      text,
    },
  };
}

/** A my_chat_member update (a user blocking the bot): it has `from` but is not a message. */
export function myChatMemberUpdate(sender: Sender): Update {
  return {
    update_id: nextUpdateId++,
    my_chat_member: {
      chat: { id: sender.id + CHAT_ID_OFFSET, type: 'private', first_name: 'First' },
      from: fromOf(sender),
      date: 1_700_000_000,
      old_chat_member: { status: 'member', user: { id: 1, is_bot: true, first_name: 'Bot' } },
      new_chat_member: {
        status: 'kicked',
        user: { id: 1, is_bot: true, first_name: 'Bot' },
        until_date: 0,
      },
    },
  };
}

export function generateInviteToken(): string {
  return randomBytes(16).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function userCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

/** Makes `ownerId` own a library (needed so invites have a valid library and creator). */
export function createLibraryFor(db: Database, ownerId: number): number {
  upsertUser(db, { id: ownerId, username: null, firstName: 'Owner' });
  return createPersonalLibrary(db, ownerId, 'Owner library').id;
}

export interface InviteSeed {
  readonly libraryId: number;
  readonly createdBy: number;
  readonly username?: string;
  readonly token?: string;
  readonly expiresAt?: string;
  readonly acceptedAt?: string;
  readonly revokedAt?: string;
}

export function addInvite(db: Database, seed: InviteSeed): void {
  const isUsername = seed.username !== undefined;
  db.prepare(
    `INSERT INTO invites (library_id, created_by, kind, token_hash, username, expires_at, accepted_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.libraryId,
    seed.createdBy,
    isUsername ? 'username' : 'link',
    isUsername ? null : sha256Hex(seed.token ?? generateInviteToken()),
    seed.username?.toLowerCase() ?? null,
    seed.expiresAt ?? new Date(Date.now() + HOUR_MS).toISOString(),
    seed.acceptedAt ?? null,
    seed.revokedAt ?? null,
  );
}
