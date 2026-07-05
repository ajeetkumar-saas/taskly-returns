# Sentry Production Error Monitoring Setup

## Overview

GoReturn uses Sentry for real-time error monitoring, crash detection, and webhook failure alerts. The integration is **optional** (gracefully degrades if not configured) but **highly recommended for production**.

---

## Step 1: Create Sentry Account & Project

1. Go to https://sentry.io
2. Sign up (free tier supports 5,000 events/month)
3. Create a new project:
   - **Platform:** Node.js
   - **Team:** (your team)
   - **Project name:** `goreturn-production` (or similar)
4. Sentry creates a `SENTRY_DSN` (Data Source Name) — copy this value

**Example DSN format:**
```
https://examplePublicKey@o0.ingest.sentry.io/0
```

---

## Step 2: Add SENTRY_DSN to Railway

1. Log in to Railway dashboard: https://railway.app
2. Open GoReturn project → **Settings** → **Variables**
3. Add new variable:
   ```
   SENTRY_DSN = https://your-key@o0.ingest.sentry.io/0
   ```
4. **Deploy** (redeploy current branch)

**Verify in Railway logs:**
```
Monitoring: Sentry initialized.
```

If you see:
```
Monitoring: SENTRY_DSN not set — error monitoring disabled
```
...the environment variable didn't apply (redeploy, clear cache, or check copy/paste).

---

## Step 3: Verify Sentry Captures Errors

### Test 1: Trigger a safe test error

**Via API (requires authentication):**
```bash
# Owner-only endpoint for testing
curl -X POST "https://goreturn.pro/api/admin/test-sentry" \
  -H "x-auth-token: YOUR_SESSION_TOKEN" \
  -H "Content-Type: application/json"
```

**Response:**
```json
{ "ok": true, "message": "Test error sent to Sentry" }
```

### Test 2: Check Sentry Dashboard

1. Open Sentry: https://sentry.io → Your Project
2. Click **Issues**
3. Look for event with title: `Test error from GoReturn (safe)`
4. Click to inspect — verify:
   - **Timestamp:** Recent (within last minute)
   - **Tags:** `environment=production`, `route=/api/admin/test-sentry`, `error_type=test`
   - **Error message:** `Test error from GoReturn`
   - **No sensitive data visible** (see Security Verification below)

---

## Step 4: Verify Sensitive Data Is NOT Sent

Open the Sentry issue and check the **Request** tab:

### ✅ Data that SHOULD NOT appear:

- **Tokens:** No `access_token`, `refresh_token`, `session_token`, `authorization` headers
- **Passwords:** No `password`, `password_hash`, `shiprocket_password`
- **OTPs:** No `otp` values
- **API Keys:** No `api_key`, `client_secret`, `client_id`, `shiprocket_token`, etc.
- **Customer PII:** No `customer_email`, `customer_phone`, `customer_name`, `email`, `phone`, `name`
- **Query Strings:** Should show `[redacted]` instead of actual values
- **Cookies:** Should show `[redacted]`

### ✅ Data that IS SAFE to appear:

- `shop_domain` (e.g., `test-store.myshopify.com`) — merchant identifier, not customer-identifying
- `route` (e.g., `/api/returns/123`) — endpoint path
- `method` (e.g., `POST`, `GET`) — HTTP method
- Error type (e.g., `webhook_failure`, `database_connection_error`)
- Stack trace (code locations)

**Example safe Sentry event:**
```json
{
  "tags": {
    "shop_domain": "test-store.myshopify.com",
    "route": "/api/webhooks/refunds-create",
    "error_type": "webhook_failure"
  },
  "extra": {
    "app": {
      "shop_domain": "test-store.myshopify.com",
      "route": "/api/webhooks/refunds-create"
    }
  },
  "request": {
    "headers": {
      "x-shopify-hmac-sha256": "[redacted]",
      "x-shopify-shop-domain": "test-store.myshopify.com",
      "x-auth-token": "[redacted]",
      "authorization": "[redacted]"
    },
    "query_string": "[redacted]"
  }
}
```

