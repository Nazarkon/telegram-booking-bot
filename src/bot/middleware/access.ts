import { createHash, timingSafeEqual } from 'node:crypto';

import type { Database } from 'better-sqlite3';
import type { Context, MiddlewareFn } from 'grammy';
import type { Logger } from 'pino';

import { uk } from '../../i18n/uk.js';
import { findPendingLinkInvite, hasPendingUsernameInvite } from '../../db/repositories/invites.js';
import { isMemberOfAnyLibrary } from '../../db/repositories/libraries.js';

/**
 * A stranger is told «Доступ заборонено» at most once per this window. Long enough that a
 * stranger can't make the bot spam them (or flood the Bot API), short enough that someone who
 * is added to the allowlist and retries soon after still gets a visible answer.
 */
export const DENIAL_REPLY_WINDOW_MS = 10 * 60 * 1000;

/** Upper bound on remembered strangers, so a flood of new ids can't grow memory without limit. */
export const DENIAL_THROTTLE_MAX_ENTRIES = 10_000;

// Invite tokens are base64url of >= 16 random bytes: 16 bytes encode to 22 characters.
export const INVITE_TOKEN_MIN_LENGTH = 22;
// Telegram caps a /start deep-link payload at 64 characters; the "inv_" prefix takes 4.
export const INVITE_TOKEN_MAX_LENGTH = 60;
const INVITE_TOKEN_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${String(INVITE_TOKEN_MIN_LENGTH)},${String(INVITE_TOKEN_MAX_LENGTH)}}$`,
);
// Exactly "/start inv_<payload>": no extra words, no bot suffix, no surrounding text.
const START_INVITE_COMMAND = /^\/start inv_(\S+)$/;

/** SHA-256 hex of an invite token: the only form of a token that is ever stored. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Whether the string has the shape of an invite token. Cheap, runs before any DB access. */
export function isWellFormedInviteToken(token: string): boolean {
  return INVITE_TOKEN_PATTERN.test(token);
}

/** The token of an exact `/start inv_<token>` message, or null for any other text. */
export function extractInviteToken(text: string | undefined): string | null {
  if (text === undefined) return null;
  const match = START_INVITE_COMMAND.exec(text);
  return match?.[1] ?? null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on different lengths, so check that first (length is not secret).
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Whether `token` belongs to a pending link invite. The token format is validated first and a
 * malformed token never reaches the database. The stored hash is then re-compared with the
 * computed one in constant time. Accepting the invite is not done here.
 */
export function isPendingInviteToken(db: Database, token: string): boolean {
  if (!isWellFormedInviteToken(token)) return false;
  const tokenHash = hashInviteToken(token);
  const invite = findPendingLinkInvite(db, tokenHash);
  return invite !== null && constantTimeEquals(invite.tokenHash, tokenHash);
}

/**
 * Remembers when each stranger was last told «Доступ заборонено». The map is insertion-ordered
 * and bounded: when full, the oldest entry is dropped.
 */
export class DenialThrottle {
  private readonly lastRepliedAt = new Map<number, number>();

  constructor(
    private readonly windowMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  /** True (and records the reply) if this user may be answered now; false inside the window. */
  tryAcquire(userId: number): boolean {
    const now = this.now();
    const last = this.lastRepliedAt.get(userId);
    if (last !== undefined && now - last < this.windowMs) return false;

    this.lastRepliedAt.delete(userId);
    if (this.lastRepliedAt.size >= this.maxEntries) this.evict();
    this.lastRepliedAt.set(userId, now);
    return true;
  }

  private evict(): void {
    // Entries are ordered by when they were stored, so the first one is the oldest (and the
    // first to have expired).
    while (this.lastRepliedAt.size >= this.maxEntries) {
      const oldest = this.lastRepliedAt.keys().next();
      if (oldest.done) break;
      this.lastRepliedAt.delete(oldest.value);
    }
  }
}

export interface AccessDeps {
  readonly db: Database;
  readonly allowedUserIds: readonly number[];
  readonly logger: Logger;
  /** Clock for the denial window; tests inject their own. */
  readonly now?: () => number;
}

/**
 * The access gate. It sits before every handler (invite handling included) and lets an update
 * through only if its sender is allowlisted, belongs to at least one library, or has a pending
 * invite: a username invite for their CURRENT username, or a message that is exactly
 * `/start inv_<token>` with a valid pending token.
 *
 * Everyone else gets one «Доступ заборонено» (at most once per DENIAL_REPLY_WINDOW_MS) and
 * nothing else: no handler runs, no user row is written. The denial is identical whatever the
 * reason, so it never reveals whether an invite exists. Updates without a sender are dropped.
 */
export function createAccessGate(deps: AccessDeps): MiddlewareFn {
  const allowed = new Set(deps.allowedUserIds);
  const throttle = new DenialThrottle(
    DENIAL_REPLY_WINDOW_MS,
    DENIAL_THROTTLE_MAX_ENTRIES,
    deps.now ?? Date.now,
  );

  function hasAccess(ctx: Context, userId: number): boolean {
    if (allowed.has(userId)) return true;
    if (isMemberOfAnyLibrary(deps.db, userId)) return true;
    if (hasPendingUsernameInvite(deps.db, ctx.from?.username ?? null)) return true;
    const token = extractInviteToken(ctx.message?.text);
    return token !== null && isPendingInviteToken(deps.db, token);
  }

  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;

    if (hasAccess(ctx, userId)) {
      await next();
      return;
    }

    deps.logger.info({ userId, updateId: ctx.update.update_id }, 'access denied');
    // Only messages and callback queries can be answered. Anything else (my_chat_member,
    // inline queries, ...) is dropped silently: replying to those would fail or spam.
    if (ctx.message === undefined && ctx.callbackQuery === undefined) return;
    if (!throttle.tryAcquire(userId)) return;

    if (ctx.callbackQuery === undefined) {
      await ctx.reply(uk.accessDenied);
    } else {
      await ctx.answerCallbackQuery({ text: uk.accessDenied });
    }
  };
}
