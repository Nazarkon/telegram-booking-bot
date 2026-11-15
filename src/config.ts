import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const DEFAULT_DB_PATH = './data/library.db';
const DEFAULT_COVERS_DIR = './data/covers';
const DEFAULT_LOG_LEVEL: LogLevel = 'info';

// Telegram bot tokens look like "<numeric bot id>:<secret>".
const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]+$/;
const TELEGRAM_ID_PATTERN = /^\d+$/;

const telegramIdSchema = z
  .string()
  .regex(TELEGRAM_ID_PATTERN, 'must be a positive integer')
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

// Comma-separated Telegram user IDs. At least one is required: only allowlisted users can
// create a personal library on /start or any family library, so an empty list would leave a
// bot that nobody can bootstrap. Blank items ("1,,2" or a trailing comma) are rejected as
// likely typos.
const allowedUserIdsSchema = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim()))
  .pipe(z.array(telegramIdSchema).min(1, 'must list at least one Telegram user ID'))
  .transform((ids) => [...new Set(ids)]);

const envSchema = z.object({
  BOT_TOKEN: z.string().trim().regex(BOT_TOKEN_PATTERN, 'must look like "<bot id>:<secret>"'),
  ALLOWED_USER_IDS: allowedUserIdsSchema,
  DB_PATH: z.string().trim().min(1).default(DEFAULT_DB_PATH),
  COVERS_DIR: z.string().trim().min(1).default(DEFAULT_COVERS_DIR),
  LOG_LEVEL: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
});

export interface Config {
  readonly botToken: string;
  readonly allowedUserIds: readonly number[];
  readonly dbPath: string;
  readonly coversDir: string;
  readonly logLevel: LogLevel;
}

/** Thrown when the environment is invalid. The message never contains any variable's value. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Validates an environment object and returns the typed config. Pure: it never reads
 * `process.env`. Error messages list variable names and reasons only, so the bot token
 * can't leak through a thrown error.
 */
export function parseConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || 'env'}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration: ${problems.join('; ')}`);
  }
  const parsed = result.data;
  return {
    botToken: parsed.BOT_TOKEN,
    allowedUserIds: parsed.ALLOWED_USER_IDS,
    dbPath: parsed.DB_PATH,
    coversDir: parsed.COVERS_DIR,
    logLevel: parsed.LOG_LEVEL,
  };
}

export function loadConfig(): Config {
  return parseConfig(process.env);
}
