# Preventing failed code from reaching production

## Honest current state

CI (`.github/workflows/ci.yml`) runs and passes on every push to `main` — **but Railway deploys
directly on push to `main`, independent of whether CI passed or failed.** As of this batch, a
broken commit pushed to `main` would still deploy to `goreturn.pro` even if CI immediately failed
on it. Closing this gap requires steps in the Railway/GitHub dashboards that this repo's files
cannot perform alone (no API access from here to your Railway account or to change GitHub branch
protection settings). Below is exactly what to do, in order of effort/impact.

## Option A — GitHub branch protection (do this first, ~2 minutes, free)

This won't stop Railway by itself, but it stops a *known-broken* commit from ever landing on
`main` in the first place if you move to a PR-based flow instead of pushing directly:

1. GitHub repo → **Settings → Branches → Add branch protection rule**
2. Branch name pattern: `main`
3. Enable **"Require status checks to pass before merging"**
4. Search for and select the check named **`test`** (the job name in `ci.yml`)
5. Optionally also enable **"Require a pull request before merging"** — this is the bigger
   process change (no more direct pushes to `main`), but it's what makes the status-check
   requirement actually enforceable.

**Caveat:** if you keep pushing directly to `main` (as has been the pattern all session), branch
protection's "required status check" only blocks *merges*, not direct pushes, unless you also
enable "Include administrators" and remove direct-push permission. Worth deciding deliberately
rather than defaulting into it, since it changes your day-to-day workflow.

## Option B — Railway's own deploy trigger settings (check what your plan supports)

Railway dashboard → your production service → **Settings → Deploy Triggers**:
- Some Railway plans expose a "Wait for CI" or "Required checks" option that holds the deploy
  until the GitHub Actions run on that commit reports success. If your plan has this, it's the
  most direct fix — it makes CI a literal gate on the exact thing you asked for.
- If that option isn't visible on your plan, the next-best manual equivalent is: **turn off
  "Deploy on push" for the production service**, and instead deploy manually from the Railway
  dashboard (Deployments → Redeploy / Deploy latest commit) *after* confirming the GitHub Actions
  run for that commit is green. This trades convenience for safety — every production deploy
  becomes a deliberate action instead of an automatic reaction to `git push`.

## Option C — Manual discipline (works today, zero configuration)

Until A or B is set up, the practical gate is procedural: after every push to `main`, check
`https://github.com/ajeetkumar-saas/taskly-returns/actions` and confirm the run is green before
considering the deploy "done" — exactly the pattern used for every commit in Batches 1–3 this
session (push → wait → curl `/api/health` → confirm). This doesn't *prevent* a bad deploy from
going out, but it minimizes how long it stays live, since Railway deploys are typically visible
within 1–2 minutes and a revert can follow immediately.

## Recommended sequence

1. **Now:** keep using Option C (you already do this — every commit this session was
   verified against live `/api/health` post-deploy).
2. **This week:** set up Option A (branch protection )so the "required check" exists and is
   visible on every commit, even before you rely on it to physically block anything.
3. **When convenient:** check whether your Railway plan supports Option B's "Wait for CI"
   setting. If yes, turn it on — that's the real fix for "prevent failed code reaching
   production." If no, switch production's Railway service to manual-deploy-only.
