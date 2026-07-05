// Mandatory Shopify compliance webhooks: refund sync, GDPR (customer data_request/redact,
// shop/redact), and app-uninstalled. Extracted from server/index.js (Batch 4 Step 2, Group 5) —
// behavior unchanged, verbatim move. CRITICAL Shopify infrastructure: webhook URLs, HMAC
// verification, GDPR delete logic, and retry/error response behavior are all byte-for-byte
// copies of the original.

const pool = require('../lib/db');
const { sendEmail, notifyAdmin, ALLOWED_ADMIN_EMAIL } = require('../lib/email');
const { verifyShopifyHmac } = require('../lib/shopify');

// Counts genuine webhook processing failures (500s) since boot — was a bare module-level `let`
// in index.js, read directly by /api/health. Exported as a getter here (same pattern as
// getLastEmailError in lib/email.js) since a plain variable can't be shared live across modules.
let webhookFailureCount = 0;
function getWebhookFailureCount() { return webhookFailureCount; }

function registerWebhookRoutes(app) {
  // Mandatory Shopify Compliance Webhooks
  // GoReturn is a data processor here — the merchant (shop) is the data controller. So
  // Sync refunds processed directly in Shopify admin back to GoReturn dashboard
  app.post('/api/webhooks/shopify/refunds-create', async (req, res) => {
    const hmacValid = verifyShopifyHmac(req);
    console.log(`refunds/create webhook received — shop: ${req.headers['x-shopify-shop-domain']}, hmac_valid: ${hmacValid}, secret_set: ${!!process.env.SHOPIFY_APP_SHARED_SECRET}`);
    if (!hmacValid) { console.log('refunds/create HMAC failed — rejecting'); return res.status(401).send('Unauthorized'); }
    try {
      const shop = req.headers['x-shopify-shop-domain'];
      const refund = req.body;
      if (!shop || !refund?.order_id) return res.status(200).json({ ok: true });

      // Find a return for this order that isn't already marked refunded
      const existing = await pool.query(
        `SELECT id FROM returns WHERE shop_domain=$1 AND order_id=$2 AND status != 'refunded' ORDER BY created_at DESC LIMIT 1`,
        [shop, String(refund.order_id)]
      );
      if (existing.rows.length) {
        const retId = existing.rows[0].id;
        const refundId = String(refund.id || '');
        await pool.query(
          `UPDATE returns SET status='refunded', refunded_at=NOW(), updated_at=NOW(), refund_status='completed', shopify_refund_id=$1 WHERE id=$2`,
          [refundId, retId]
        );
        console.log(`Shopify refund webhook: synced return #${retId} → refunded (Shopify refund ${refundId})`);
      }
    } catch(e) {
      // A genuine processing failure here previously still returned 200, telling Shopify
      // "delivered successfully" and permanently losing the chance for Shopify's own webhook
      // retry to recover it. Return 500 so Shopify retries, and alert immediately instead of
      // only a console.log nobody sees.
      console.log('orders/refunds/create webhook error:', e.message);
      notifyAdmin('🚨 GoReturn Webhook Failure (refunds/create)', `<p>Error: ${e.message}</p><p>Shop: ${req.headers['x-shopify-shop-domain']||'unknown'}</p><p>Time: ${new Date().toUTCString()}</p>`).catch(()=>{});
      webhookFailureCount++; return res.status(500).send('Internal error — please retry');
    }
    res.status(200).json({ ok: true });
  });

  // data_request compiles the customer's records and emails them to the merchant to forward,
  // and redact requests actually scrub the data rather than just acknowledging the webhook.
  app.post('/api/webhooks/customers/data_request', async (req, res) => {
    if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');
    try {
      const { shop_domain, customer } = req.body || {};
      console.log('Customer data request webhook:', shop_domain, customer?.email);
      if (shop_domain && customer?.email) {
        const r = await pool.query('SELECT * FROM returns WHERE shop_domain=$1 AND customer_email=$2', [shop_domain, customer.email]);
        if (r.rows.length) {
          const store = await pool.query('SELECT store_email FROM shopify_stores WHERE shop_domain=$1', [shop_domain]);
          const notifyTo = store.rows[0]?.store_email || ALLOWED_ADMIN_EMAIL;
          const rows = r.rows.map(x => `Return #${x.id} — Order ${x.order_number||x.order_id} — ${x.product_name} — ${x.status} — ${x.created_at}`).join('<br>');
          sendEmail(notifyTo, `Customer Data Request - ${customer.email}`, `<div style="font-family:sans-serif;padding:20px"><h3>Shopify Customer Data Request</h3><p>Customer: ${customer.email}</p><p>Records found in GoReturn for ${shop_domain}:</p><p>${rows}</p><p style="color:#888;font-size:12px">Please forward this to the customer per Shopify's GDPR requirements.</p></div>`);
        }
      }
    } catch(e) {
      // GDPR compliance webhook — a swallowed failure here previously still reported success,
      // preventing Shopify's retry from giving us a second chance to actually process the request.
      console.log('data_request error:', e.message);
      notifyAdmin('🚨 GoReturn GDPR Webhook Failure (data_request)', `<p>Error: ${e.message}</p><p>Shop: ${req.body?.shop_domain||'unknown'}</p><p>Time: ${new Date().toUTCString()}</p>`).catch(()=>{});
      webhookFailureCount++; return res.status(500).send('Internal error — please retry');
    }
    res.status(200).json({ ok: true });
  });

  app.post('/api/webhooks/customers/redact', async (req, res) => {
    if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');
    try {
      const { shop_domain, customer } = req.body || {};
      console.log('Customer redact webhook:', shop_domain, customer?.email);
      if (shop_domain && customer?.email) {
        // Scrub PII but keep the row for the merchant's own accounting/order history
        await pool.query(
          `UPDATE returns SET customer_name='[redacted]', customer_email='[redacted]', customer_phone='[redacted]', reason_detail='', images=''
           WHERE shop_domain=$1 AND customer_email=$2`,
          [shop_domain, customer.email]
        );
      }
    } catch(e) {
      // GDPR compliance webhook — a failed redact previously still reported success, which is
      // both a data-loss risk (retry never happens) and a compliance risk (PII not actually
      // scrubbed despite Shopify believing it was).
      console.log('customers/redact error:', e.message);
      notifyAdmin('🚨 GoReturn GDPR Webhook Failure (customers/redact)', `<p>Error: ${e.message}</p><p>Shop: ${req.body?.shop_domain||'unknown'}</p><p>Time: ${new Date().toUTCString()}</p>`).catch(()=>{});
      webhookFailureCount++; return res.status(500).send('Internal error — please retry');
    }
    res.status(200).json({ ok: true });
  });

  app.post('/api/webhooks/shop/redact', async (req, res) => {
    if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');
    console.log('Shop redact webhook received');
    const shopDomain = req.body?.shop_domain;
    if (shopDomain) {
      // Attempt all 4 deletes regardless of earlier failures (each DELETE is idempotent, so a
      // Shopify retry re-running an already-succeeded one is harmless) — but track failures so we
      // can report genuine failure instead of always claiming success on this GDPR-mandated
      // deletion, which previously silently swallowed every error.
      const failures = [];
      const attempt = async (label, query) => { try { await pool.query(query, [shopDomain]); } catch(e) { failures.push(`${label}: ${e.message}`); } };
      await attempt('returns', 'DELETE FROM returns WHERE shop_domain = $1');
      await attempt('store_settings', 'DELETE FROM store_settings WHERE shop_domain = $1');
      await attempt('team_members', 'DELETE FROM team_members WHERE shop_domain = $1');
      await attempt('shopify_stores', 'DELETE FROM shopify_stores WHERE shop_domain = $1');
      if (failures.length) {
        console.log('shop/redact partial failure:', failures);
        notifyAdmin('🚨 GoReturn GDPR Webhook Failure (shop/redact)', `<p>Shop: ${shopDomain}</p><ul>${failures.map(f => `<li>${f}</li>`).join('')}</ul><p>Time: ${new Date().toUTCString()}</p>`).catch(()=>{});
        webhookFailureCount++; return res.status(500).send('Internal error — please retry');
      }
    }
    res.status(200).json({ ok: true });
  });

  // App uninstalled webhook — alert admin + clean up store so reinstall is detected as new
  app.post('/api/webhooks/app-uninstalled', async (req, res) => {
    if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');
    const shopDomain = req.get('X-Shopify-Shop-Domain') || req.body?.myshopify_domain || req.body?.domain;
    console.log('App uninstalled webhook:', shopDomain);
    if (shopDomain) {
      let storeName = shopDomain;
      try { const s = await pool.query('SELECT store_name FROM shopify_stores WHERE shop_domain=$1', [shopDomain]); if (s.rows[0]?.store_name) storeName = s.rows[0].store_name; } catch(e) {}
      try {
        await pool.query('DELETE FROM shopify_stores WHERE shop_domain = $1', [shopDomain]);
      } catch(e) {
        // Not GDPR-critical like shop/redact, but still worth Shopify retrying and us knowing —
        // previously this failure was silently swallowed and still reported as success.
        console.log('app-uninstalled delete error:', e.message);
        notifyAdmin('🚨 GoReturn Webhook Failure (app-uninstalled)', `<p>Failed to clean up ${shopDomain}: ${e.message}</p><p>Time: ${new Date().toUTCString()}</p>`).catch(()=>{});
        webhookFailureCount++; return res.status(500).send('Internal error — please retry');
      }
      notifyAdmin('⚠️ GoReturn Uninstalled', `<p><strong>${storeName}</strong> (${shopDomain}) just <strong>uninstalled</strong> GoReturn.</p><p>Time: ${new Date().toUTCString()}</p><p>Their stored data has been removed. A reinstall will be detected as a new install.</p>`);
    }
    res.status(200).json({ ok: true });
  });
}

module.exports = { registerWebhookRoutes, getWebhookFailureCount };
