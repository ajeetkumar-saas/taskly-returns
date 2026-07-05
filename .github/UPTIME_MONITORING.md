# Uptime Monitoring Setup (UptimeRobot or Better Stack)

## What `/api/health` now reports (Batch 5 Part 3)

```json
{
  "ok": true,
  "version": "3.6.0-features",
  "database": { "connected": true, "latency_ms": 40 },
  "shiprocket": true,
  "email": true,
  "monitoring": false,
  "last_email_error": "none",
  "last_successful_backup": "2026-07-05T07:36:24.099Z",
  "webhook_failures_since_boot": 0
}
```

- `ok` — **true only if the database is actually reachable** (a real `SELECT 1`, not just "the
  process is running"). Returns HTTP **503** if the DB check fails or times out (3s). This is the
  field your uptime monitor should alert on.
- `database.connected` / `database.latency_ms` — direct DB health + response time.
- `shiprocket` / `email` — whether those integrations have credentials configured (not a live
  check, just "is this feature possible right now").
- `monitoring` — whether Sentry is active (see `SENTRY_DSN` setup — currently `false` until that
  env var is set in Railway).
- `last_successful_backup` — timestamp of the last successful daily backup email. If this stops
  updating for >24h, the backup job itself may be stuck even if the app is otherwise healthy.
- `webhook_failures_since_boot` — count of genuine 5xx webhook failures since the process last
  started. A rising number here means Shopify webhooks are failing (GDPR/refund-sync risk).

## Option A: UptimeRobot (free tier is sufficient)

1. Sign up at uptimerobot.com, click **Add New Monitor**
2. Monitor Type: **HTTP(s)**
3. URL: `https://goreturn.pro/api/health`
4. Monitoring Interval: 5 minutes (free tier minimum)
5. Under **Advanced** → **Keyword monitoring** (paid feature) or just rely on status code:
   UptimeRobot's HTTP monitor already alerts on non-2xx responses, so the 503-on-DB-failure
   behavior above is enough to trigger an alert without needing keyword matching.
6. Alert Contacts: add your email (and Slack/webhook if you have one) under **My Settings →
   Add Alert Contact**
7. Save — you'll now get an alert within ~5-10 minutes of the health check failing.

**Optional — a second monitor for the homepage** (`https://goreturn.pro/`) catches failures that
`/api/health` itself might not reflect (e.g., if `express.static` or a specific static route
handler broke but the DB is still fine).

## Option B: Better Stack (formerly Better Uptime) — more detail, has a free tier too

1. Sign up at betterstack.com/uptime
2. **Create Monitor** → HTTP monitor
3. URL: `https://goreturn.pro/api/health`
4. Check frequency: as low as 30s on the free tier (much faster detection than UptimeRobot's 5 min)
5. Under **Expected status codes**, set `200` as the only success code — this makes the monitor
   correctly treat the new 503-on-DB-failure response as down, matching the point of Part 3's fix
6. Set up an **Escalation Policy** (email → SMS → phone call, based on how long it's down) if you
   want tiered alerting instead of a single notification
7. Better Stack also supports parsing the JSON body directly (**Response validation** → JSONPath) —
   you can optionally add a rule like `$.database.connected == true` for an extra explicit check,
   though the status-code approach above already covers it

## What this does NOT cover (be aware)

- Neither service checks the **Shopify OAuth flow** or **webhook delivery** end-to-end — they only
  confirm the app process + database are reachable. A broken Shopify API integration (e.g. an
  expired API version, a revoked app credential) wouldn't show as "down" here.
- `webhook_failures_since_boot` resets to 0 on every deploy/restart — it's a since-boot counter,
  not a persisted metric. For longer-term webhook failure tracking, the Sentry integration (Part 2)
  is the better source once `SENTRY_DSN` is configured, since those events persist independent of
  process restarts.
