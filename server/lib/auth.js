// Password hashing/verification and the auth/authorization middleware used across nearly every
// route in the app. Extracted from server/index.js (Batch 4 Step 1f, a prerequisite for route
// extraction) — behavior unchanged, verbatim move.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { logActivity } = require('./activityLog');
const { verifyShopifySessionToken } = require('./shopify');

// Bcrypt with a per-password random salt for all NEW passwords (replaces the old fast
// SHA-256 + static-salt scheme, which is weak against brute-force/rainbow-table attacks).
function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}
function legacyHashPassword(password) {
  return crypto.createHash('sha256').update(password + 'goreturn_salt_2026').digest('hex');
}
// Verifies against either a bcrypt hash or an old-format legacy hash. On a successful legacy
// match, transparently re-hashes with bcrypt and returns the new hash so the caller can persist
// it — existing users get silently upgraded to the stronger scheme the next time they log in.
function verifyPassword(password, storedHash) {
  if (!storedHash) return { ok: false };
  if (storedHash.startsWith('$2')) return { ok: bcrypt.compareSync(password, storedHash) };
  const ok = legacyHashPassword(password) === storedHash;
  return { ok, upgradedHash: ok ? hashPassword(password) : null };
}

async function authenticateRequest(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Login required' }); // no token at all is routine (not-yet-logged-in UI checks) — not worth logging
  const admin = await pool.query('SELECT * FROM admin_users WHERE session_token=$1', [token]);
  // isPlatformOwner is set ONLY here, from which table actually matched — never derived from
  // req.user.role. team_members rows can also legitimately have role='owner' (a merchant's own
  // top-tier team role, unrelated to platform-wide access), and comparing role strings alone
  // previously let a shop's own 'owner'-role team member satisfy the same check as the real
  // platform admin, bypassing shop_domain scoping entirely across every other merchant's data.
  if (admin.rows.length > 0) { req.user = admin.rows[0]; req.user.isPlatformOwner = true; return next(); }
  const member = await pool.query('SELECT * FROM team_members WHERE session_token=$1', [token]);
  if (member.rows.length > 0) { req.user = member.rows[0]; req.user.isPlatformOwner = false; return next(); }
  // A token WAS supplied but matched no active session — more suspicious than simply being
  // logged out (expired/tampered/guessed token), worth a trace.
  await logActivity(req, 'Invalid Session Token', `${req.method} ${req.path}`);
  return res.status(401).json({ error: 'Invalid session' });
}

// Platform-owner-only routes (cross-merchant actions: plan changes, free access, app-wide backups).
// Uses the real logged-in session (x-auth-token), never a shared static secret.
async function requireOwner(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Login required' });
  const admin = await pool.query('SELECT * FROM admin_users WHERE session_token=$1', [token]);
  if (!admin.rows.length || admin.rows[0].role !== 'owner') return res.status(403).json({ error: 'Owner access required' });
  req.user = admin.rows[0];
  next();
}

// Session timeout middleware (30 min inactivity)
const sessionActivity = {};
async function checkSessionTimeout(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return next();
  const now = Date.now();
  const lastActivity = sessionActivity[token] || now;
  const inactivityMs = 30 * 60 * 1000; // 30 minutes
  if (now - lastActivity > inactivityMs) {
    delete sessionActivity[token];
    return res.status(401).json({ error: 'Session expired due to inactivity. Please login again.' });
  }
  sessionActivity[token] = now;
  next();
}

