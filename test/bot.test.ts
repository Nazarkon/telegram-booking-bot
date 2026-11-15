import { BotError, HttpError } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RATE_LIMIT,
  RATE_LIMIT_MAX_UPDATES,
  RATE_LIMIT_WINDOW_MS,
} from '../src/bot/bot.js';
import { getUser } from '../src/db/repositories/users.js';
import {
  BOT_TOKEN,
  callbackUpdate,
  createHarness,
  messageUpdate,
  userCount,
} from './helpers/botHarness.js';
import type { Harness } from './helpers/botHarness.js';

const ALLOWED = 100;
const OTHER_ALLOWED = 101;
const STRANGER = 300;

let h: Harness | undefined;

function harness(options?: Parameters<typeof createHarness>[0]): Harness {
  h = createHarness({ allowedUserIds: [ALLOWED, OTHER_ALLOWED], ...options });
  return h;
}

afterEach(() => {
  h?.db.close();
  h = undefined;
});

describe('user upsert', () => {
  it('creates a users row for an allowed user', async () => {
    const { send, db } = harness();

    await send(messageUpdate({ id: ALLOWED, username: 'alice', firstName: 'Alice' }, 'hi'));

    expect(getUser(db, ALLOWED)).toMatchObject({
      id: ALLOWED,
      username: 'alice',
      firstName: 'Alice',
    });
  });

  it('updates the row when the username changes', async () => {
    const { send, db } = harness();
    await send(messageUpdate({ id: ALLOWED, username: 'alice', firstName: 'Alice' }, 'hi'));

    await send(messageUpdate({ id: ALLOWED, username: 'alice_new', firstName: 'Alicia' }, 'hi'));

    expect(getUser(db, ALLOWED)).toMatchObject({ username: 'alice_new', firstName: 'Alicia' });
    expect(userCount(db)).toBe(1);
  });

  it('stores a null username when the user has none', async () => {
    const { send, db } = harness();

    await send(messageUpdate({ id: ALLOWED }, 'hi'));

    expect(getUser(db, ALLOWED)?.username).toBeNull();
  });

  it('runs before the handlers, so a handler can rely on the row', async () => {
    const { send, db, bot } = harness();
    let rowSeenByHandler = false;
    bot.use((ctx) => {
      rowSeenByHandler = getUser(db, ctx.from?.id ?? 0) !== null;
    });

    await send(messageUpdate({ id: ALLOWED }, 'hi'));

    expect(rowSeenByHandler).toBe(true);
  });

  it('does not run for a stranger', async () => {
    const { send, db } = harness();

    await send(messageUpdate({ id: STRANGER, username: 'nobody' }, 'hi'));

    expect(userCount(db)).toBe(0);
  });
});

describe('per-user rate limit', () => {
  const LIMIT = 3;

  it('uses sensible documented defaults', () => {
    // 5 updates per 3 seconds, as documented next to the constants.
    expect(DEFAULT_RATE_LIMIT).toEqual({ windowMs: 3000, maxUpdates: 5 });
    expect(RATE_LIMIT_WINDOW_MS).toBe(3000);
    expect(RATE_LIMIT_MAX_UPDATES).toBe(5);
  });

  it('stops handlers for a user who exceeds the limit, but not for others', async () => {
    const { send, handled } = harness({ rateLimit: { windowMs: 60_000, maxUpdates: LIMIT } });
    const flood = Array.from({ length: LIMIT + 2 }, () => messageUpdate({ id: ALLOWED }, 'x'));
    const other = messageUpdate({ id: OTHER_ALLOWED }, 'x');

    for (const update of flood) await send(update);
    await send(other);

    expect(handled).toEqual([...flood.slice(0, LIMIT).map((u) => u.update_id), other.update_id]);
  });

  it('counts callback queries too and never replies to the excess', async () => {
    const { send, handled, calls } = harness({ rateLimit: { windowMs: 60_000, maxUpdates: 1 } });

    await send(callbackUpdate({ id: ALLOWED }, 'a'));
    await send(callbackUpdate({ id: ALLOWED }, 'b'));
    await send(callbackUpdate({ id: ALLOWED }, 'c'));

    expect(handled).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('runs before the access gate: a flooding stranger reaches the gate only up to the limit', async () => {
    const { send, logLines } = harness({ rateLimit: { windowMs: 60_000, maxUpdates: 2 } });

    for (let i = 0; i < 6; i++) await send(messageUpdate({ id: STRANGER }, 'x'));

    const denials = logLines().filter((line) => line.msg === 'access denied');
    expect(denials).toHaveLength(2);
  });

  it('logs one warning per exceeded limit, naming the user and never the content', async () => {
    const { send, logLines } = harness({ rateLimit: { windowMs: 60_000, maxUpdates: 2 } });

    for (let i = 0; i < 6; i++) await send(messageUpdate({ id: ALLOWED }, 'secret text'));

    const warnings = logLines().filter((line) => line.msg === 'rate limit exceeded');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 40, userId: ALLOWED });
    expect(JSON.stringify(warnings[0])).not.toContain('secret text');
  });

  it('does not upsert the user for updates it dropped', async () => {
    const { send, db } = harness({ rateLimit: { windowMs: 60_000, maxUpdates: 1 } });
    await send(messageUpdate({ id: ALLOWED, username: 'first' }, 'x'));

    await send(messageUpdate({ id: ALLOWED, username: 'second' }, 'x'));

    expect(getUser(db, ALLOWED)?.username).toBe('first');
  });
});

