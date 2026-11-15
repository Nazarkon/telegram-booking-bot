import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type { Database } from 'better-sqlite3';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FATAL_EXIT_CODE, runApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { BOT_TOKEN, FAKE_BOT_INFO, messageUpdate } from './helpers/botHarness.js';

const ALLOWED = 100;
const FLUSH_MS = 50;
const FATAL_LEVEL = 60;
const ERROR_LEVEL = 50;

interface FakeTelegram {
  /** getUpdates calls made without an abort signal: grammY's final "confirm the offset" call. */
  readonly confirmCalls: () => number;
}

interface Script {
  readonly updates?: readonly Update[];
  /** Make this method answer with HTTP 401. */
  readonly unauthorizedOn?: 'deleteWebhook' | 'getUpdates';
}

/**
 * Replaces the network: getMe answers, getUpdates hands out the scripted updates once and then
 * waits until polling is cancelled, everything else succeeds. Registered through
 * `bot.api.config.use`, as in test/bot.test.ts, so grammY never calls fetch.
 */
function fakeTelegram(bot: Bot, script: Script): FakeTelegram {
  let confirmCalls = 0;
  let served = false;
  bot.api.config.use((_prev, method, _payload, signal) => {
    if (method === script.unauthorizedOn) {
      return Promise.resolve({
        ok: false,
        error_code: 401,
        description: 'Unauthorized',
      } as never);
    }
    if (method === 'getMe') return Promise.resolve({ ok: true, result: FAKE_BOT_INFO } as never);
    if (method !== 'getUpdates') return Promise.resolve({ ok: true, result: true } as never);
    if (signal === undefined) {
      confirmCalls += 1;
      return Promise.resolve({ ok: true, result: [] } as never);
    }
    if (!served) {
      served = true;
      return Promise.resolve({ ok: true, result: script.updates ?? [] } as never);
    }
    return new Promise((resolve) => {
      const done = (): void => {
        resolve({ ok: true, result: [] } as never);
      };
      if (signal.aborted) done();
      else signal.addEventListener('abort', done);
    });
  });
  return { confirmCalls: () => confirmCalls };
}

interface Started {
  readonly signals: EventEmitter;
  readonly exit: ReturnType<typeof vi.fn<(code: number) => void>>;
  readonly done: Promise<void>;
  readonly telegram: () => FakeTelegram;
  readonly db: () => Database;
  readonly rawLog: () => string;
  readonly logLines: () => Record<string, unknown>[];
  /** Whether the database was open at the moment `exit` was called. */
  readonly dbOpenAtExit: () => boolean | undefined;
}

interface StartOptions extends Script {
  readonly dbPath?: string;
  readonly handler?: (db: Database) => Promise<void> | void;
  readonly configureBotThrows?: Error;
}

let tmpDir: string;
let openDbs: Database[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'library-bot-app-'));
  openDbs = [];
});