// Guards merchant-facing data endpoints (returns list/update/refund) so a caller can only act on
// the store they're actually authenticated for — never a different merchant's data, and never
// just by passing a `shop` query param. Resolves the target shop from the route/body itself
// (or, for :id-based routes, from the record being acted on) rather than trusting client input.
async function requireShopAccess(req, res, next) {
  try {
    let targetShop = req.query.shop || req.body?.shop_domain || req.body?.shop || '';
    if (!targetShop && req.params.id) {
      const r = await pool.query('SELECT shop_domain FROM returns WHERE id=$1', [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Return not found' });
      targetShop = r.rows[0].shop_domain;
    }
    if (!targetShop) return res.status(400).json({ error: 'shop required' });
    if (!/^[a-z0-9-]+\.myshopify\.com$/.test(targetShop)) return res.status(400).json({ error: 'Invalid shop domain' });

    const authHeader = req.headers['authorization'] || '';

    // Check for Bearer token (Shopify App Bridge session token). Must actually verify the
    // JWT signature and confirm it was issued for THIS shop — a bare length check let anyone
    // pass an arbitrary 20+ char string plus ?shop=<any store> and access that store's data.
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const session = verifyShopifySessionToken(token);
      if (session && session.shop === targetShop) {
        req.verifiedShop = targetShop;
        return next();
      }
    }

    // Check for x-auth-token (web dashboard login)
    const token = req.headers['x-auth-token'];
    if (token) {
      const admin = await pool.query('SELECT * FROM admin_users WHERE session_token=$1', [token]);
      if (admin.rows.length > 0) { req.user = admin.rows[0]; req.verifiedShop = targetShop; return next(); } // platform owner — any shop
      const member = await pool.query('SELECT * FROM team_members WHERE session_token=$1', [token]);
      if (member.rows.length > 0 && member.rows[0].shop_domain === targetShop) { req.user = member.rows[0]; req.verifiedShop = targetShop; return next(); }
    }

    // Only log when a credential was actually presented but failed verification (a real
    // mismatched/forged Bearer token, or a session token for the wrong shop) — not the routine
    // "no auth header yet" case that happens on normal early page loads, which would otherwise
    // flood this log with noise on every request.
    if (authHeader.startsWith('Bearer ') || req.headers['x-auth-token']) {
      await logActivity(req, 'Unauthorized Shop Access Attempt', `${req.method} ${req.path} → shop=${targetShop}`);
    }
    return res.status(401).json({ error: 'Not authorized for this store' });
  } catch(e) { return res.status(500).json({ error: 'Auth check failed' }); }
}

// Shop access + plan requirement (for premium features)
// planName: 'starter', 'growth', or 'pro' — the minimum standard-plan tier required.
// featureKey: the specific custom_features flag this endpoint maps to (e.g. 'automation',
// 'promotions', 'fraud', 'pincode', 'webhooks'). Required so custom-plan sellers are gated
// per-feature instead of all growth/pro-tier endpoints collapsing onto one shared flag.
function requirePlan(planName, featureKey) {
  return async (req, res, next) => {
    await requireShopAccess(req, res, async () => {
      // After requireShopAccess validates shop, check plan
      const targetShop = req.query.shop || req.body?.shop_domain || req.body?.shop;
      if (!targetShop) return res.status(400).json({ error: 'shop required' });

      // Platform owner (admin dashboard) always has full visibility - plan
      // gating applies to sellers, not to the owner monitoring their platform
      const xToken = req.headers['x-auth-token'];
      if (xToken) {
        try {
          const owner = await pool.query('SELECT role FROM admin_users WHERE session_token=$1', [xToken]);
          if (owner.rows.length && owner.rows[0].role === 'owner') return next();
        } catch(e) { /* fall through to plan check */ }
      }

      pool.query('SELECT plan, custom_features FROM shopify_stores WHERE shop_domain=$1', [targetShop])
        .then(r => {
          if (!r.rows.length) return res.status(404).json({ error: 'Store not found' });
          const storePlan = r.rows[0].plan || 'free';

          // Custom plan: check the specific feature flag for this endpoint
          if (storePlan === 'custom') {
            try {
              const features = JSON.parse(r.rows[0].custom_features || '{}');
              // Fallback covers any requirePlan() call site that hasn't been given an
              // explicit featureKey yet — defaults to one representative flag per tier.
              const defaultFeatureKey = { starter: 'analytics', growth: 'fraud', pro: 'webhooks' }[planName];
              const key = featureKey || defaultFeatureKey;
              if (key && features[key] !== true) {
                return res.status(402).json({ error: `This feature requires a custom plan upgrade` });
              }
              return next();
            } catch(e) { return res.status(500).json({ error: 'Custom feature check failed' }); }
          }

          // Standard plans: tier-based check
          const plans = { free: 0, starter: 1, growth: 2, pro: 3 };
          const required = plans[planName] || 1;
          const current = plans[storePlan] || 0;
          if (current < required) {
            const upgradeText = { starter: 'Starter ($11.99/mo)', growth: 'Growth ($23.99/mo)', pro: 'Pro ($47.99/mo)' }[planName];
            return res.status(402).json({ error: `This feature requires ${upgradeText} plan` });
          }
          next();
        })
        .catch(e => res.status(500).json({ error: 'Plan check failed' }));
    });
  };
}

module.exports = {
  hashPassword,
  legacyHashPassword,
  verifyPassword,
  authenticateRequest,
  requireOwner,
  checkSessionTimeout,
  requireShopAccess,
  requirePlan
};
