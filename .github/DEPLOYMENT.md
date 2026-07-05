# Deployment Workflow

```
Development  →  Staging  →  Production
(local/branch)   (staging     (main branch,
                  branch)      goreturn.pro)
```

## Current verified state (as of this batch)

- ✅ CI runs on every push/PR to `main` and `staging` (`.github/workflows/ci.yml`) —
  syntax checks + full automated test suite against an ephemeral Postgres container.
  **Confirmed passing**: 22/22 tests green on the first real run after the token/workflow-scope
  fix (GitHub Actions run history has the record).
- ✅ `staging` branch exists on GitHub, fast-forwarded to match `main` exactly (was 3 commits
  behind, updated as part of this check — a plain git ref update, no production database touched).
  CI confirmed triggering on pushes to `staging` too.
- ❌ No staging Railway service exists yet — this repo change alone can't create one (needs
  Railway dashboard access). See "Setting up the staging Railway service" below.
- ⚠️ CI passing does **not** currently block a bad deploy to production — see
  `RAILWAY_PROTECTION.md` for what that requires and why it's a manual step.

## 1. Development

- Work happens on `main` directly today (no feature-branch requirement yet — that's a bigger
  process change than this batch's scope). Every push triggers CI automatically.
- Before pushing: run `node -c server/index.js` and `node scripts/check-client-syntax.js`
  locally if you have time — CI will catch it either way, but catching it before push is faster.

## 2. Staging

**Purpose:** verify a change against a real, running instance of the app — real OAuth flow, real
Shopify webhooks, real email delivery — before it touches the production database or real
merchants. This is what CI's ephemeral-Postgres test run *can't* cover (those tests deliberately
avoid real Shopify/email/payment calls).

**Setting up the staging Railway service (one-time, manual — you do this in the Railway
dashboard, not something this repo change can do):**
1. Railway dashboard → New Service → Deploy from GitHub repo → same repo, but set the
   **branch to `staging`** instead of `main`.
2. Give it its own Postgres database (Railway → Add Database → Postgres) — **never point staging
   at the production database**, since `shop/redact`, refund creation, etc. would then act on
   real merchant data.
3. Set environment variables (full list below) — with `APP_URL` pointing at the staging service's
   own Railway URL, and ideally a **separate Shopify dev app / dev store** for OAuth testing so
   staging installs never touch a real merchant's store.
4. No code changes are required for this to work — the app already reads every config value from
   `process.env` (confirmed by grepping `server/index.js` for every `process.env.*` reference),
   and the only hardcoded `goreturn.pro` references in the code are `||` fallback defaults that
   never trigger once `APP_URL`/`EMAIL_FROM` are set — so a second Railway service with its own
   env vars just works, no code branch needed.

**Complete list of environment variables the app reads** (compiled by grepping
`server/index.js`, `server/logistics-providers.js`, `server/restore-backup.js` for every
`process.env.*` reference):

| Variable | Purpose | Staging value |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | Staging's own Postgres — **never** the production DB URL |
| `APP_URL` | Used for OAuth redirect URLs, CORS allowlist, CSP, email links | Staging Railway service's own URL |
| `SHOPIFY_CLIENT_ID` | Shopify app API key | Ideally a **separate Shopify dev app**, not the production app's key |
| `SHOPIFY_APP_SHARED_SECRET` | Shopify app secret (HMAC/OAuth verification) | Matches whichever Shopify app `SHOPIFY_CLIENT_ID` above belongs to |
| `CREDENTIAL_ENCRYPTION_KEY` | AES-256-GCM key for encrypting stored Shopify tokens | Generate a **new, separate** 64-char hex key — do not reuse production's key |
| `RESEND_API_KEY` | Transactional email sending | Can reuse production's Resend account, or a separate one to keep staging emails visually distinct |
| `EMAIL_FROM` | From-address for outgoing email | Something like `GoReturn Staging <noreply@staging.goreturn.pro>` to avoid confusing real merchants |
| `DEBUG_KEY` | Gates `/api/debug/*` routes | Generate a separate value, don't reuse production's |
| `NODE_ENV` | Controls SSL mode for the DB connection, cookie/security defaults | `production` (staging should mirror prod behavior, just with its own data) |
| `PORT` | Server listen port | Railway sets this automatically — don't set manually |
| `SHIPROCKET_EMAIL` / `SHIPROCKET_PASSWORD` | Shiprocket courier API login | Only needed if testing logistics integration on staging; a sandbox/test Shiprocket account if available, otherwise omit (logistics features will just be unavailable on staging) |

**Do NOT** point staging's `DATABASE_URL` at the production database under any circumstance —
`shop/redact`, refund creation, team-member deletion, and the billing-sync downgrade sweep all
write real data, and staging is explicitly for testing those paths without consequence.

**Using it:**
1. Merge/push to `staging` → CI runs → Railway auto-deploys staging (once the service above
   exists).
2. Manually click through the flows that matter for the change (admin login, seller dashboard,
   a test return, OAuth install against a dev store, a real webhook if testable).
3. Only after staging looks right, merge `staging` into `main`.

## 3. Production

- `main` branch → Railway's existing production service → `goreturn.pro`.
- Deploys automatically on push today. See `RAILWAY_PROTECTION.md` for how to gate this properly.

## Rollback

Since this app is a single-file monolith with small, isolated commits (the pattern used all day
in Batches 1–3), rollback is just `git revert <bad-commit>` and push — Railway redeploys the
reverted state automatically. No migration rollback needed so far, since every DB change made in
this session has been purely additive (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`)
— reverting the code doesn't strand the schema in a broken state.
