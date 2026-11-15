import type { Database } from 'better-sqlite3';
import type { MiddlewareFn } from 'grammy';

import { upsertUser } from '../../db/repositories/users.js';

/**
 * Creates or refreshes the sender's `users` row (id, username, first name) on every update.
 * It must run AFTER the access gate, so strangers never get a row.
 */
export function createUserUpsert(db: Database): MiddlewareFn {
  return async (ctx, next) => {
    const from = ctx.from;
    if (from !== undefined) {
      upsertUser(db, {
        id: from.id,
        username: from.username ?? null,
        firstName: from.first_name,
      });
    }
    await next();
  };
}
