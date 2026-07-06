// Core return/customer workflow routes: order lookup, return creation, listing, stats, export,
// tracking, refund processing, and image upload/attach. Extracted from server/index.js
// (Batch 4 Step 2, Group 4) — behavior unchanged, verbatim move.
//
// NOTE: PATCH /api/returns/:id (approve/reject/status-update) deliberately stays in
// server/index.js for now — it calls createShiprocketPickup()/sellerShiprocketAPI(), which are
// part of the Shiprocket/logistics domain and haven't been extracted yet. Moving this route
// without also extracting those would require a messy circular require back into index.js, so
// it's deferred to the logistics extraction group instead of expanding this commit's scope.

const fetch = require('node-fetch');
const pool = require('../lib/db');
const { sendEmail } = require('../lib/email');
const { logActivity } = require('../lib/activityLog');
const { getStoreToken, shopifyFetch, attemptReauth, verifyShopifySessionToken } = require('../lib/shopify');
const { requireShopAccess, requireOwner } = require('../lib/auth');
const { getEmailTemplates, fillPlaceholders, returnStatusEmail } = require('../lib/emailTemplates');

// Process a real Shopify refund for a return (Shopify App Store rule 1.1.15: refunds must go through
// the original payment processor via Shopify's refund APIs — never a manual/bank/UPI/store-credit ledger).
async function processShopifyRefund(shop, ret) {
  const amount = Number(ret.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Refund amount must be a positive number');

  const sr = await getStoreToken(shop);
  if (!sr.rows.length) throw new Error('Store not connected');
  const access_token = sr.rows[0].access_token;

  let lineItems = [];
  try { lineItems = JSON.parse(ret.line_items || '[]'); } catch(e) {}
  if (!lineItems.length) throw new Error('No order line items linked to this return — cannot process a Shopify refund automatically.');

  const refund_line_items = lineItems.map(li => ({ line_item_id: li.id, quantity: li.quantity || 1, restock_type: 'no_restock' }));

  // Fetch order currency — do not hardcode INR, stores may use USD or other currencies
  let orderCurrency = 'INR';
  try {
    const orderResp = await shopifyFetch(`https://${shop}/admin/api/2025-04/orders/${ret.order_id}.json?fields=currency`, {
      headers: { 'X-Shopify-Access-Token': access_token }
    });
    const orderData = await orderResp.json();
    if (orderData.order?.currency) orderCurrency = orderData.order.currency;
  } catch(e) {}

  // Safe to retry — calculate is read-only and doesn't move money
  const calcResp = await shopifyFetch(`https://${shop}/admin/api/2025-04/orders/${ret.order_id}/refunds/calculate.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': access_token },
    body: JSON.stringify({ refund: { currency: orderCurrency, refund_line_items, shipping: { full_refund: false } } })
  });
  const calcData = await calcResp.json();
  if (!calcData.refund) throw new Error(calcData.errors ? JSON.stringify(calcData.errors) : 'Shopify could not calculate this refund');

  // Deliberately NOT auto-retried: this call actually moves money. If a response is lost after
  // Shopify processed it, blindly retrying could create a second, duplicate refund. A genuine
  // failure here surfaces to the merchant, who can safely retry via the refund_status-guarded
  // /api/returns/:id/refund endpoint (which won't double-process an already-completed refund).
  const refundResp = await fetch(`https://${shop}/admin/api/2025-04/orders/${ret.order_id}/refunds.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': access_token },
    body: JSON.stringify({
      refund: {
        note: `Refund via GoReturn — Return #${ret.id}`,
        notify: true,
        refund_line_items,
        transactions: (calcData.refund.transactions || []).map(t => ({ ...t, kind: 'refund' })),
        shipping: calcData.refund.shipping || { full_refund: false }
      }
    })
  });
  const refundData = await refundResp.json();
  if (!refundData.refund) throw new Error(refundData.errors ? JSON.stringify(refundData.errors) : 'Shopify refund creation failed');
  return refundData.refund;
}

