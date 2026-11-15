import type { Database } from 'better-sqlite3';
import { Bot, type BotError } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { limit } from '@grammyjs/ratelimiter';
import type { Logger } from 'pino';

import type { Config } from '../config.js';
import { createAccessGate } from './middleware/access.js';
import { createUserUpsert } from './middleware/upsertUser.js';

/**
 * Per-user rate limit: at most RATE_LIMIT_MAX_UPDATES updates per RATE_LIMIT_WINDOW_MS. A fast
 * human tapping buttons stays well under it; a script or a flood does not. Excess updates are
 * dropped without a reply, so the limit can't be used to make the bot talk. The limiter keeps
 * fixed windows in memory, which is fine for the single process the bot runs as.
 */
export const RATE_LIMIT_WINDOW_MS = 3000;
export const RATE_LIMIT_MAX_UPDATES = 5;

export interface RateLimitSettings {
  readonly windowMs: number;
  readonly maxUpdates: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitSettings = {
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxUpdates: RATE_LIMIT_MAX_UPDATES,
};

export interface BotDeps {
  readonly config: Pick<Config, 'botToken' | 'allowedUserIds'>;
  readonly db: Database;
  readonly logger: Logger;
  /** Pass it in tests so grammY never calls getMe. In production it is fetched on start. */
  readonly botInfo?: UserFromGetMe;
  readonly rateLimit?: RateLimitSettings;
  /** Clock for the access gate's denial window. */
  readonly now?: () => number;
}

/**
 * The error handler behind `bot.catch`: logs the failure with structured fields and returns,
 * so the polling loop keeps going. The update's content is deliberately not logged. The bot
 * token is scrubbed by the logger itself (see `createLogger`).
 */
export function createErrorHandler(logger: Logger): (error: BotError) => void {
  return (error) => {
    logger.error(
      {
        err: error.error,
        updateId: error.ctx.update.update_id,
        userId: error.ctx.from?.id,
      },
      'unhandled error while processing update',
    );
  };
}

/**
 * Builds the bot and its middleware chain, in this order: per-user rate limit, access gate,
 * user upsert. Handlers are registered after this (none yet), then `bot.catch`. Does not start
 * polling.
 */
export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(
    deps.config.botToken,
    deps.botInfo === undefined ? {} : { botInfo: deps.botInfo },
  );
  const rateLimit = deps.rateLimit ?? DEFAULT_RATE_LIMIT;

  bot.use(
    limit({
      timeFrame: rateLimit.windowMs,
      limit: rateLimit.maxUpdates,
      keyGenerator: (ctx) => ctx.from?.id.toString(),
      onLimitExceeded: (ctx) => {
        deps.logger.warn({ userId: ctx.from?.id }, 'rate limit exceeded');
      },
    }),
  );
  bot.use(
    createAccessGate({
      db: deps.db,
      allowedUserIds: deps.config.allowedUserIds,
      logger: deps.logger,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    }),
  );
  bot.use(createUserUpsert(deps.db));

  bot.catch(createErrorHandler(deps.logger));
  return bot;
}
