import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { createBot } from './bot/bot.js';
import { createLoggerFromConfig } from './logger.js';
import { createPollingStopper, createShutdown, registerShutdownSignals } from './shutdown.js';

const FATAL_EXIT_CODE = 1;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLoggerFromConfig(config);
  const db = openDatabase(config.dbPath);
  const bot = createBot({ config, db, logger });

  let polling: Promise<void> = Promise.resolve();
  const shutdown = createShutdown({
    stopPolling: createPollingStopper(bot, () => polling),
    closeDatabase: () => {
      db.close();
    },
    logger,
    exit: (code) => process.exit(code),
  });
  registerShutdownSignals(process, shutdown);

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

main().catch((error: unknown) => {
  // Reached for startup failures (bad config, DB). ConfigError messages never contain values.
  console.error(error instanceof Error ? error.message : 'startup failed');
  process.exit(FATAL_EXIT_CODE);
});
