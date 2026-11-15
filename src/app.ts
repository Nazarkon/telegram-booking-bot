import type { Database } from 'better-sqlite3';
import type { Bot } from 'grammy';
import type { DestinationStream } from 'pino';

import { createBot } from './bot/bot.js';
import type { Config } from './config.js';
import { openDatabase } from './db/index.js';
import { createLoggerFromConfig } from './logger.js';
import {
  createPollingStopper,
  createShutdown,
  registerShutdownSignals,
  type SignalSource,
} from './shutdown.js';

export const FATAL_EXIT_CODE = 1;

export interface AppDeps {
  readonly config: Config;
  /** `process` in production; a plain EventEmitter in tests. */
  readonly signals: SignalSource;
  /** `process.exit` in production. Called exactly once, after the database is closed. */
  readonly exit: (code: number) => void;
  /** Where log lines go. Defaults to stdout; tests pass a stream to read them. */
  readonly logDestination?: DestinationStream;
  /**
   * Called with the bot and the open database before polling starts (grammY forbids `use`
   * after that). Tests use it to add handlers and to replace the Bot API with a fake.
   */
  readonly configureBot?: (bot: Bot, db: Database) => void;
}

/**
 * Wires and runs the application, in this order: logger (token scrubbed), database, bot,
 * shutdown signals, long polling. Resolves when polling ends; the process exit itself is
 * delegated to `exit`, which runs after the in-flight update finished and the database closed.
 *
 * Startup failures after the logger exists (for example the database can't be opened) are
 * logged through it as `fatal`, then `exit(1)`.
 */
export async function runApp(deps: AppDeps): Promise<void> {
  const { config, signals, exit } = deps;
  const logger = createLoggerFromConfig(config, deps.logDestination);

  let db: Database | undefined;
  let bot: Bot;
  try {
    db = openDatabase(config.dbPath);
    bot = createBot({ config, db, logger });
    deps.configureBot?.(bot, db);
  } catch (error) {
    logger.fatal({ err: error }, 'startup failed');
    try {
      db?.close();
    } catch (closeError) {
      logger.error({ err: closeError }, 'failed to close the database after a startup failure');
    }
    exit(FATAL_EXIT_CODE);
    return;
  }
  const openDb = db;

  let polling: Promise<void> = Promise.resolve();
  const shutdown = createShutdown({
    stopPolling: createPollingStopper(bot, () => polling),
    closeDatabase: () => {
      openDb.close();
    },
    logger,
    exit,
  });
  registerShutdownSignals(signals, shutdown);

  polling = bot.start({
    onStart: (botInfo) => {
      logger.info({ botUsername: botInfo.username }, 'bot started, long polling');
    },
  });
  try {
    await polling;
  } catch (error) {
    // Polling died on its own (for example 401 or a 409 conflict with a second poller).
    logger.fatal({ err: error }, 'long polling stopped with an error');
    polling = Promise.resolve();
    await shutdown('polling-error', FATAL_EXIT_CODE);
  }
}
