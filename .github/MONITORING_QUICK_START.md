# Monitoring Quick-Start Activation Guide

**Objective:** Enable production error monitoring + uptime monitoring in 30 minutes.

---

## 🚀 Quick Start (Copy-Paste Ready)

### Part 1: Sentry Error Monitoring (15 min)

**1. Create Sentry project:**
- Go to https://sentry.io → Sign up (free)
- Create project: Platform = "Node.js"
- You'll get a SENTRY_DSN (looks like: `https://key@org.ingest.sentry.io/123`)

**2. Add to Railway:**
```bash
# In Railway dashboard:
# GoReturn → Settings → Variables
# Add: SENTRY_DSN = [paste your DSN from Sentry]
# Save → Redeploy
```

**3. Verify it works:**
```bash
# Wait 30 seconds for deployment
# Check Railway logs:
# Should see: "Monitoring: Sentry initialized."

# If you see: "SENTRY_DSN not set"
# → Try redeploy again, might be cache issue
```

**4. Trigger test error (optional verification):**
```bash
curl -X POST "https://goreturn.pro/api/admin/test-sentry" \
  -H "x-auth-token: YOUR_OWNER_TOKEN" \
  -H "Content-Type: application/json"
```

Then check Sentry dashboard → Issues → should see new event.

**5. Configure email alerts:**
- Sentry → Settings → Alerts → Create Alert Rule
- Condition: `is error`
- Action: Send email to your@email.com
- Save

**✅ Sentry is now active.**

---

### Part 2: Uptime Monitoring (10 min)

**Option A: Better Stack (Recommended)**

```bash
1. Go to https://betterstack.com/uptime
2. Sign up (free tier)
3. Click "New Monitor"
4. URL: https://goreturn.pro/api/health
5. Check frequency: 30 seconds
6. Expected status: 200
7. Add notification → Email → your@email.com
8. Save

# Verify: Dashboard should show "UP" within 30 seconds
```

**Option B: UptimeRobot (Simpler, but slower)**

```bash
1. Go to https://uptimerobot.com
2. Sign up (free tier)
3. Add New Monitor
4. Type: HTTP(s)
5. URL: https://goreturn.pro/api/health
6. Interval: 5 minutes
7. Alert contacts: your@email.com
8. Save

# Verify: Dashboard should show "Up" within 5 minutes
```

**✅ Uptime monitoring is now active.**

---

## 📋 What You'll Now Get

### Sentry Alerts (Real-Time)
```
🔴 GoReturn Crashed
✉️ Error: Database connection timeout
   Route: /api/webhooks/refunds-create
   Time: 2026-07-05 14:32:45 UTC
   
→ Link to Sentry event details
```

**You'll get alerted within 30 seconds of a crash or 5xx error.**

### Uptime Alerts (30-60s detection)
```
🔴 GoReturn API is DOWN
   Status: HTTP 503 Service Unavailable
   Database: Not connected
   Last check: 2026-07-05 14:35:30 UTC
   Duration down: 2 minutes 15 seconds
   
→ Link to Better Stack incident
```

**You'll get alerted when the app or database goes down.**

### Backup Alerts (Daily)
```
📬 GoReturn Data Backup
   Stores: 5
   Returns: 342
   Backup: SUCCESS
   File: goreturn-backup-2026-07-05.json
   
✅ Last backup: 2026-07-05 08:05:35 UTC
```

**Automatic daily email with backup status.**

---

## ✅ Verification Checklist

After completing both parts above:

- [ ] Sentry dashboard shows "Initialized" in Railway logs
- [ ] Better Stack monitor shows "UP" (green indicator)
- [ ] Email alert configured in Sentry
- [ ] Email alert configured in Better Stack/UptimeRobot
- [ ] Test alert received (optional: pause Postgres briefly to trigger)
- [ ] /api/health returns 200 with all fields present
- [ ] No regressions in Shopify OAuth (302 redirect working)
- [ ] Billing API still responsive (/api/billing/plans returns 200)

---

## 🆘 Troubleshooting

### "SENTRY_DSN not set" in logs
- **Fix:** Redeploy in Railway (might be cache)
  ```bash
  # Railway → Deployments → Redeploy latest
  ```

### Sentry shows events but with `[redacted]` values
- **Expected!** Sensitive data is automatically scrubbed.
- Only safe fields shown: shop_domain, route, error_type, stack trace.

### Better Stack shows "DOWN" but app is UP
```bash
# Test manually:
curl https://goreturn.pro/api/health
# Should return 200 with JSON

# If manual works, monitor URL might be wrong
# Check: Settings → Monitor → URL field
```

### No alert emails arriving
- **Gmail/Outlook:** Check spam/promotions folder
- **Fix:** Add sentry@sentry.io and betterstack.com to safe senders
- **Verify:** Check alert settings are enabled (not muted)

---

## 📊 Dashboard Bookmarks

Save these for daily monitoring:

```
Sentry Issues:
https://sentry.io/organizations/your-org/issues/

Better Stack Monitor:
https://uptime.betterstack.com/status

Railway Logs:
https://railway.app/project/YOUR_PROJECT/logs

Production Health:
https://goreturn.pro/api/health
```

---

## 🎯 What's Now Monitored

| Issue | Detection Time | Alert Method |
|-------|----------------|--------------|
| App crash | <30 sec | Sentry email |
| Database down | 30-60 sec | Better Stack email |
| High error rate (10+ 5xx/5min) | <5 min | Built-in email |
| Backup failure | Daily | Built-in email |
| Authentication failure | Logged | Activity log (not alerted) |

---

## 💡 Pro Tips

1. **Test alerts occasionally** (but not in production!)
   - Keep alert contacts fresh
   - Ensure emails aren't going to spam

2. **Monitor the monitors**
   - Check Better Stack status page shows "UP"
   - Check Sentry project shows recent events (if any errors occurred)

3. **Review logs weekly**
   - Look for patterns in errors
   - Investigate spike in webhook failures
   - Check backup timestamps don't go stale

4. **Upgrade when needed**
   - Free tier handles 1-5 errors/day fine
   - Upgrade to paid if you need SMS alerts or longer data retention

---

## 📞 Support

**Sentry issues:** See `.github/SENTRY_SETUP.md` → Troubleshooting

**Uptime issues:** See `.github/UPTIME_MONITORING.md` → Troubleshooting

**General production issues:**
1. Check `/api/health` → tells you what's broken
2. Check Railway logs → shows error details
3. Check Sentry → aggregated error history

---

## ✅ You're Done!

Once this checklist is complete, **production monitoring is fully active**.

**Next:** Announce app availability to first merchants 🚀