function registerReturnRoutes(app) {
  // Single order lookup (for customer return portal)
  app.get('/api/shopify/order-lookup', async (req, res) => {
    const { shop, order_number, email } = req.query;
    if (!shop || !order_number || !email) return res.status(400).json({ error: 'shop, order_number and email required' });
    const sr = await getStoreToken(shop);
    if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected. The store owner needs to open GoReturn app in Shopify Admin first.' });
    try {
      // shopifyFetch adds transient-failure retry (429/5xx with backoff) on top of the existing
      // 401/403 re-auth handling below — this is a read-only GET on the customer-facing return
      // portal, so a brief Shopify API blip previously meant a hard failure with no second try.
      const r = await shopifyFetch(`https://${shop}/admin/api/2025-04/orders.json?name=${encodeURIComponent(order_number)}&status=any`, {
        headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
      });
      if (r.status === 401 || r.status === 403) {
        // Token invalid — try to fix it automatically via token re-fetch from OAuth
        const reauth = await attemptReauth(shop);
        if (reauth) {
          // Retry the request with new token
          const retry = await shopifyFetch(`https://${shop}/admin/api/2025-04/orders.json?name=${encodeURIComponent(order_number)}&status=any`, {
            headers: { 'X-Shopify-Access-Token': reauth }
          });
          if (retry.ok) {
            const retryData = await retry.json();
            const retryOrders = retryData.orders || [];
            if (!retryOrders.length) return res.status(404).json({ error: 'Order not found' });
            const order = retryOrders[0];
            // Reject if the order has no email on file — we can't verify identity, so we must
            // NOT let any email value pass through unchecked (that was the bug: it silently
            // skipped verification instead of failing closed).
            if (!order.email) return res.status(403).json({ error: 'Cannot verify this order — no email on file. Contact the store owner.' });
            if (order.email.toLowerCase() !== email.toLowerCase()) {
              return res.status(403).json({ error: 'Email does not match order' });
            }
            return res.json({
              id: order.id, order_number: order.name, email: order.email,
              customer_name: order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : '',
              phone: order.phone || order.customer?.phone || '', total_price: order.total_price,
              currency: order.currency, financial_status: order.financial_status,
              fulfillment_status: order.fulfillment_status, created_at: order.created_at,
              line_items: (order.line_items || []).map(li => ({ id: li.id, title: li.title, sku: li.sku, quantity: li.quantity, price: li.price, variant_title: li.variant_title }))
            });
          }
        }
        return res.status(503).json({ error: 'Store connection expired. Please contact the store owner.' });
      }
      const d = await r.json();
      const orders = d.orders || [];
      if (!orders.length) return res.status(404).json({ error: 'Order not found' });
      const order = orders[0];
      if (!order.email) return res.status(403).json({ error: 'Cannot verify this order — no email on file. Contact the store owner.' });
      if (order.email.toLowerCase() !== email.toLowerCase()) {
        return res.status(403).json({ error: 'Email does not match order' });
      }
      res.json({
        id: order.id,
        order_number: order.name,
        email: order.email,
        customer_name: order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : '',
        phone: order.phone || order.customer?.phone || '',
        total_price: order.total_price,
        currency: order.currency,
        financial_status: order.financial_status,
        fulfillment_status: order.fulfillment_status,
        created_at: order.created_at,
        line_items: (order.line_items || []).map(li => ({
          id: li.id,
          title: li.title,
          sku: li.sku,
          quantity: li.quantity,
          price: li.price,
          variant_title: li.variant_title
        }))
      });
    } catch(e) { console.log('order-lookup error:', e.message); res.status(500).json({ error: 'Failed to look up order' }); }
  });

  // Trigger the actual Shopify refund for a return — only marks it 'refunded' once Shopify confirms it
  app.post('/api/returns/:id/refund', requireShopAccess, async (req, res) => {
    try {
      // Atomically "claim" this return for refunding — if it's already refunded or another
      // request is mid-refund right now, this UPDATE matches zero rows and we bail out
      // immediately, before ever calling Shopify. Closes the double-click/retry race condition.
      // shop_domain=$2 also prevents a caller authenticated for their OWN shop from triggering a
      // real Shopify refund on a DIFFERENT shop's order just by guessing/enumerating return ids.
      const claim = await pool.query(
        `UPDATE returns SET refund_status='processing' WHERE id=$1 AND shop_domain=$2 AND status != 'refunded' AND (refund_status IS NULL OR refund_status NOT IN ('processing','completed')) RETURNING *`,
        [req.params.id, req.verifiedShop]
      );
      if (!claim.rows.length) {
        // Scope this lookup by shop too — don't let a caller distinguish "belongs to another
        // shop" from "doesn't exist" (would leak that a given return id exists elsewhere).
        const existing = await pool.query('SELECT status, refund_status FROM returns WHERE id=$1 AND shop_domain=$2', [req.params.id, req.verifiedShop]);
        if (!existing.rows.length) return res.status(404).json({ error: 'Return not found' });
        return res.status(409).json({ error: 'This return is already refunded or a refund is already in progress' });
      }
      const ret = claim.rows[0];
      if (!ret.shop_domain) { await pool.query(`UPDATE returns SET refund_status='' WHERE id=$1`, [ret.id]); return res.status(400).json({ error: 'No store linked to this return' }); }

      let refund;
      try {
        refund = await processShopifyRefund(ret.shop_domain, ret);
      } catch(refundErr) {
        await pool.query(`UPDATE returns SET refund_status='failed' WHERE id=$1`, [ret.id]).catch(()=>{});
        throw refundErr;
      }

      const upd = await pool.query(
        `UPDATE returns SET status='refunded', refunded_at=NOW(), updated_at=NOW(), refund_status='completed', shopify_refund_id=$1 WHERE id=$2 RETURNING *`,
        [String(refund.id), ret.id]
      );
      const updated = upd.rows[0];
      if (updated.customer_email) {
        const tpl = await getEmailTemplates(updated.shop_domain);
        const t = tpl.refunded;
        const ph = { order: updated.order_number||updated.order_id, name: updated.customer_name, amount: updated.amount, product: updated.product_name };
        const subj = t ? fillPlaceholders(t.subject, ph) : `Refund Processed - #${updated.order_number||updated.order_id}`;
        const msg = t ? fillPlaceholders(t.message, ph) : null;
        sendEmail(updated.customer_email, subj, returnStatusEmail(updated.customer_name||'Customer', updated.order_number||updated.order_id, 'refunded', updated.amount, { product: updated.product_name, reason: updated.reason, returnId: updated.id, customMsg: msg }));
      }
      logActivity(req, 'Return Refunded', `#${ret.id} via Shopify (refund id ${refund.id})`);
      res.json({ ok: true, return: updated, shopify_refund: refund });
    } catch(e) {
      await pool.query('UPDATE returns SET refund_status=$1 WHERE id=$2', ['failed', req.params.id]).catch(()=>{});
      console.log('Refund error:', e.message);
      // Surface the specific "no line items" reason to the merchant instead of a generic
      // message — this return cannot be refunded through Shopify until it has real Shopify
      // line item data linked to it (see the auto-fill logic in POST /api/returns above).
      const message = e.message && e.message.includes('No order line items linked')
        ? 'This return has no Shopify product data linked to it, so a refund cannot be processed automatically. This can happen for older returns created before line-item tracking — please process this refund directly in Shopify Admin instead.'
        : 'Refund processing failed. Please check Shopify and try again.';
      res.status(400).json({ error: message });
    }
  });

  // Returns CRUD with date filters
  // A specific shop requires that shop's own session; omitting shop (cross-merchant "all stores"
  // view) is a platform-owner-only action.
  app.get('/api/returns', (req, res, next) => {
    // Shop-scoped request: delegate to requireShopAccess, which verifies the Bearer token's
    // JWT signature and confirms it matches the requested shop (do NOT re-implement that check
    // here — an earlier inline "Bearer token length > 30" shortcut let anyone read any shop's
    // return data, including customer PII, by sending a fake Bearer token + ?shop=<victim>).
    if (req.query.shop && req.query.shop !== 'all') {
      return requireShopAccess(req, res, next);
    }
    return requireOwner(req, res, next);
  }, async (req, res) => {
    const { shop, status, type, date_from, date_to, archived } = req.query;
    let query = 'SELECT * FROM returns';
    const params = [];
    const conditions = [];
    let idx = 1;
    if (shop && shop !== 'all') {
      // Normalize shop domain to handle both 'taskly-test-store' and 'taskly-test-store.myshopify.com'
      const normalizedShop = shop.includes('.myshopify.com') ? shop : shop + '.myshopify.com';
      const baseShop = shop.replace('.myshopify.com', '');
      conditions.push(`(shop_domain=$${idx} OR shop_domain=$${idx+1})`);
      params.push(normalizedShop);
      params.push(baseShop);
      idx += 2;
    }
    if (status) { conditions.push(`status=$${idx++}`); params.push(status); }
    if (type) { conditions.push(`type=$${idx++}`); params.push(type); }
    if (date_from) { conditions.push(`created_at >= $${idx++}`); params.push(date_from); }
    if (date_to) { conditions.push(`created_at <= $${idx++}`); params.push(date_to); }
    if (archived === 'true') { conditions.push(`archived=true`); }
    else { conditions.push(`(archived IS NULL OR archived=false)`); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY created_at DESC';
    const r = await pool.query(query, params);
    res.json(r.rows);
  });

  app.get('/api/returns/stats', requireShopAccess, async (req, res) => {
    const { shop } = req.query;
    let w = shop ? ' WHERE shop_domain=$1' : '';
    const p = shop ? [shop] : [];
    const q = (extra) => pool.query(`SELECT COUNT(*) as count FROM returns${w}${w ? ' AND ' : ' WHERE '}${extra}`, p);
    const total = await pool.query('SELECT COUNT(*) as count FROM returns' + w, p);
    const pending = await q("status='pending'");
    const approved = await q("status='approved'");
    const inspected = await q("status='inspected'");
    const processed = await q("status='processed'");
    const refunded = await q("status='refunded'");
    const rejected = await q("status='rejected'");
    const exchanges = await q("type='exchange'");
    const totalAmount = await pool.query('SELECT COALESCE(SUM(amount),0) as total FROM returns' + w, p);
    const revenueSaved = await pool.query("SELECT COALESCE(SUM(amount),0) as total FROM returns" + (w || ' WHERE ') + (w ? ' AND ' : '') + "type='exchange'", p);
    res.json({
      total: parseInt(total.rows[0].count), pending: parseInt(pending.rows[0].count),
      approved: parseInt(approved.rows[0].count), inspected: parseInt(inspected.rows[0].count),
      processed: parseInt(processed.rows[0].count), refunded: parseInt(refunded.rows[0].count),
      rejected: parseInt(rejected.rows[0].count), exchanges: parseInt(exchanges.rows[0].count),
      total_amount: parseFloat(totalAmount.rows[0].total),
      revenue_saved: parseFloat(revenueSaved.rows[0].total)
    });
  });

  // Export CSV (Starter+ plan, with auth validation)
  app.get('/api/returns/export', async (req, res) => {
    const { shop } = req.query;
    // Token can come from query param (legacy/CSV download) OR Authorization header (modern)
    let token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');

    if (!shop) return res.status(400).json({ error: 'shop required' });
    if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) return res.status(400).json({ error: 'Invalid shop domain' });
    if (!token) return res.status(401).json({ error: 'Authentication required' });

    // Check plan requirement (Starter+)
    const planCheck = await pool.query('SELECT plan FROM shopify_stores WHERE shop_domain=$1', [shop]);
    if (!planCheck.rows.length) return res.status(404).json({ error: 'Store not found' });
    const plan = planCheck.rows[0].plan || 'free';
    const allowedPlans = ['starter', 'growth', 'pro'];
    if (!allowedPlans.includes(plan)) {
      return res.status(402).json({ error: `Export requires ${plan === 'free' ? 'Starter' : plan} plan. Please upgrade.` });
    }

    // Validate token (owner can export any store, team members only own store + check role,
    // embedded seller via verified Shopify session token for the same shop)
    const adminCheck = await pool.query('SELECT role FROM admin_users WHERE session_token=$1', [token]);
    if (adminCheck.rows.length > 0 && adminCheck.rows[0].role === 'owner') {
      // Owner: proceed
    } else {
      const shopifySession = verifyShopifySessionToken(token);
      if (shopifySession && shopifySession.shop === shop) {
        // Embedded app: Shopify-signed session token proves seller context for this shop
      } else {
        // Team member: must have admin role on the specific store
        const memberCheck = await pool.query('SELECT role FROM team_members WHERE session_token=$1 AND shop_domain=$2 AND role=$3', [token, shop, 'admin']);
        if (memberCheck.rows.length === 0) {
          return res.status(403).json({ error: 'Unauthorized (admin or owner role required)' });
        }
      }
    }
    let query = 'SELECT id,order_id,order_number,customer_name,customer_email,customer_phone,product_name,product_sku,quantity,reason,reason_detail,status,type,refund_method,amount,tracking_number,pickup_status,created_at,updated_at FROM returns WHERE shop_domain=$1';
    const params = [shop];
    query += ' ORDER BY created_at DESC';
    const r = await pool.query(query, params);

    // RFC 4180 CSV escaping: double quotes inside quoted fields, wrap in quotes if contains quotes/commas.
    // Also guards against CSV formula injection: customer-supplied fields like customer_name go
    // straight into this export, and Excel/Sheets will execute a leading =, +, -, or @ as a formula
    // when the file is opened — prefixing with a tab neutralizes that without changing what's displayed.
    function csvEscape(val) {
      let str = String(val || '');
      if (/^[=+\-@]/.test(str)) str = '\t' + str;
      if (str.includes('"') || str.includes(',') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return `"${str}"`;
    }

    const headers = 'ID,Order ID,Order Number,Customer Name,Email,Phone,Product,SKU,Qty,Reason,Details,Status,Type,Refund Method,Amount,Tracking,Pickup Status,Created,Updated\n';
    const csv = headers + r.rows.map(row =>
      `${row.id},${csvEscape(row.order_id)},${csvEscape(row.order_number)},${csvEscape(row.customer_name)},${csvEscape(row.customer_email)},${csvEscape(row.customer_phone)},${csvEscape(row.product_name)},${csvEscape(row.product_sku)},${row.quantity},${csvEscape(row.reason)},${csvEscape(row.reason_detail)},${row.status},${row.type},${row.refund_method},${row.amount},${csvEscape(row.tracking_number)},${row.pickup_status},${csvEscape(row.created_at)},${csvEscape(row.updated_at)}`
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=returns-export.csv');
    res.send(csv);
  });

  // Create return/exchange
  app.post('/api/returns', async (req, res) => {
    const { order_id, order_number, customer_name, customer_email, customer_phone, product_name, product_sku, quantity, reason, reason_detail, refund_method, amount, shop_domain, type, exchange_product, exchange_variant, images, line_items } = req.body;
    if (!shop_domain || !order_id || !customer_email || !reason) return res.status(400).json({ error: 'shop_domain, order_id, customer_email and reason are required' });
    if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop_domain)) return res.status(400).json({ error: 'Invalid shop domain' });

    // Check return count limit per plan (REQUIRED GATE)
    const storeRow = await pool.query('SELECT plan, return_window, exchange_window FROM shopify_stores WHERE shop_domain=$1', [shop_domain]);
    if (!storeRow.rows.length) return res.status(404).json({ error: 'Store not found' });
    const storePlan = storeRow.rows[0].plan || 'free';
    const planLimits = { free: 5, starter: 50, growth: 150, pro: 500 };
    const returnLimit = planLimits[storePlan] || 5;
    const returnCount = await pool.query('SELECT COUNT(*) as cnt FROM returns WHERE shop_domain=$1 AND type=$2', [shop_domain, type || 'return']);
    const count = parseInt(returnCount.rows[0].cnt || 0);
    if (count >= returnLimit) {
      return res.status(402).json({ error: `${storePlan} plan limit (${returnLimit} ${type || 'return'}s) reached. Please upgrade.` });
    }

    // Verify order ownership and enforce return window via Shopify API (REQUIRED)
    let shopifyVerified = false;
    // Line items required for GoReturn to later process a real Shopify refund on this return
    // (see processShopifyRefund below). The customer return portal already sends these directly
    // (it lets the customer pick specific products from their order). The merchant dashboard's
    // manual "Create Return" form does not have a product picker and never sent this — but the
    // order is already fetched and verified right below for email/window/amount checks, so we
    // derive line_items from that same real Shopify order data instead of requiring a UI change.
    let resolvedLineItems = line_items || '';
    // Explicit Shopify reference fields for traceability/debugging (additive — the refund flow
    // itself continues to rely solely on resolvedLineItems above, never on these). Populated from
    // the first resolved line item's match in the real Shopify order data fetched below, for both
    // the customer-portal path (client already sent real ids) and the dashboard auto-fill path.
    let shopifyLineItemId = '', shopifyProductId = '', shopifyVariantId = '', lineItemPrice = 0;
    try {
      const sr = await getStoreToken(shop_domain);
      if (!sr?.rows?.length) return res.status(503).json({ error: 'Store API token not configured. Contact support.' });

      const orderResp = await fetch(`https://${shop_domain}/admin/api/2025-04/orders.json?name=${encodeURIComponent(order_number || order_id)}&status=any`, {
        headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
      });
      if (!orderResp.ok) return res.status(503).json({ error: 'Unable to verify order with Shopify. Please try again.' });

      const orderData = await orderResp.json();
      const order = (orderData.orders || [])[0];
      if (!order) return res.status(404).json({ error: 'Order not found on Shopify' });

      shopifyVerified = true;
      // Order ownership check — email must match. Fail closed if Shopify has no email on file
      // for this order (POS/phone checkout) since there's nothing to verify identity against.
      if (!order.email) return res.status(403).json({ error: 'Cannot verify this order — no email on file. Contact the store owner.' });
      if (order.email.toLowerCase() !== customer_email.toLowerCase()) {
        return res.status(403).json({ error: 'Email does not match this order' });
      }
      // Return window check
      const window = type === 'exchange'
        ? (storeRow.rows[0]?.exchange_window ?? 14)
        : (storeRow.rows[0]?.return_window ?? 14);
      const orderAge = (Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60 * 24);
      if (orderAge > window) {
        return res.status(400).json({ error: `Return window of ${window} days has passed for this order` });
      }
      // Amount validation — cap at actual order total
      const orderTotal = parseFloat(order.total_price || 0);
      if (amount && parseFloat(amount) > orderTotal) {
        return res.status(400).json({ error: 'Refund amount cannot exceed order total' });
      }

      // Auto-fill line_items from the real Shopify order when the caller didn't supply any
      // (the manual dashboard form — the customer return portal always sends real line_items
      // directly, so resolvedLineItems is already non-empty there and this block never runs).
      //
      // Fail-safe by design: an unmatched SKU/name, or no identifying field at all, must NEVER
      // silently fall back to "every item on the order" — that previously allowed a refund for
      // one small item to silently expand into a refund for the customer's entire order. Every
      // path below either resolves to the exact matching item(s) or rejects return creation with
      // a clear error; there is no fallback that guesses.
      if (!resolvedLineItems) {
        const items = Array.isArray(order.line_items) ? order.line_items : [];
        if (product_sku) {
          const bySku = items.filter(li => (li.sku || '').toLowerCase() === String(product_sku).toLowerCase());
          if (!bySku.length) return res.status(400).json({ error: 'Product SKU does not match this Shopify order.' });
          resolvedLineItems = JSON.stringify(bySku.map(li => ({ id: li.id, quantity: li.quantity || 1 })));
        } else if (product_name) {
          const byName = items.filter(li => (li.title || '').toLowerCase() === String(product_name).toLowerCase());
          if (!byName.length) return res.status(400).json({ error: 'Product name does not match this Shopify order.' });
          resolvedLineItems = JSON.stringify(byName.map(li => ({ id: li.id, quantity: li.quantity || 1 })));
        } else {
          return res.status(400).json({ error: 'Please select a Shopify order item before creating a refundable return.' });
        }
      }

      // Populate the explicit reference columns from the real Shopify order line item —
      // covers both paths above (customer-portal-supplied ids and dashboard auto-filled ids),
      // since both end up as a JSON array of {id, quantity} matched against this same order.
      try {
        const resolvedArr = JSON.parse(resolvedLineItems || '[]');
        const firstId = resolvedArr[0]?.id;
        const matchedOrderItem = firstId && Array.isArray(order.line_items)
          ? order.line_items.find(li => String(li.id) === String(firstId))
          : null;
        if (matchedOrderItem) {
          shopifyLineItemId = String(matchedOrderItem.id);
          shopifyProductId = matchedOrderItem.product_id ? String(matchedOrderItem.product_id) : '';
          shopifyVariantId = matchedOrderItem.variant_id ? String(matchedOrderItem.variant_id) : '';
          lineItemPrice = parseFloat(matchedOrderItem.price || 0);
        }
      } catch(refErr) { /* purely informational fields — never block return creation over these */ }
    } catch(verifyErr) {
      console.log('Order verify error:', verifyErr.message);
      return res.status(503).json({ error: 'Shopify verification failed. Please try again later.' });
    }

    const r = await pool.query(
      `INSERT INTO returns (order_id,order_number,customer_name,customer_email,customer_phone,product_name,product_sku,quantity,reason,reason_detail,refund_method,amount,shop_domain,type,exchange_product,exchange_variant,images,line_items,shopify_line_item_id,shopify_product_id,shopify_variant_id,line_item_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
      [order_id||'',order_number||'',customer_name||'',customer_email||'',customer_phone||'',product_name||'',product_sku||'',quantity||1,reason||'',reason_detail||'',refund_method||'original',amount||0,shop_domain||'',type||'return',exchange_product||'',exchange_variant||'',images||'',resolvedLineItems||'',shopifyLineItemId,shopifyProductId,shopifyVariantId,lineItemPrice]
    );
    if (customer_email) {
      const tpl = await getEmailTemplates(shop_domain);
      const ph = { order: order_number||order_id, name: customer_name, amount, product: product_name };
      const subj = fillPlaceholders(tpl.pending.subject, ph);
      const msg = fillPlaceholders(tpl.pending.message, ph);
      sendEmail(customer_email, subj, returnStatusEmail(customer_name||'Customer', order_number||order_id, 'pending', amount, { product: product_name, reason, refund_method, returnId: r.rows[0].id, customMsg: msg }), null, r.rows[0].id);
    }
    res.json(r.rows[0]);
  });

  // Customer return tracking — email required to prevent IDOR enumeration
  app.get('/api/returns/track/:id', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required to track return' });
    const r = await pool.query('SELECT id,order_id,order_number,customer_name,customer_email,product_name,reason,status,refund_method,amount,tracking_number,pickup_status,created_at,updated_at FROM returns WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Return not found' });
    if (r.rows[0].customer_email && r.rows[0].customer_email.toLowerCase() !== email.toLowerCase()) return res.status(403).json({ error: 'Email does not match this return' });
    const { customer_email: _, ...safe } = r.rows[0];
    res.json(safe);
  });

  // Image upload via Shopify Files API
  app.post('/api/upload-image', requireShopAccess, async (req, res) => {
    const { shop, image_data, filename } = req.body;
    if (!shop || !image_data) return res.status(400).json({ error: 'shop and image_data required' });
    // MIME type validation — only allow safe image formats, block SVG/HTML/scripts
    const allowedMimePrefix = ['data:image/jpeg', 'data:image/png', 'data:image/webp', 'data:image/gif'];
    if (image_data.startsWith('data:') && !allowedMimePrefix.some(p => image_data.startsWith(p))) {
      return res.status(400).json({ error: 'Only JPEG, PNG, WebP and GIF images are allowed' });
    }
    const sr = await getStoreToken(shop);
    if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
    try {
      const mutation = `mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files { id alt createdAt fileStatus preview { image { url } } }
          userErrors { field message }
        }
      }`;
      const r = await fetch(`https://${shop}/admin/api/2025-04/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': sr.rows[0].access_token },
        body: JSON.stringify({
          query: mutation,
          variables: { files: [{ alt: 'Return image', contentType: 'IMAGE', originalSource: image_data }] }
        })
      });
      const d = await r.json();
      if (d.data?.fileCreate?.files?.[0]) {
        const file = d.data.fileCreate.files[0];
        res.json({ ok: true, url: file.preview?.image?.url || image_data, id: file.id });
      } else {
        res.json({ ok: true, url: image_data });
      }
    } catch(e) {
      res.json({ ok: true, url: image_data });
    }
  });

  // Save images to return
  app.post('/api/returns/:id/images', requireShopAccess, async (req, res) => {
    const { images } = req.body;
    const r = await pool.query('UPDATE returns SET images=$1, updated_at=NOW() WHERE id=$2 AND shop_domain=$3 RETURNING *', [images || '', req.params.id, req.verifiedShop]);
    if (!r.rows.length) return res.status(404).json({ error: 'Return not found' });
    res.json(r.rows[0]);
  });
}

module.exports = { registerReturnRoutes };