---

## Step 5: Configure Alert Notifications

In Sentry, set up alerts to email you on errors:

1. **Alerts** → **Create Alert Rule**
2. **Condition:** `is error`
3. **Filter:** (leave empty for all errors)
4. **Actions:** Send email to `owner@example.com`
5. **Frequency:** Every issue (not digests, you want real-time)

---

## What Gets Monitored

Sentry automatically captures:

| Event Type | Captured | Impact |
|-----------|----------|--------|
| Uncaught exceptions | ✅ Yes | Process crash prevented |
| Unhandled promise rejections | ✅ Yes | Silent async failure detected |
| Webhook processing failures | ✅ Yes | Return sync + GDPR compliance breaches |
| Database connection errors | ✅ Yes | Data access failures |
| Shopify API failures (401, 500, timeout) | ✅ Yes | Integration failures |
| Authentication failures | ✅ Yes | Security incidents |
| 5xx error spikes | ⚠️ Via manual `captureMessage()` | Already alerts email |

---

## Troubleshooting

### Sentry not capturing errors

**Symptom:** Test error triggered but doesn't appear in Sentry dashboard

**Fix:**
1. Verify `SENTRY_DSN` is set in Railway:
   ```bash
   echo $SENTRY_DSN  # in Railway terminal
   ```
2. Check Railway logs for:
   ```
   Monitoring: Sentry initialized.
   ```
3. Redeploy (Railway caches env vars):
   ```bash
   git push origin main
   ```
4. Wait 30 seconds for new container to boot

### "Monitoring: SENTRY_DSN not set"

**Solution:** The env var wasn't applied. In Railway:
- Clear the deploy cache
- Re-add the SENTRY_DSN variable (copy/paste carefully, no extra spaces)
- Redeploy

### Tokens appear in Sentry

**Solution:** This is a bug. Report it. Until fixed:
1. Delete the event from Sentry (data breach risk)
2. Rotate affected tokens (access_token, refresh_token, API keys)
3. Check `beforeSend()` in `server/lib/monitoring.js` — may need to add more keys to `SENSITIVE_KEYS` array

---

## Cost & Limits

**Free Tier:**
- 5,000 events/month (typically enough for 1-2 errors/day)
- Unlimited projects
- 90-day data retention

**Upgrade to Paid:**
- $29/month for 50,000 events
- More storage + longer retention

**Expected Usage for GoReturn:**
- ~1-5 errors/day (if monitoring working correctly)
- = ~30-150 events/month
- = **Easily fits free tier**

---

## Security Notes

- **Never share SENTRY_DSN publicly** (it's in env, not in code)
- **Never add customer passwords** to error context
- **Always use `[redacted]` in logs** before capturing to Sentry
- **Rotate credentials if a plaintext password appears** in a Sentry event
- **Review Sentry privacy policy** for compliance (GDPR, SOC 2, etc.)

---

## Disabling Sentry

If you want to disable monitoring:

1. Remove `SENTRY_DSN` from Railway env vars
2. Redeploy
3. App will continue normally (graceful degradation)
4. Logs will show: `Monitoring: SENTRY_DSN not set — error monitoring disabled`

---

## Testing Different Error Types

Once Sentry is active, test these error scenarios to ensure capture:

```bash
# Webhook failure (database unavailable)
# — manually stop DB, trigger webhook, restart DB

# Shopify API timeout
# — trigger order analytics on a store with 100k+ orders

# Database connection error
# — cause a short network hiccup (in staging only)

# Uncaught exception
# — reserved for actual bugs (don't create intentionally)
```

All should appear in Sentry within 30 seconds.

---

## Next: Uptime Monitoring

Once Sentry is active, proceed to [`UPTIME_MONITORING.md`](./UPTIME_MONITORING.md) for `/api/health` endpoint monitoring.
