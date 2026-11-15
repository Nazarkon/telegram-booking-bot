import { describe, expect, it } from 'vitest';

import { ConfigError, parseConfig } from '../src/config.js';

const SECRET_TOKEN = '123456789:AAFake-Secret_tokenValue';

function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    BOT_TOKEN: SECRET_TOKEN,
    ALLOWED_USER_IDS: '111, 222',
    DB_PATH: '/data/library.db',
    COVERS_DIR: '/data/covers',
    LOG_LEVEL: 'debug',
    ...overrides,
  };
}

function captureError(env: Record<string, string | undefined>): Error {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('parseConfig did not throw');
}

describe('parseConfig', () => {
  it('parses a valid environment into a typed config', () => {
    const config = parseConfig(validEnv());

    expect(config).toEqual({
      botToken: SECRET_TOKEN,
      allowedUserIds: [111, 222],
      dbPath: '/data/library.db',
      coversDir: '/data/covers',
      logLevel: 'debug',
    });
  });

  it('applies local defaults for optional variables', () => {
    const config = parseConfig({ BOT_TOKEN: SECRET_TOKEN, ALLOWED_USER_IDS: '5' });

    expect(config.dbPath).toBe('./data/library.db');
    expect(config.coversDir).toBe('./data/covers');
    expect(config.logLevel).toBe('info');
  });

  it('removes duplicate user IDs', () => {
    expect(parseConfig(validEnv({ ALLOWED_USER_IDS: '7,7,8' })).allowedUserIds).toEqual([7, 8]);
  });

  it('rejects a missing BOT_TOKEN', () => {
    const error = captureError(validEnv({ BOT_TOKEN: undefined }));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('BOT_TOKEN');
  });

  it('rejects a malformed BOT_TOKEN without echoing it', () => {
    const malformed = 'not-a-valid-token-SUPERSECRET';
    const error = captureError(validEnv({ BOT_TOKEN: malformed }));

    expect(error.message).toContain('BOT_TOKEN');
    expect(error.message).not.toContain(malformed);
    expect(error.message).not.toContain('SUPERSECRET');
  });

  it('does not echo a valid BOT_TOKEN when another variable is invalid', () => {
    const error = captureError(validEnv({ LOG_LEVEL: 'loud' }));

    expect(error.message).toContain('LOG_LEVEL');
    expect(error.message).not.toContain(SECRET_TOKEN);
    expect(error.message).not.toContain('AAFake');
  });

  it.each([
    ['empty', ''],
    ['only whitespace', '  '],
    ['non-numeric', 'abc'],
    ['partly non-numeric', '1,two,3'],
    ['zero', '0'],
    ['negative', '-5'],
    ['decimal', '1.5'],
    ['blank item', '1,,2'],
    ['trailing comma', '1,2,'],
    ['unsafe integer', '99999999999999999999'],
  ])('rejects ALLOWED_USER_IDS that is %s', (_label, value) => {
    const error = captureError(validEnv({ ALLOWED_USER_IDS: value }));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('ALLOWED_USER_IDS');
  });

  it('rejects a missing ALLOWED_USER_IDS', () => {
    const error = captureError(validEnv({ ALLOWED_USER_IDS: undefined }));

    expect(error.message).toContain('ALLOWED_USER_IDS');
  });

  it('rejects an invalid LOG_LEVEL', () => {
    const error = captureError(validEnv({ LOG_LEVEL: 'verbose' }));

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('LOG_LEVEL');
  });

  it.each(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])(
    'accepts LOG_LEVEL %s',
    (level) => {
      expect(parseConfig(validEnv({ LOG_LEVEL: level })).logLevel).toBe(level);
    },
  );

  it('rejects an empty DB_PATH', () => {
    expect(captureError(validEnv({ DB_PATH: ' ' })).message).toContain('DB_PATH');
  });
});
