// Billing routes: Shopify recurring-charge creation/confirmation, plan pricing, and offer-code
// redemption. Extracted from server/index.js (Batch 4 Step 2, Group 3) — behavior unchanged,
// verbatim move. CRITICAL: this touches real Shopify billing charges — every line below is a
// byte-for-byte copy of the original, no logic/pricing/condition changed.

const fetch = require('node-fetch');
const pool = require('../lib/db');
const { PLANS } = require('../lib/plans');
const { getStoreToken, shopifyFetch } = require('../lib/shopify');
const { requireShopAccess } = require('../lib/auth');

const APP_URL = process.env.APP_URL || 'http://localhost:3001';

function registerBillingRoutes(app) {
  app.get('/api/billing/create', async (req, res) => {
    const { shop, plan } = req.query;
    if (!shop) return res.status(400).json({ error: 'shop required' });
    const planData = PLANS[plan] || PLANS.starter;
    const sr = await getStoreToken(shop);
    if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
    try {
      const r = await fetch(`https://${shop}/admin/api/2025-04/recurring_application_charges.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': sr.rows[0].access_token },
        body: JSON.stringify({
          recurring_application_charge: {
            name: `GoReturn - ${planData.name}`,
            price: planData.price,
            return_url: `${APP_URL}/api/billing/confirm?shop=${shop}&plan=${plan}`,
            trial_days: planData.trial_days,
            // Test charges never move real money. Gated purely by NODE_ENV — never by shop
            // domain content, since a real merchant's store name could legitimately contain
            // "test" (e.g. a brand name) and would otherwise never be billed.
            test: process.env.NODE_ENV !== 'production'
          }
        })
      });
      const data = await r.json();
      const charge = data.recurring_application_charge;
      if (charge && charge.confirmation_url) {
        res.redirect(charge.confirmation_url);
      } else {
        // Shopify responded but didn't return a usable charge — log the raw response so this
        // is diagnosable instead of a silent, unexplained redirect back to the settings page.
        console.log('billing/create: no confirmation_url in Shopify response:', JSON.stringify(data));
        res.redirect(`/?shop=${shop}&connected=true&billing=skipped`);
      }
    } catch(e) {
      // Previously swallowed silently — merchants (and reviewers) landed back on this page with
      // no way to know why, and we had no way to diagnose it either. Logging only; no behavior
      // change to the response itself.
      console.log('billing/create error:', e.message);
      res.redirect(`/?shop=${shop}&connected=true&billing=error`);
    }
  });

  app.get('/api/billing/confirm', async (req, res) => {
    const { shop, plan, charge_id } = req.query;
    if (!shop || !charge_id) return res.redirect(`/?shop=${shop}&connected=true`);
    const sr = await getStoreToken(shop);
    if (!sr.rows.length) return res.redirect('/');
    try {
      const r = await shopifyFetch(`https://${shop}/admin/api/2025-04/recurring_application_charges/${charge_id}.json`, {
        headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
      });
      const data = await r.json();
      const charge = data.recurring_application_charge;
      // Modern Shopify API versions (2021-01+) transition an approved charge directly from
      // 'pending' to 'active' — the transient 'accepted' status this code previously checked for
      // is essentially never observed by the time Shopify redirects back here, which meant a
      // merchant could approve and pay, then land back on the dashboard with their plan never
      // actually updated. 'accepted' is kept as a fallback for older/edge-case API responses, but
      // an already-active charge must also be treated as approved — and must NOT be re-activated
      // (calling /activate.json on an already-active charge is unnecessary and can error).
      if (charge && (charge.status === 'active' || charge.status === 'accepted')) {
        if (charge.status === 'accepted') {
          await fetch(`https://${shop}/admin/api/2025-04/recurring_application_charges/${charge_id}/activate.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': sr.rows[0].access_token },
            body: JSON.stringify({ recurring_application_charge: { id: charge_id } })
          });
        }
        // Derive the plan from what the merchant ACTUALLY approved on Shopify (the charge's real
        // price), not the client-supplied ?plan= query param. Trusting the query param would let
        // a merchant approve a cheap plan, then replay this confirm URL with a different ?plan=
        // to grant themselves a higher tier's features for free — the charge_id and its accepted
        // status are real, but the plan name was never cryptographically tied to them.
        const chargePrice = parseFloat(charge.price);
        const verifiedPlanKey = Object.keys(PLANS).find(k => PLANS[k].price === chargePrice) || 'starter';
        const planData = PLANS[verifiedPlanKey];
        const trialEndsAt = planData.trial_days > 0 ? new Date(Date.now() + planData.trial_days * 86400000) : null;
        // Store the charge id so syncBillingStatus() can later re-check whether the merchant has
        // cancelled/been declined on Shopify's side and downgrade accordingly.
        await pool.query('UPDATE shopify_stores SET plan=$1, trial_ends_at=$2, billing_charge_id=$3 WHERE shop_domain=$4', [verifiedPlanKey, trialEndsAt, String(charge_id), shop]);
        return res.redirect(`/?shop=${shop}&connected=true&plan=${verifiedPlanKey}`);
      }
      res.redirect(`/?shop=${shop}&connected=true&plan=${plan}`);
    } catch(e) {
      res.redirect(`/?shop=${shop}&connected=true`);
    }
  });

  app.get('/api/billing/plans', (req, res) => {
    res.json(PLANS);
  });

  app.post('/api/offers/redeem', requireShopAccess, async (req, res) => {
    const { code, shop } = req.body;
    if (!code || !shop) return res.status(400).json({ error: 'code and shop required' });
    try {
      const r = await pool.query('SELECT * FROM offers WHERE code=$1 AND active=true', [code.toUpperCase()]);
      if (!r.rows.length) return res.status(404).json({ error: 'Invalid or expired offer code' });
      const offer = r.rows[0];
      if (offer.used >= offer.max_uses) return res.status(400).json({ error: 'Offer code limit reached' });
      let newPlan = 'starter';
      if (offer.type === 'free_forever') newPlan = 'free';
      else if (offer.type === 'free_months') newPlan = 'growth';
      else newPlan = 'starter';
      await pool.query('UPDATE shopify_stores SET plan=$1 WHERE shop_domain=$2', [newPlan, shop]);
      await pool.query('UPDATE offers SET used=used+1 WHERE id=$1', [offer.id]);
      res.json({ ok: true, message: `Offer "${code}" applied! Plan: ${newPlan}`, plan: newPlan });
    } catch(e) { console.log('offers redeem error:', e.message); res.status(500).json({ error: 'Failed to apply offer' }); }
  });
}

module.exports = { registerBillingRoutes };
