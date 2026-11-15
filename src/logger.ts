import { pino, type DestinationStream, type Logger } from 'pino';

import type { Config, LogLevel } from './config.js';

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

export interface LoggerOptions {
  /**
   * Secret strings (the bot token) that must never appear in any log line. Every occurrence
   * is replaced in the final serialized line, so it does not matter where the secret hides:
   * a message, a stack, a nested `cause`, a URL like `https://api.telegram.org/bot<TOKEN>/…`
   * inside an error message, or a field nobody thought of.
   */
  readonly secrets?: readonly string[];
}

/**
 * Every spelling of a secret that can show up in a serialized JSON log line: as is, as the
 * JSON string encoding of it (escapes for quotes and backslashes) and URL-encoded.
 */
function secretForms(secret: string): string[] {
  const forms = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)];
  return [...new Set(forms)];
}

/**
 * Builds a function that replaces every occurrence of every secret in a string. Empty secrets
 * are ignored (replacing "" would shred the line). Longer forms are replaced first so one
 * secret that contains another is removed whole.
 */
export function createScrubber(secrets: readonly string[]): (text: string) => string {
  const forms = secrets
    .filter((secret) => secret.length > 0)
    .flatMap(secretForms)
    .sort((a, b) => b.length - a.length);
  if (forms.length === 0) return (text) => text;
  return (text) =>
    forms.reduce((scrubbed, form) => scrubbed.split(form).join(REDACTED_VALUE), text);
}

export function createLogger(
  level: LogLevel,
  destination?: DestinationStream,
  loggerOptions: LoggerOptions = {},
): Logger {
  const scrub = createScrubber(loggerOptions.secrets ?? []);
  const options = {
    level,
    redact: { paths: [...REDACT_PATHS], censor: REDACTED_VALUE },
    // Runs on the final JSON line, right before it is written.
    hooks: { streamWrite: scrub },
  };
  return destination ? pino(options, destination) : pino(options);
}

/** The application logger: level from the config, and the bot token scrubbed from every line. */
export function createLoggerFromConfig(config: Config, destination?: DestinationStream): Logger {
  return createLogger(config.logLevel, destination, { secrets: [config.botToken] });
}
