import { pino, type DestinationStream, type Logger } from 'pino';

import type { LogLevel } from './config.js';

const REDACTED_VALUE = '[REDACTED]';

// Pino redact paths cover the top level and one nesting level. Wildcards match any key
// name at that depth, so `config.botToken` and `err.config.BOT_TOKEN` style objects are
// caught as well as top-level fields.
export const REDACT_PATHS: readonly string[] = [
  'BOT_TOKEN',
  'botToken',
  'token',
  '*.BOT_TOKEN',
  '*.botToken',
  '*.token',
  '*.*.BOT_TOKEN',
  '*.*.botToken',
  '*.*.token',
];

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    redact: { paths: [...REDACT_PATHS], censor: REDACTED_VALUE },
  };
  return destination ? pino(options, destination) : pino(options);
}
