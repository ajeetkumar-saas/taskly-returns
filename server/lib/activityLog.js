// Audit/activity logging — writes to the activity_log table used for both business events
// (returns, refunds, plan changes) and security events (failed logins, unauthorized access
// attempts). Extracted from server/index.js (Batch 4 Step 1d) — behavior unchanged, verbatim move.

const pool = require('./db');

async function logActivity(req, action, details) {
  try {
    const userName = req.user?.name || 'System';
    const userEmail = req.user?.email || '';
    const userRole = req.user?.role || '';
    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
    // Best-effort shop resolution from wherever the calling route already has it — req.verifiedShop
    // (set by requireShopAccess) is the most trustworthy when present, then the team member's own
    // shop_domain, then whatever shop/shop_domain the request itself carried. Never blocks logging
    // if none of these are available — falls back to '' (shown as "Unknown store" to admins only).
    const shopDomain = req.verifiedShop || req.user?.shop_domain || req.query?.shop || req.body?.shop_domain || req.body?.shop || '';
    await pool.query('INSERT INTO activity_log (user_name, user_email, user_role, action, details, ip_address, shop_domain) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [userName, userEmail, userRole, action, details || '', ip, shopDomain]);
  } catch(e) {}
}

module.exports = { logActivity };
