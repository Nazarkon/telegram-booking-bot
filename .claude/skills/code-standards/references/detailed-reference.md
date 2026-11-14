# Code Standards: Detailed Reference

> General TypeScript / Node.js practice. The examples here are deliberately **project-agnostic**: they show *how* to write code, not *what* this project's domain looks like. Project-specific rules (access, data scoping, schema, limits, wording) live in `AGENTS.md` and the plan, and `AGENTS.md` wins any conflict.

## Code Quality Principles

### 1. Readability First
- Code is read more often than it is written.
- Clear names over short ones.
- Prefer code that explains itself over comments.

### 2. KISS
- Pick the simplest solution that works.
- Don't optimize early; measure first.
- Easy to read beats clever.

### 3. DRY
- Keep shared logic in one place (a service or helper), not copied into each caller.
- Keep authorization checks and mandatory query filters inside repository/service helpers, so callers can't forget them.

### 4. YAGNI
- Build only what the current task asks for.
- No config flags, extension points, or fields for "later".

## TypeScript Standards

### Naming

```typescript
// ✅ GOOD
const searchQuery = escapeSearchInput(rawInput)
const isOwner = permissions.isOwner(userId, resourceId)
const pendingCount = orders.countPending(customerId)

// ❌ BAD
const q = esc(x)
const flag = true
const n = 5
```

Function names are verb + noun:

```typescript
// ✅ GOOD
function cancelOrder(orderId: number): void { }
function isValidEmail(email: string): boolean { }

// ❌ BAD
function order(id: number) { }
function email(s: string) { }
```

### Immutability

```typescript
// ✅ GOOD
const updated = { ...order, status: 'shipped' }

// ❌ BAD
order.status = 'shipped'
```

Mutating local variables inside one function is fine. Don't mutate objects passed in from callers or returned from repositories.

### Error Handling

- Throw typed errors for expected failures (not found, not allowed, duplicate, invalid input) so the caller can show the right message.
- Let unexpected errors reach the top-level error handler, which logs them and returns a generic message.
- Never swallow an error silently.

```typescript
// ✅ GOOD
export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}

export function getOrder(userId: number, orderId: number): Order {
  if (!permissions.canRead(userId, orderId)) throw new ForbiddenError(`user ${userId} cannot read order ${orderId}`)
  const order = orders.findById(orderId)
  if (!order) throw new NotFoundError(`order ${orderId} not found`)
  return order
}

// ❌ BAD
try {
  doSomething()
} catch {}
```

In user-facing messages, don't reveal *why* something is inaccessible ("doesn't exist" vs "belongs to someone else"). Both are just "not found".

### External Calls

Responses from third-party APIs are untrusted. Validate them with `zod` and always set a timeout.

```typescript
// ✅ GOOD
const WeatherResponse = z.object({
  city: z.string().max(200),
  temperatureC: z.number(),
})

async function fetchWeather(city: string): Promise<WeatherResponse | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  if (!res.ok) return null
  const parsed = WeatherResponse.safeParse(await res.json())
  return parsed.success ? parsed.data : null
}

// ❌ BAD
const data = await (await fetch(url)).json() // any, no timeout, no status check
```

- Validate input locally before making a network call. Don't spend a request on input you can already reject.
- Return `null` (or a typed failure) on any failure, and let the caller fall back. A failed external call must never crash the request handler.
- Downloaded files: restrict hosts, cap the size, check the content really is what you expect before using it.

### Async

`better-sqlite3` is synchronous. Don't wrap its calls in `Promise.all`; you gain nothing. Use `Promise.all` only for independent network calls.

### Types

```typescript
// ✅ GOOD
type OrderStatus = 'pending' | 'paid' | 'shipped'

interface Order {
  id: number
  customerId: number
  status: OrderStatus
  totalCents: number
  note: string | null
}

// ❌ BAD
function getOrder(id: any): any { }
```

- No `any`. If a type is truly unknown, use `unknown` and narrow it.
- Use `as` casts only at the database boundary, and only after a check.
- Model "may be absent" as `T | null` explicitly; don't rely on `undefined` leaking out of the DB layer.

## Bot Handlers (grammY)

- Handlers only coordinate: parse input, call a service, render a reply. No SQL and no business rules in handlers.
- Authorization runs in middleware or a service helper, not re-implemented in each handler.
- Never trust IDs that arrive in callback data. Treat them as user input and authorize against `ctx.from.id`.
- Callback data must stay under Telegram's 64-byte limit. Use compact encodings like `o:123:cancel` or `pg:list:2`.
- User-facing text comes from a single strings module. Reference keys, not literal strings:

```typescript
// ✅ GOOD
await ctx.reply(t.order.cancelled(order.id))

// ❌ BAD
await ctx.reply(`Order ${order.id} was cancelled`)
```

## Database (SQLite via better-sqlite3)

### Parameterized Queries Only

```typescript
// ✅ GOOD
const stmt = db.prepare('SELECT id, status FROM orders WHERE customer_id = ? AND id = ?')
const row = stmt.get(customerId, orderId)

// ❌ BAD: string interpolation = SQL injection
db.prepare(`SELECT * FROM orders WHERE customer_id = ${customerId}`).all()
```

