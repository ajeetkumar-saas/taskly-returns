// Admin plan-management routes (owner-only: change plan, free access, custom plans, offers) plus
// the activity-log read endpoint. Extracted from server/index.js (Batch 4 Step 2, Group 2b) —
// behavior unchanged, verbatim move.
//
// Note: /api/offers/redeem (seller-facing, requireShopAccess-gated) stays in index.js for now —
// it's grouped with billing in a later step since it mutates shop_domain.plan the same way
// billing routes do.

const pool = require('../lib/db');
const { logActivity } = require('../lib/activityLog');
const { requireOwner, authenticateRequest } = require('../lib/auth');
const { PLANS } = require('../lib/plans');

function registerAdminPlanRoutes(app) {
  app.post('/api/admin/change-plan', requireOwner, async (req, res) => {
    const { shop, plan } = req.body;
    const planData = PLANS[plan] || PLANS.starter;
    const trialEndsAt = planData.trial_days > 0 ? new Date(Date.now() + planData.trial_days * 86400000) : null;
    await pool.query('UPDATE shopify_stores SET plan=$1, trial_ends_at=$2 WHERE shop_domain=$3', [plan, trialEndsAt, shop]);
    await logActivity(req, 'Plan Changed', `${shop} → ${plan}${trialEndsAt ? ' (trial until ' + trialEndsAt.toLocaleDateString() + ')' : ''}`);
    res.json({ ok: true });
  });

  app.post('/api/admin/free-access', requireOwner, async (req, res) => {
    const { shop, plan, duration_days } = req.body;
    await pool.query('UPDATE shopify_stores SET plan=$1 WHERE shop_domain=$2', [plan || 'free', shop]);
    res.json({ ok: true, shop, plan, duration_days });
  });

  // Custom Plans API (for seller-specific custom pricing/limits)
  app.post('/api/admin/custom-plans', requireOwner, async (req, res) => {
    const { shop, price, returns_limit, features } = req.body;
    if (!shop || price === undefined || !returns_limit) return res.status(400).json({ error: 'shop, price, returns_limit required' });
    try {
      await pool.query(
        'UPDATE shopify_stores SET plan=$1, custom_price=$2, custom_returns_limit=$3, custom_features=$4 WHERE shop_domain=$5',
        ['custom', price, returns_limit, JSON.stringify(features || {}), shop]
      );
      await logActivity(req, 'Custom Plan Created', `${shop}: $${price}/mo, ${returns_limit} returns`);
      res.json({ ok: true, shop, price, returns_limit, features });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/custom-plans', requireOwner, async (req, res) => {
    try {
      const r = await pool.query('SELECT shop_domain, store_name, plan, custom_price, custom_returns_limit, custom_features FROM shopify_stores WHERE plan=$1 ORDER BY created_at DESC', ['custom']);
      res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/admin/custom-plans/:shop', requireOwner, async (req, res) => {
    const { shop } = req.params;
    const { price, returns_limit, features } = req.body;
    try {
      await pool.query(
        'UPDATE shopify_stores SET custom_price=$1, custom_returns_limit=$2, custom_features=$3 WHERE shop_domain=$4',
        [price, returns_limit, JSON.stringify(features || {}), shop]
      );
      await logActivity(req, 'Custom Plan Updated', `${shop}: $${price}/mo, ${returns_limit} returns`);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/custom-plans/:shop', requireOwner, async (req, res) => {
    const { shop } = req.params;
    try {
      await pool.query(
        'UPDATE shopify_stores SET plan=$1, custom_price=NULL, custom_returns_limit=NULL, custom_features=NULL WHERE shop_domain=$2',
        ['starter', shop]
      );
      await logActivity(req, 'Custom Plan Deleted', `${shop}: reverted to starter`);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/offers', requireOwner, async (req, res) => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS offers (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        type VARCHAR(50) DEFAULT 'percent',
        value INTEGER DEFAULT 0,
        max_uses INTEGER DEFAULT 100,
        used INTEGER DEFAULT 0,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
      const r = await pool.query('SELECT * FROM offers ORDER BY created_at DESC');
      res.json(r.rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/offers', requireOwner, async (req, res) => {
    const { code, type, value, max_uses } = req.body;
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS offers (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        type VARCHAR(50) DEFAULT 'percent',
        value INTEGER DEFAULT 0,
        max_uses INTEGER DEFAULT 100,
        used INTEGER DEFAULT 0,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )`);
      const r = await pool.query('INSERT INTO offers (code,type,value,max_uses) VALUES ($1,$2,$3,$4) RETURNING *', [code, type, value||0, max_uses||100]);
      res.json(r.rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/admin/offers/:id', requireOwner, async (req, res) => {
    const { active } = req.body;
    const r = await pool.query('UPDATE offers SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
    res.json(r.rows[0]);
  });

  app.get('/api/activity-log', authenticateRequest, async (req, res) => {
    try {
      // Platform owner: sees everything, optionally narrowed to one store via ?shop=.
      // Shop-scoped team member: ALWAYS restricted to their own store — this previously had no
      // shop filter at all, so any team member (any role, any shop) could see every other
      // merchant's activity log. isPlatformOwner is set only from which table matched in
      // authenticateRequest, never from a role string (same fix pattern as P0-1 in /api/team).
      if (!req.user.isPlatformOwner) {
        const r = await pool.query('SELECT * FROM activity_log WHERE shop_domain=$1 ORDER BY created_at DESC LIMIT 200', [req.user.shop_domain]);
        return res.json(r.rows);
      }
      const { shop } = req.query;
      const r = shop
        ? await pool.query('SELECT * FROM activity_log WHERE shop_domain=$1 ORDER BY created_at DESC LIMIT 200', [shop])
        : await pool.query('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 200');
      res.json(r.rows);
    } catch(e) { res.json([]); }
  });
}

module.exports = { registerAdminPlanRoutes };
