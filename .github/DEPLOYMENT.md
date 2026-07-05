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
- ✅ `staging` branch exists on GitHub, currently identical to `main`.
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
3. Set the same environment variables as production (`SHOPIFY_CLIENT_ID`,
   `SHOPIFY_APP_SHARED_SECRET`, `RESEND_API_KEY`, `CREDENTIAL_ENCRYPTION_KEY`, `DEBUG_KEY`) but
   with `APP_URL` pointing at the staging service's own Railway URL, and ideally a **separate
   Shopify dev app / dev store** for OAuth testing so staging installs never touch a real
   merchant's store.
4. No code changes are required for this to work — the app already reads every config value from
   `process.env` (confirmed while auditing `server/index.js`), so a second Railway service with
   its own env vars just works.

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