afterEach(() => {
  for (const db of openDbs) {
    if (db.open) db.close();
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function startApp(options: StartOptions = {}): Started {
  const chunks: string[] = [];
  const logDestination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const config: Config = {
    botToken: BOT_TOKEN,
    allowedUserIds: [ALLOWED],
    dbPath: options.dbPath ?? join(tmpDir, 'test.db'),
    coversDir: join(tmpDir, 'covers'),
    logLevel: 'info',
  };
  const signals = new EventEmitter();
  let database: Database | undefined;
  let telegram: FakeTelegram | undefined;
  let dbOpenAtExit: boolean | undefined;
  const exit = vi.fn<(code: number) => void>(() => {
    dbOpenAtExit = database?.open;
  });

  const done = runApp({
    config,
    signals,
    exit,
    logDestination,
    configureBot: (bot, db) => {
      database = db;
      openDbs.push(db);
      if (options.configureBotThrows) throw options.configureBotThrows;
      const handler = options.handler;
      if (handler) {
        bot.use(async () => {
          await handler(db);
        });
      }
      telegram = fakeTelegram(bot, options);
    },
  });

  const rawLog = (): string => chunks.join('');
  return {
    signals,
    exit,
    done,
    telegram: () => telegram as FakeTelegram,
    db: () => database as Database,
    rawLog,
    logLines: () =>
      rawLog()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    dbOpenAtExit: () => dbOpenAtExit,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('runApp: graceful shutdown on a signal', () => {
  it.each(['SIGINT', 'SIGTERM'])(
    '%s: the update in flight finishes (and can use the DB), then the DB closes, then exit(0) once',
    async (signal) => {
      const events: string[] = [];
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const app = startApp({
        updates: [messageUpdate({ id: ALLOWED }, 'hi')],
        handler: async (db) => {
          events.push('handler:start');
          await gate;
          // Throws "The database connection is not open" if the DB was closed under it.
          db.prepare('SELECT COUNT(*) AS n FROM users').get();
          events.push('handler:db-ok');
          events.push('handler:done');
        },
      });
      await vi.waitFor(() => {
        expect(events).toContain('handler:start');
      });

      app.signals.emit(signal);
      app.signals.emit(signal);
      await sleep(FLUSH_MS);

      // Shutdown has begun but must be waiting for the handler.
      expect(app.exit).not.toHaveBeenCalled();
      expect(app.db().open).toBe(true);

      release();
      await vi.waitFor(() => {
        expect(app.exit).toHaveBeenCalled();
      });
      await app.done;

      expect(events).toEqual(['handler:start', 'handler:db-ok', 'handler:done']);
      expect(app.dbOpenAtExit()).toBe(false);
      expect(app.db().open).toBe(false);
      expect(app.exit).toHaveBeenCalledTimes(1);
      expect(app.exit).toHaveBeenCalledWith(0);

      // A late signal changes nothing: no second stop, no second exit.
      app.signals.emit(signal);
      await sleep(FLUSH_MS);
      expect(app.exit).toHaveBeenCalledTimes(1);
      expect(app.telegram().confirmCalls()).toBe(1);
      expect(app.logLines().filter((line) => line.msg === 'shutting down')).toHaveLength(1);
      expect(app.logLines().filter((line) => line.level === ERROR_LEVEL)).toEqual([]);
    },
  );
});

describe('runApp: polling dies on its own', () => {
  it.each(['deleteWebhook', 'getUpdates'] as const)(
    '401 from %s: fatal log, DB closed, exit(1)',
    async (method) => {
      const app = startApp({ unauthorizedOn: method });

      await app.done;

      const fatal = app.logLines().filter((line) => line.level === FATAL_LEVEL);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]).toMatchObject({
        msg: 'long polling stopped with an error',
        err: { message: expect.stringContaining('Unauthorized') as unknown },
      });
      expect(app.exit).toHaveBeenCalledTimes(1);
      expect(app.exit).toHaveBeenCalledWith(FATAL_EXIT_CODE);
      expect(app.dbOpenAtExit()).toBe(false);
      expect(app.db().open).toBe(false);
    },
  );
});

describe('runApp: logger wiring', () => {
  it('logs through the app logger with the bot token scrubbed, even from a Bot API URL in an error', async () => {
    const secretPart = BOT_TOKEN.split(':')[1] ?? '';
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const app = startApp({
      updates: [messageUpdate({ id: ALLOWED }, 'hi')],
      handler: () => {
        throw new Error(`request to ${url} failed`);
      },
    });
    await vi.waitFor(() => {
      expect(app.logLines().some((line) => line.level === ERROR_LEVEL)).toBe(true);
    });

    app.signals.emit('SIGINT');
    await app.done;
    await vi.waitFor(() => {
      expect(app.exit).toHaveBeenCalled();
    });

    const output = app.rawLog();
    expect(app.logLines().find((line) => line.level === ERROR_LEVEL)).toMatchObject({
      msg: 'unhandled error while processing update',
    });
    expect(output).toContain('https://api.telegram.org/bot[REDACTED]/sendMessage');
    expect(output).not.toContain(BOT_TOKEN);
    expect(output).not.toContain(secretPart);
  });

  it('writes to the given destination and logs the start with the bot username', async () => {
    const app = startApp();
    await vi.waitFor(() => {
      expect(app.logLines().some((line) => line.msg === 'bot started, long polling')).toBe(true);
    });
    expect(app.logLines().find((line) => line.msg === 'bot started, long polling')).toMatchObject({
      botUsername: FAKE_BOT_INFO.username,
    });

    app.signals.emit('SIGTERM');
    await app.done;
    await vi.waitFor(() => {
      expect(app.exit).toHaveBeenCalledWith(0);
    });
  });
});

describe('runApp: startup failures go through the logger', () => {
  it('logs fatal and exits 1 when the database cannot be opened', async () => {
    // The parent "directory" of the database is a regular file, so it can never be created.
    const blocker = join(tmpDir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const app = startApp({ dbPath: join(blocker, 'test.db') });

    await app.done;

    const fatal = app.logLines().filter((line) => line.level === FATAL_LEVEL);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({ msg: 'startup failed' });
    expect(app.exit).toHaveBeenCalledTimes(1);
    expect(app.exit).toHaveBeenCalledWith(FATAL_EXIT_CODE);
    expect(app.logLines().some((line) => line.msg === 'bot started, long polling')).toBe(false);
    expect(app.rawLog()).not.toContain(BOT_TOKEN);
  });

  it('closes the database it opened when a later startup step fails', async () => {
    const app = startApp({ configureBotThrows: new Error('configure exploded') });

    await app.done;

    expect(app.db().open).toBe(false);
    expect(app.exit).toHaveBeenCalledTimes(1);
    expect(app.exit).toHaveBeenCalledWith(FATAL_EXIT_CODE);
    expect(app.logLines().find((line) => line.level === FATAL_LEVEL)).toMatchObject({
      msg: 'startup failed',
      err: { message: 'configure exploded' },
    });
  });
});