### Column Selection

```typescript
// ✅ GOOD: only what the caller needs
db.prepare('SELECT id, status, total_cents FROM orders WHERE customer_id = ?')

// ❌ BAD
db.prepare('SELECT * FROM orders WHERE customer_id = ?')
```

### Mandatory Filters

When every query on a table must include some filter (an owner, a tenant, "not soft-deleted"), make it impossible to forget:
- Put the filter in the repository, and make its parameter **required** in the method signature.
- If the same condition appears in many queries, define it once (a shared SQL fragment or query helper) and reuse it, rather than hand-writing it each time.

```typescript
// ✅ GOOD: one place defines "active", every caller gets it
const ACTIVE = 'deleted_at IS NULL'
const listActive = db.prepare(`SELECT id, name FROM items WHERE owner_id = ? AND ${ACTIVE}`)

// ❌ BAD: each query re-types the condition, and one will eventually miss it
db.prepare('SELECT id, name FROM items WHERE owner_id = ?')
```

### Full-Text Search

- Use FTS5 with `MATCH` for text search, joined back to the base table with its mandatory filters.
- Cap input length and escape FTS syntax (quotes, `*`, `-`, `NEAR`, column filters) before building the query. Add your own `*` for prefix matching only after escaping.
- Don't use `LIKE '%…%'` for user search. SQLite's `LIKE` only ignores case for ASCII, so non-Latin text typed in a different case is missed, and it can't use an index.
- If text is normalized before indexing, normalize queries with the **same** function.

### Transactions

Any multi-step write runs in one transaction, so a failure halfway leaves nothing behind.

```typescript
// ✅ GOOD
const importRows = db.transaction((rows: Row[]) => {
  for (const row of rows) upsertRow(row)
})

// ❌ BAD: a failure halfway leaves a partial import
for (const row of rows) upsertRow(row)
```

Batch large imports (one transaction per batch), not one transaction per row.

### Invariants Enforced Twice

A rule like "at most N members per group" is checked in the service (for a friendly error) **and** enforced in the database with a constraint or trigger (so two concurrent requests can't both pass the service check). The service check alone is not enough.

## File Organization

Follow the project layout defined in the plan.

- File names: `camelCase.ts` for modules, `PascalCase` only for classes.
- SQL lives only in repositories; business rules only in services; handlers only coordinate.
- Don't create a new top-level folder without updating the plan.

## Comments

Comment the *why*, not the *what*.

```typescript
// ✅ GOOD: non-obvious reason
// SQLite's LIKE is ASCII-only case-insensitive; FTS5 handles other scripts.
const rows = searchIndex(escapeSearchInput(input))

// Telegram's 64-byte callback limit forces the compact encoding below.
const data = `o:${orderId}:cancel`

// ❌ BAD: restates the code
// Increment counter
count++
```

Public functions get a short JSDoc only when the behavior isn't obvious from the signature (e.g. "returns null when no provider responds").

## Performance

- Add indexes for the columns you filter and join on; check with `EXPLAIN QUERY PLAN` when unsure.
- Use `LIMIT` and pagination on any list sent to the user.
- Cache results of slow or rate-limited external calls.
- `ORDER BY random() LIMIT 1` is fine for random picks on small tables (thousands of rows).

## Testing (vitest)

### Structure: Arrange / Act / Assert

```typescript
test('a user cannot cancel another customer\'s order', () => {
  // Arrange
  const db = createTestDb() // :memory: with migrations applied
  const orderId = seedOrder(db, { customerId: CUSTOMER_A })

  // Act + Assert
  expect(() => cancelOrder(db, CUSTOMER_B, orderId)).toThrow(ForbiddenError)
})
```

### Naming

Name tests after the behavior they check:

```typescript
// ✅ GOOD
test('rejects an email without a domain before calling the API')
test('finds "Ärger" when searching "ärg"')
test('a second import of the same file changes nothing')

// ❌ BAD
test('works')
test('search test')
```

### What good tests do

- Fail if the behavior they guard breaks. A test that still passes with the guarded line removed is not a test.
- Use an in-memory DB with the real migrations applied, not hand-built tables.
- Use recorded fixtures for external APIs. No live network in tests; cover timeout and bad-payload paths.
- Cover authorization: for every protected operation, one test where the caller is allowed and one where they aren't.

## Code Smells

### Long functions
Split at roughly 50 lines. Pull out named steps.

### Deep nesting
Use early returns:

```typescript
// ✅ GOOD
if (!ctx.from) return
const order = findOrder(ctx.from.id, orderId)
if (!order) return replyNotFound(ctx)

// ❌ BAD
if (ctx.from) { const order = ...; if (order) { /* ... */ } }
```

### Magic numbers
Give them names:

```typescript
// ✅ GOOD
const MAX_SEARCH_LENGTH = 100
const EXTERNAL_API_TIMEOUT_MS = 5_000
const PAGE_SIZE = 10

// ❌ BAD
if (input.length > 100) { }
```

### Duplicated checks
If a handler repeats an authorization check or a mandatory filter inline, move it into the repository or service helper.

---

**Remember:** for this project's actual rules (who can access what, how data is scoped, limits), read `AGENTS.md`. This file only covers *how* to write the code.