describe('bot.catch', () => {
  const secretPart = BOT_TOKEN.split(':')[1] ?? '';

  async function failWith(error: unknown): Promise<BotError> {
    const { bot, send } = harness();
    let thrown = false;
    bot.use(async (_ctx, next) => {
      if (thrown) return next();
      thrown = true;
      throw error;
    });
    const update = messageUpdate({ id: ALLOWED }, 'boom');
    const caught = await send(update).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(caught).toBeInstanceOf(BotError);
    return caught as BotError;
  }

  it('logs a failing handler with structured fields and does not throw', async () => {
    const botError = await failWith(new Error('handler exploded'));
    const { bot, logLines } = h as Harness;

    expect(() => {
      bot.errorHandler(botError);
    }).not.toThrow();

    const line = logLines().find((entry) => entry.level === 50);
    expect(line).toMatchObject({
      level: 50,
      updateId: botError.ctx.update.update_id,
      userId: ALLOWED,
      err: { type: 'Error', message: 'handler exploded' },
    });
    expect(typeof (line?.err as { stack?: unknown }).stack).toBe('string');
  });

  it('keeps processing later updates after an error', async () => {
    const botError = await failWith(new Error('first one fails'));
    const { bot, send, handled } = h as Harness;
    bot.errorHandler(botError);
    const before = handled.length;

    await send(messageUpdate({ id: OTHER_ALLOWED }, 'next'));

    expect(handled.length).toBe(before + 1);
  });

  it('is what long polling uses: a failing update is logged and polling carries on', async () => {
    const { bot, handled, logLines, calls } = harness();
    const failing = messageUpdate({ id: ALLOWED }, 'fails');
    const healthy = messageUpdate({ id: OTHER_ALLOWED }, 'fine');
    bot.use(async (ctx, next) => {
      if (ctx.update.update_id === failing.update_id) throw new Error('polling boom');
      await next();
    });
    let served = false;
    // Replaces the network: the first getUpdates returns both updates, later ones wait until
    // polling is cancelled. Registered last, so it runs first and never calls the real fetch.
    bot.api.config.use((_prev, method, _payload, signal) => {
      calls.push({ method, payload: {} });
      if (method !== 'getUpdates') return Promise.resolve({ ok: true, result: true } as never);
      if (!served) {
        served = true;
        return Promise.resolve({ ok: true, result: [failing, healthy] } as never);
      }
      return new Promise((resolve) => {
        if (signal === undefined) resolve({ ok: true, result: [] } as never);
        signal?.addEventListener('abort', () => {
          resolve({ ok: true, result: [] } as never);
        });
      });
    });

    const polling = bot.start();
    await vi.waitFor(() => {
      expect(handled).toContain(healthy.update_id);
    });
    await bot.stop();
    await polling;

    const errors = logLines().filter((entry) => entry.level === 50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      updateId: failing.update_id,
      err: { message: 'polling boom' },
    });
  });

  it('logs a non-Error throw without crashing', async () => {
    const botError = await failWith('just a string');
    const { bot, logLines } = h as Harness;

    bot.errorHandler(botError);

    expect(logLines().some((entry) => entry.level === 50)).toBe(true);
  });

  it('does not log the update content', async () => {
    const botError = await failWith(new Error('x'));
    const { bot, rawLog } = h as Harness;

    bot.errorHandler(botError);

    expect(rawLog()).not.toContain('boom');
  });

  it('never lets the bot token reach the logs, in message, stack, cause or URL', async () => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const inner = new Error(`request to ${url} failed`);
    const error = new Error(`token ${BOT_TOKEN} leaked in message`, {
      cause: new Error(`nested cause with ${BOT_TOKEN}`, { cause: inner }),
    });
    error.stack = `Error: ${BOT_TOKEN}\n    at ${url}`;
    const botError = await failWith(error);
    const { bot, rawLog } = h as Harness;

    bot.errorHandler(botError);

    const output = rawLog();
    expect(output).not.toContain(BOT_TOKEN);
    expect(output).not.toContain(secretPart);
    expect(output).toContain('[REDACTED]');
  });

  it('scrubs a grammY HttpError wrapping a fetch failure that mentions the token URL', async () => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const botError = await failWith(
      new HttpError(`Network request for 'sendMessage' failed!`, new Error(`getaddrinfo ${url}`)),
    );
    const { bot, rawLog } = h as Harness;

    bot.errorHandler(botError);

    expect(rawLog()).not.toContain(secretPart);
    expect(rawLog()).toContain('sendMessage');
  });
});
