require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const nodemailer = require('nodemailer');

const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '' }
});

async function sendEmail(to, subject, html) {
  if (!process.env.SMTP_USER) return;
  try {
    await emailTransporter.sendMail({
      from: `"Taskly Returns" <${process.env.SMTP_USER}>`,
      to, subject, html
    });
  } catch(e) { console.log('Email error:', e.message); }
}

function returnStatusEmail(customerName, orderId, status, amount) {
  const statusMessages = {
    pending: { title: 'Return Request Received', color: '#D97706', msg: 'We have received your return request and will review it shortly.' },
    approved: { title: 'Return Approved!', color: '#059669', msg: 'Great news! Your return has been approved. We will arrange pickup soon.' },
    inspected: { title: 'Product Inspected', color: '#7C3AED', msg: 'We have received and inspected your returned product.' },
    refunded: { title: 'Refund Processed!', color: '#0284C7', msg: 'Your refund has been processed. The amount will be credited within 5-7 business days.' },
    rejected: { title: 'Return Request Declined', color: '#DC2626', msg: 'Unfortunately, your return request could not be approved. Please contact support for more details.' },
    processed: { title: 'Return Completed', color: '#1D4ED8', msg: 'Your return has been fully processed. Thank you!' }
  };
  const s = statusMessages[status] || statusMessages.pending;
  return `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px">
    <div style="text-align:center;padding:16px;background:#4F46E5;color:white;border-radius:8px 8px 0 0"><h2 style="margin:0;font-size:18px">Taskly Returns</h2></div>
    <div style="padding:24px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 8px 8px">
      <div style="text-align:center;margin-bottom:16px"><span style="display:inline-block;padding:6px 16px;border-radius:20px;background:${s.color}20;color:${s.color};font-weight:600;font-size:14px">${s.title}</span></div>
      <p style="color:#374151;font-size:14px">Hi ${customerName},</p>
      <p style="color:#6B7280;font-size:14px">${s.msg}</p>
      <div style="background:#F9FAFB;border-radius:8px;padding:12px;margin:16px 0">
        <p style="margin:4px 0;font-size:13px;color:#6B7280">Order: <strong style="color:#111">${orderId}</strong></p>
        <p style="margin:4px 0;font-size:13px;color:#6B7280">Status: <strong style="color:${s.color}">${status.toUpperCase()}</strong></p>
        ${amount ? '<p style="margin:4px 0;font-size:13px;color:#6B7280">Amount: <strong style="color:#111">₹'+amount+'</strong></p>' : ''}
      </div>
      <p style="color:#9CA3AF;font-size:12px;margin-top:20px;text-align:center">Powered by Taskly Returns</p>
    </div>
  </div>`;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_APP_SHARED_SECRET;
const APP_URL = process.env.APP_URL || 'http://localhost:3001';
const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;
const SHIPROCKET_BASE = 'https://apiv2.shiprocket.in/v1/external';

let shiprocketToken = '';
let shiprocketTokenExpiry = 0;

async function getShiprocketToken() {
  if (shiprocketToken && Date.now() < shiprocketTokenExpiry) return shiprocketToken;
  if (!SHIPROCKET_EMAIL || !SHIPROCKET_PASSWORD) return null;
  const r = await fetch(`${SHIPROCKET_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: SHIPROCKET_EMAIL, password: SHIPROCKET_PASSWORD })
  });
  const d = await r.json();
  shiprocketToken = d.token;
  shiprocketTokenExpiry = Date.now() + 9 * 24 * 60 * 60 * 1000;
  return shiprocketToken;
}

async function shiprocketAPI(endpoint, method, body) {
  const token = await getShiprocketToken();
  if (!token) throw new Error('Shiprocket not configured');
  const opts = { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SHIPROCKET_BASE}${endpoint}`, opts);
  return r.json();
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopify_stores (
      id SERIAL PRIMARY KEY,
      shop_domain VARCHAR(255) UNIQUE NOT NULL,
      access_token TEXT NOT NULL,
      store_name VARCHAR(255) DEFAULT '',
      store_email VARCHAR(255) DEFAULT '',
      plan VARCHAR(50) DEFAULT 'starter',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS returns (
      id SERIAL PRIMARY KEY,
      shop_domain VARCHAR(255) DEFAULT '',
      order_id VARCHAR(255),
      order_number VARCHAR(255) DEFAULT '',
      customer_name VARCHAR(255),
      customer_email VARCHAR(255),
      customer_phone VARCHAR(50) DEFAULT '',
      product_name TEXT,
      product_sku VARCHAR(255) DEFAULT '',
      quantity INTEGER DEFAULT 1,
      reason TEXT,
      reason_detail TEXT DEFAULT '',
      status VARCHAR(50) DEFAULT 'pending',
      refund_method VARCHAR(50) DEFAULT 'original',
      amount NUMERIC(10,2) DEFAULT 0,
      tracking_number VARCHAR(255) DEFAULT '',
      pickup_status VARCHAR(50) DEFAULT '',
      merchant_notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  try {
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS order_number VARCHAR(255) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(50) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS product_sku VARCHAR(255) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS reason_detail TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(255) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS pickup_status VARCHAR(50) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS merchant_notes TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS store_name VARCHAR(255) DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS store_email VARCHAR(255) DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS plan VARCHAR(50) DEFAULT 'starter'`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shiprocket_email VARCHAR(255) DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shiprocket_password TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shiprocket_token TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shiprocket_connected BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS portal_color VARCHAR(20) DEFAULT '#4F46E5'`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS portal_banner TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS return_window INTEGER DEFAULT 14`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS exchange_window INTEGER DEFAULT 14`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS auto_approve_under NUMERIC(10,2) DEFAULT 0`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS notify_email BOOLEAN DEFAULT true`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'return'`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS exchange_product TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS exchange_variant TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS inspected_at TIMESTAMP`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMP`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS risk_level VARCHAR(20) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS images TEXT DEFAULT ''`);
    await pool.query(`CREATE TABLE IF NOT EXISTS store_settings (
      id SERIAL PRIMARY KEY,
      shop_domain VARCHAR(255) UNIQUE NOT NULL,
      return_reasons TEXT DEFAULT 'Damaged Product,Wrong Item Received,Size/Fit Issue,Quality Not As Expected,Not As Described,Changed My Mind',
      exchange_reasons TEXT DEFAULT 'Wrong Size,Wrong Color,Want Different Product',
      refund_methods TEXT DEFAULT 'Original Payment Method,Bank Transfer,Store Credit,UPI',
      notification_emails TEXT DEFAULT '',
      auto_approve_enabled BOOLEAN DEFAULT false,
      auto_approve_amount NUMERIC(10,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  } catch(e) {}
  console.log('DB ready');
}

// OAuth
app.get('/api/auth/shopify', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const nonce = crypto.randomBytes(16).toString('hex');
  const redirectUri = encodeURIComponent(`${APP_URL}/api/auth/callback`);
  const scopes = 'read_orders,write_orders,read_customers,read_products,read_inventory';
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${redirectUri}&state=${nonce}`);
});

app.get('/api/auth/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).send('Missing params');
  try {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code })
    });
    const { access_token } = await r.json();

    let storeName = shop;
    try {
      const shopInfo = await fetch(`https://${shop}/admin/api/2024-01/shop.json`, {
        headers: { 'X-Shopify-Access-Token': access_token }
      });
      const shopData = await shopInfo.json();
      storeName = shopData.shop?.name || shop;
      const storeEmail = shopData.shop?.email || '';
      await pool.query(
        'INSERT INTO shopify_stores (shop_domain, access_token, store_name, store_email) VALUES ($1,$2,$3,$4) ON CONFLICT (shop_domain) DO UPDATE SET access_token=$2, store_name=$3, store_email=$4',
        [shop, access_token, storeName, storeEmail]
      );
    } catch(e) {
      await pool.query(
        'INSERT INTO shopify_stores (shop_domain, access_token) VALUES ($1,$2) ON CONFLICT (shop_domain) DO UPDATE SET access_token=$2',
        [shop, access_token]
      );
    }

    const plan = req.query.plan || 'starter';
    if (plan === 'free_trial') {
      res.redirect(`/?shop=${shop}&connected=true`);
    } else {
      res.redirect(`/api/billing/create?shop=${shop}&plan=${plan}`);
    }
  } catch(e) { res.status(500).send('OAuth error: ' + e.message); }
});

// Billing
const PLANS = {
  free: { name: 'Free', price: 0, returns: 5, trial_days: 0 },
  starter: { name: 'Starter', price: 999, returns: 50, trial_days: 15 },
  growth: { name: 'Growth', price: 1999, returns: 200, trial_days: 15 },
  pro: { name: 'Pro', price: 4999, returns: 999999, trial_days: 15 }
};

app.get('/api/billing/create', async (req, res) => {
  const { shop, plan } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const planData = PLANS[plan] || PLANS.starter;
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
  try {
    const r = await fetch(`https://${shop}/admin/api/2024-01/recurring_application_charges.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': sr.rows[0].access_token },
      body: JSON.stringify({
        recurring_application_charge: {
          name: `Taskly Returns - ${planData.name}`,
          price: planData.price,
          return_url: `${APP_URL}/api/billing/confirm?shop=${shop}&plan=${plan}`,
          trial_days: planData.trial_days,
          test: process.env.NODE_ENV !== 'production' || shop.includes('test')
        }
      })
    });
    const data = await r.json();
    const charge = data.recurring_application_charge;
    if (charge && charge.confirmation_url) {
      res.redirect(charge.confirmation_url);
    } else {
      res.redirect(`/?shop=${shop}&connected=true&billing=skipped`);
    }
  } catch(e) {
    res.redirect(`/?shop=${shop}&connected=true&billing=error`);
  }
});

app.get('/api/billing/confirm', async (req, res) => {
  const { shop, plan, charge_id } = req.query;
  if (!shop || !charge_id) return res.redirect(`/?shop=${shop}&connected=true`);
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.redirect('/');
  try {
    const r = await fetch(`https://${shop}/admin/api/2024-01/recurring_application_charges/${charge_id}.json`, {
      headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
    });
    const data = await r.json();
    const charge = data.recurring_application_charge;
    if (charge && charge.status === 'accepted') {
      await fetch(`https://${shop}/admin/api/2024-01/recurring_application_charges/${charge_id}/activate.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': sr.rows[0].access_token },
        body: JSON.stringify({ recurring_application_charge: { id: charge_id } })
      });
      await pool.query('UPDATE shopify_stores SET plan=$1 WHERE shop_domain=$2', [plan || 'starter', shop]);
    }
    res.redirect(`/?shop=${shop}&connected=true&plan=${plan}`);
  } catch(e) {
    res.redirect(`/?shop=${shop}&connected=true`);
  }
});

app.get('/api/billing/plans', (req, res) => {
  res.json(PLANS);
});

// Stores
app.get('/api/shopify/stores', async (req, res) => {
  const r = await pool.query('SELECT shop_domain, store_name, store_email, plan, created_at FROM shopify_stores ORDER BY created_at DESC');
  res.json(r.rows);
});

// Orders from Shopify
app.get('/api/shopify/orders', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
  try {
    const r = await fetch(`https://${shop}/admin/api/2024-01/orders.json?status=any&limit=50`, {
      headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
    });
    const d = await r.json();
    res.json(d.orders || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Single order lookup (for customer return portal)
app.get('/api/shopify/order-lookup', async (req, res) => {
  const { shop, order_number, email } = req.query;
  if (!shop || !order_number) return res.status(400).json({ error: 'shop and order_number required' });
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not found' });
  try {
    const r = await fetch(`https://${shop}/admin/api/2024-01/orders.json?name=${encodeURIComponent(order_number)}&status=any`, {
      headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
    });
    const d = await r.json();
    const orders = d.orders || [];
    if (!orders.length) return res.status(404).json({ error: 'Order not found' });
    const order = orders[0];
    if (email && order.email && order.email.toLowerCase() !== email.toLowerCase()) {
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Shopify Refund (uses Shopify's built-in refund)
app.post('/api/shopify/refund', async (req, res) => {
  const { shop, order_id, amount, note } = req.body;
  if (!shop || !order_id) return res.status(400).json({ error: 'shop and order_id required' });
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
  try {
    const calcResp = await fetch(`https://${shop}/admin/api/2024-01/orders/${order_id}/refunds/calculate.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': sr.rows[0].access_token },
      body: JSON.stringify({ refund: { currency: 'INR', shipping: { full_refund: false } } })
    });
    const calcData = await calcResp.json();
    const refundResp = await fetch(`https://${shop}/admin/api/2024-01/orders/${order_id}/refunds.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': sr.rows[0].access_token },
      body: JSON.stringify({
        refund: {
          note: note || 'Refund via Taskly Returns',
          transactions: calcData.refund?.transactions || [],
          shipping: { full_refund: false }
        }
      })
    });
    const refundData = await refundResp.json();
    res.json(refundData);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Returns CRUD with date filters
app.get('/api/returns', async (req, res) => {
  const { shop, status, type, date_from, date_to, archived } = req.query;
  let query = 'SELECT * FROM returns';
  const params = [];
  const conditions = [];
  let idx = 1;
  if (shop) { conditions.push(`shop_domain=$${idx++}`); params.push(shop); }
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

app.get('/api/returns/stats', async (req, res) => {
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

// Analytics with date range
app.get('/api/analytics', async (req, res) => {
  const { shop, days } = req.query;
  const d = parseInt(days) || 30;
  const p = shop ? [shop] : [];
  const w = shop ? ' AND shop_domain=$1' : '';
  const daily = await pool.query(
    `SELECT DATE(created_at) as date, COUNT(*) as count, COALESCE(SUM(amount),0) as amount,
     SUM(CASE WHEN type='exchange' THEN amount ELSE 0 END) as saved
     FROM returns WHERE created_at >= NOW() - INTERVAL '${d} days'${w}
     GROUP BY DATE(created_at) ORDER BY date`, p);
  const byReason = await pool.query(
    `SELECT reason, COUNT(*) as count FROM returns WHERE created_at >= NOW() - INTERVAL '${d} days'${w} GROUP BY reason ORDER BY count DESC LIMIT 10`, p);
  const byStatus = await pool.query(
    `SELECT status, COUNT(*) as count FROM returns WHERE created_at >= NOW() - INTERVAL '${d} days'${w} GROUP BY status`, p);
  res.json({ daily: daily.rows, by_reason: byReason.rows, by_status: byStatus.rows });
});

// Order Analytics — fetch all orders from Shopify and analyze
app.get('/api/analytics/orders', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
  try {
    const r = await fetch(`https://${shop}/admin/api/2024-01/orders.json?status=any&limit=250`, {
      headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
    });
    const d = await r.json();
    const orders = d.orders || [];

    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
    const codOrders = orders.filter(o => o.gateway === 'Cash on Delivery (COD)' || o.payment_gateway_names?.some(g => g.toLowerCase().includes('cod'))).length;
    const prepaidOrders = totalOrders - codOrders;

    const byCity = {};
    const byState = {};
    const byPincode = {};
    orders.forEach(o => {
      const addr = o.shipping_address || o.billing_address || {};
      const city = addr.city || 'Unknown';
      const state = addr.province || 'Unknown';
      const pin = addr.zip || 'Unknown';
      byCity[city] = (byCity[city] || 0) + 1;
      byState[state] = (byState[state] || 0) + 1;
      byPincode[pin] = (byPincode[pin] || 0) + 1;
    });

    const byProduct = {};
    orders.forEach(o => {
      (o.line_items || []).forEach(li => {
        const name = li.title || 'Unknown';
        if (!byProduct[name]) byProduct[name] = { sold: 0, revenue: 0 };
        byProduct[name].sold += li.quantity;
        byProduct[name].revenue += parseFloat(li.price) * li.quantity;
      });
    });

    const byDate = {};
    orders.forEach(o => {
      const d = new Date(o.created_at).toISOString().split('T')[0];
      if (!byDate[d]) byDate[d] = { count: 0, revenue: 0 };
      byDate[d].count++;
      byDate[d].revenue += parseFloat(o.total_price || 0);
    });

    const topCities = Object.entries(byCity).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([city, count]) => ({ city, count }));
    const topStates = Object.entries(byState).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([state, count]) => ({ state, count }));
    const topPincodes = Object.entries(byPincode).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([pincode, count]) => ({ pincode, count }));
    const topProducts = Object.entries(byProduct).sort((a, b) => b[1].sold - a[1].sold).slice(0, 20).map(([name, data]) => ({ name, sold: data.sold, revenue: Math.round(data.revenue) }));
    const dailyOrders = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0])).slice(-30).map(([date, data]) => ({ date, count: data.count, revenue: Math.round(data.revenue) }));

    res.json({
      total_orders: totalOrders, total_revenue: Math.round(totalRevenue),
      cod_orders: codOrders, prepaid_orders: prepaidOrders,
      cod_percent: totalOrders ? Math.round(codOrders / totalOrders * 100) : 0,
      top_cities: topCities, top_states: topStates, top_pincodes: topPincodes,
      top_products: topProducts, daily_orders: dailyOrders
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Return Analytics by location and product
app.get('/api/analytics/returns-deep', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.json({ by_product: [], by_city: [] });
  try {
    const ordersResp = await fetch(`https://${shop}/admin/api/2024-01/orders.json?status=any&limit=250`, {
      headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
    });
    const ordersData = await ordersResp.json();
    const orders = ordersData.orders || [];
    const orderMap = {};
    orders.forEach(o => {
      orderMap[o.name] = o;
      orderMap[String(o.id)] = o;
    });

    const returns = await pool.query('SELECT * FROM returns WHERE shop_domain=$1', [shop]);
    const byProduct = {};
    const byCity = {};
    const byPincode = {};

    returns.rows.forEach(ret => {
      const prod = ret.product_name || 'Unknown';
      if (!byProduct[prod]) byProduct[prod] = { returns: 0, exchanges: 0, amount: 0 };
      if (ret.type === 'exchange') byProduct[prod].exchanges++;
      else byProduct[prod].returns++;
      byProduct[prod].amount += parseFloat(ret.amount || 0);

      const order = orderMap[ret.order_number] || orderMap[ret.order_id];
      if (order) {
        const addr = order.shipping_address || order.billing_address || {};
        const city = addr.city || 'Unknown';
        const pin = addr.zip || 'Unknown';
        byCity[city] = (byCity[city] || 0) + 1;
        byPincode[pin] = (byPincode[pin] || 0) + 1;
      }
    });

    const productData = Object.entries(byProduct).sort((a, b) => (b[1].returns + b[1].exchanges) - (a[1].returns + a[1].exchanges)).slice(0, 20).map(([name, data]) => ({ name, ...data, total: data.returns + data.exchanges }));
    const cityData = Object.entries(byCity).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([city, count]) => ({ city, count }));
    const pincodeData = Object.entries(byPincode).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([pincode, count]) => ({ pincode, count }));

    res.json({ by_product: productData, by_city: cityData, by_pincode: pincodeData });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Export CSV
app.get('/api/returns/export', async (req, res) => {
  const { shop } = req.query;
  let query = 'SELECT id,order_id,order_number,customer_name,customer_email,customer_phone,product_name,product_sku,quantity,reason,reason_detail,status,type,refund_method,amount,tracking_number,pickup_status,created_at,updated_at FROM returns';
  const params = [];
  if (shop) { query += ' WHERE shop_domain=$1'; params.push(shop); }
  query += ' ORDER BY created_at DESC';
  const r = await pool.query(query, params);
  const headers = 'ID,Order ID,Order Number,Customer Name,Email,Phone,Product,SKU,Qty,Reason,Details,Status,Type,Refund Method,Amount,Tracking,Pickup Status,Created,Updated\n';
  const csv = headers + r.rows.map(row =>
    `${row.id},"${row.order_id}","${row.order_number}","${row.customer_name}","${row.customer_email}","${row.customer_phone}","${row.product_name}","${row.product_sku}",${row.quantity},"${row.reason}","${row.reason_detail}",${row.status},${row.type},${row.refund_method},${row.amount},"${row.tracking_number}",${row.pickup_status},"${row.created_at}","${row.updated_at}"`
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=returns-export.csv');
  res.send(csv);
});

// Store settings
// Portal customization API (public - no auth needed)
app.get('/api/portal-settings', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.json({});
  try {
    const store = await pool.query('SELECT store_name, portal_color FROM shopify_stores WHERE shop_domain=$1', [shop]);
    const settings = await pool.query('SELECT * FROM store_settings WHERE shop_domain=$1', [shop]);
    const s = store.rows[0] || {};
    const ss = settings.rows[0] || {};
    res.json({
      store_name: s.store_name || shop.replace('.myshopify.com', ''),
      color: s.portal_color || '#4F46E5',
      heading: ss.portal_heading || 'Return & Exchange Portal',
      subheading: ss.portal_subheading || 'Submit your return request in 3 easy steps',
      logo_url: ss.portal_logo || '',
      return_reasons: ss.return_reasons || 'Damaged Product,Wrong Item Received,Size/Fit Issue,Quality Not As Expected,Not As Described,Changed My Mind',
      exchange_reasons: ss.exchange_reasons || 'Wrong Size,Wrong Color,Want Different Product',
      exchange_enabled: ss.exchange_enabled !== false,
      refund_methods: ss.refund_methods || 'Original Payment Method,Bank Transfer,Store Credit,UPI'
    });
  } catch(e) { res.json({}); }
});

// Save portal customization
app.post('/api/portal-settings', async (req, res) => {
  const { shop, heading, subheading, logo_url, exchange_enabled } = req.body;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  try {
    await pool.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS portal_heading TEXT DEFAULT 'Return & Exchange Portal'`);
    await pool.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS portal_subheading TEXT DEFAULT 'Submit your return request in 3 easy steps'`);
    await pool.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS portal_logo TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS exchange_enabled BOOLEAN DEFAULT true`);
    await pool.query(
      `INSERT INTO store_settings (shop_domain, portal_heading, portal_subheading, portal_logo, exchange_enabled)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (shop_domain) DO UPDATE SET portal_heading=$2, portal_subheading=$3, portal_logo=$4, exchange_enabled=$5`,
      [shop, heading||'Return & Exchange Portal', subheading||'Submit your return request in 3 easy steps', logo_url||'', exchange_enabled!==false]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/settings', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const store = await pool.query('SELECT portal_color,portal_banner,return_window,exchange_window,auto_approve_under,notify_email FROM shopify_stores WHERE shop_domain=$1', [shop]);
  const settings = await pool.query('SELECT * FROM store_settings WHERE shop_domain=$1', [shop]);
  res.json({ store: store.rows[0] || {}, settings: settings.rows[0] || {} });
});

app.post('/api/settings', async (req, res) => {
  const { shop, portal_color, return_window, exchange_window, auto_approve_under, notify_email, return_reasons, exchange_reasons, refund_methods, auto_approve_enabled } = req.body;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  await pool.query('UPDATE shopify_stores SET portal_color=$1, return_window=$2, exchange_window=$3, auto_approve_under=$4, notify_email=$5 WHERE shop_domain=$6',
    [portal_color||'#4F46E5', return_window||14, exchange_window||14, auto_approve_under||0, notify_email!==false, shop]);
  await pool.query(
    `INSERT INTO store_settings (shop_domain, return_reasons, exchange_reasons, refund_methods, auto_approve_enabled, auto_approve_amount)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (shop_domain) DO UPDATE SET return_reasons=$2, exchange_reasons=$3, refund_methods=$4, auto_approve_enabled=$5, auto_approve_amount=$6`,
    [shop, return_reasons||'', exchange_reasons||'', refund_methods||'', auto_approve_enabled||false, auto_approve_under||0]);
  res.json({ ok: true });
});

// Create return/exchange
app.post('/api/returns', async (req, res) => {
  const { order_id, order_number, customer_name, customer_email, customer_phone, product_name, product_sku, quantity, reason, reason_detail, refund_method, amount, shop_domain, type, exchange_product, exchange_variant, images } = req.body;
  const r = await pool.query(
    `INSERT INTO returns (order_id,order_number,customer_name,customer_email,customer_phone,product_name,product_sku,quantity,reason,reason_detail,refund_method,amount,shop_domain,type,exchange_product,exchange_variant,images)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [order_id||'',order_number||'',customer_name||'',customer_email||'',customer_phone||'',product_name||'',product_sku||'',quantity||1,reason||'',reason_detail||'',refund_method||'original',amount||0,shop_domain||'',type||'return',exchange_product||'',exchange_variant||'',images||'']
  );
  if (customer_email) sendEmail(customer_email, 'Return Request Received - ' + (order_number||order_id), returnStatusEmail(customer_name||'Customer', order_number||order_id, 'pending', amount));
  res.json(r.rows[0]);
});

app.patch('/api/returns/:id', async (req, res) => {
  const { status, merchant_notes, tracking_number, pickup_status, archived, risk_level } = req.body;
  const fields = [];
  const values = [];
  let idx = 1;
  if (status) {
    fields.push(`status=$${idx++}`); values.push(status);
    if (status === 'inspected') fields.push('inspected_at=NOW()');
    if (status === 'refunded') fields.push('refunded_at=NOW()');
  }
  if (merchant_notes !== undefined) { fields.push(`merchant_notes=$${idx++}`); values.push(merchant_notes); }
  if (tracking_number !== undefined) { fields.push(`tracking_number=$${idx++}`); values.push(tracking_number); }
  if (pickup_status !== undefined) { fields.push(`pickup_status=$${idx++}`); values.push(pickup_status); }
  if (archived !== undefined) { fields.push(`archived=$${idx++}`); values.push(archived); }
  if (risk_level !== undefined) { fields.push(`risk_level=$${idx++}`); values.push(risk_level); }
  fields.push(`updated_at=NOW()`);
  values.push(req.params.id);
  const r = await pool.query(`UPDATE returns SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`, values);
  const ret = r.rows[0];
  if (status && ret.customer_email) sendEmail(ret.customer_email, `Return ${status.toUpperCase()} - ${ret.order_number||ret.order_id}`, returnStatusEmail(ret.customer_name||'Customer', ret.order_number||ret.order_id, status, ret.amount));
  res.json(ret);
});

// Customer return tracking
app.get('/api/returns/track/:id', async (req, res) => {
  const r = await pool.query('SELECT id,order_id,order_number,customer_name,product_name,reason,status,refund_method,amount,tracking_number,pickup_status,created_at,updated_at FROM returns WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Return not found' });
  res.json(r.rows[0]);
});

// Shiprocket Connect (per seller)
app.post('/api/shiprocket/connect', async (req, res) => {
  const { shop, email, password } = req.body;
  if (!shop || !email || !password) return res.status(400).json({ error: 'shop, email, password required' });
  try {
    const r = await fetch(`${SHIPROCKET_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const d = await r.json();
    if (!d.token) return res.status(400).json({ error: 'Invalid Shiprocket credentials' });
    await pool.query(
      'UPDATE shopify_stores SET shiprocket_email=$1, shiprocket_password=$2, shiprocket_token=$3, shiprocket_connected=true WHERE shop_domain=$4',
      [email, password, d.token, shop]
    );
    res.json({ ok: true, message: 'Shiprocket connected successfully!' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/shiprocket/disconnect', async (req, res) => {
  const { shop } = req.body;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  await pool.query(
    'UPDATE shopify_stores SET shiprocket_email=$1, shiprocket_password=$2, shiprocket_token=$3, shiprocket_connected=false WHERE shop_domain=$4',
    ['', '', '', shop]
  );
  res.json({ ok: true });
});

app.get('/api/shiprocket/status', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const r = await pool.query('SELECT shiprocket_connected, shiprocket_email FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!r.rows.length) return res.json({ connected: false });
  res.json({ connected: r.rows[0].shiprocket_connected, email: r.rows[0].shiprocket_email });
});

async function getSellerShiprocketToken(shop) {
  const r = await pool.query('SELECT shiprocket_token, shiprocket_email, shiprocket_password FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!r.rows.length || !r.rows[0].shiprocket_email) return null;
  let token = r.rows[0].shiprocket_token;
  if (!token) {
    const resp = await fetch(`${SHIPROCKET_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: r.rows[0].shiprocket_email, password: r.rows[0].shiprocket_password })
    });
    const d = await resp.json();
    token = d.token;
    if (token) await pool.query('UPDATE shopify_stores SET shiprocket_token=$1 WHERE shop_domain=$2', [token, shop]);
  }
  return token;
}

async function sellerShiprocketAPI(shop, endpoint, method, body) {
  const token = await getSellerShiprocketToken(shop);
  if (!token) throw new Error('Shiprocket not connected for this store');
  const opts = { method, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${SHIPROCKET_BASE}${endpoint}`, opts);
  return r.json();
}

// Shiprocket APIs (per seller)
app.post('/api/shiprocket/pickup', async (req, res) => {
  const { return_id, shop, customer_name, customer_email, customer_phone, customer_address, customer_city, customer_state, customer_pincode, product_name, product_sku, quantity, amount, order_id } = req.body;
  if (!return_id || !shop) return res.status(400).json({ error: 'return_id and shop required' });
  try {
    const orderData = await sellerShiprocketAPI(shop, '/orders/create/return', 'POST', {
      order_id: `RETURN-${return_id}`,
      order_date: new Date().toISOString().split('T')[0],
      channel_id: '',
      pickup_customer_name: customer_name,
      pickup_address: customer_address || 'Customer Address',
      pickup_city: customer_city || 'City',
      pickup_state: customer_state || 'State',
      pickup_country: 'India',
      pickup_pincode: customer_pincode || '110001',
      pickup_email: customer_email || '',
      pickup_phone: customer_phone || '',
      shipping_customer_name: customer_name,
      shipping_address: customer_address || 'Warehouse Address',
      shipping_city: customer_city || 'City',
      shipping_state: customer_state || 'State',
      shipping_country: 'India',
      shipping_pincode: customer_pincode || '110001',
      shipping_email: customer_email || '',
      shipping_phone: customer_phone || '',
      order_items: [{
        name: product_name || 'Return Item',
        sku: product_sku || 'SKU',
        units: quantity || 1,
        selling_price: amount || 0
      }],
      payment_method: 'prepaid',
      sub_total: amount || 0,
      length: 10, breadth: 10, height: 10, weight: 0.5
    });
    if (orderData.order_id) {
      await pool.query('UPDATE returns SET pickup_status=$1, tracking_number=$2, updated_at=NOW() WHERE id=$3',
        ['pickup_scheduled', orderData.shipment_id || '', return_id]);
    }
    res.json(orderData);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/shiprocket/track/:shipment_id', async (req, res) => {
  const { shop } = req.query;
  try {
    const data = shop ? await sellerShiprocketAPI(shop, `/courier/track/shipment/${req.params.shipment_id}`, 'GET') : await shiprocketAPI(`/courier/track/shipment/${req.params.shipment_id}`, 'GET');
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Admin APIs
const ADMIN_KEY = process.env.ADMIN_KEY || 'taskly2026admin';

function checkAdmin(req, res) {
  const key = req.body?.admin_key || req.query?.admin_key;
  if (key !== ADMIN_KEY) { res.status(403).json({ error: 'Unauthorized' }); return false; }
  return true;
}

app.post('/api/admin/change-plan', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { shop, plan } = req.body;
  await pool.query('UPDATE shopify_stores SET plan=$1 WHERE shop_domain=$2', [plan, shop]);
  res.json({ ok: true });
});

app.post('/api/admin/free-access', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { shop, plan, duration_days } = req.body;
  await pool.query('UPDATE shopify_stores SET plan=$1 WHERE shop_domain=$2', [plan || 'free', shop]);
  res.json({ ok: true, shop, plan, duration_days });
});

app.get('/api/admin/offers', async (req, res) => {
  if (!checkAdmin(req, res)) return;
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

app.post('/api/admin/offers', async (req, res) => {
  if (!checkAdmin(req, res)) return;
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

app.patch('/api/admin/offers/:id', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { active } = req.body;
  const r = await pool.query('UPDATE offers SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
  res.json(r.rows[0]);
});

app.post('/api/offers/redeem', async (req, res) => {
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Customer fraud score
app.get('/api/analytics/fraud', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  try {
    const r = await pool.query(
      `SELECT customer_email, customer_name, COUNT(*) as return_count, COALESCE(SUM(amount),0) as total_amount,
       MAX(created_at) as last_return FROM returns WHERE shop_domain=$1 AND customer_email!=''
       GROUP BY customer_email, customer_name HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC LIMIT 20`, [shop]);
    const customers = r.rows.map(c => ({
      ...c, return_count: parseInt(c.return_count), total_amount: Math.round(parseFloat(c.total_amount)),
      risk: parseInt(c.return_count) >= 5 ? 'high' : parseInt(c.return_count) >= 3 ? 'medium' : 'low'
    }));
    res.json(customers);
  } catch(e) { res.json([]); }
});

// Pincode risk score
app.get('/api/analytics/pincode-risk', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.json([]);
  try {
    const ordersResp = await fetch(`https://${shop}/admin/api/2024-01/orders.json?status=any&limit=250`, {
      headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
    });
    const ordersData = await ordersResp.json();
    const orders = ordersData.orders || [];
    const returns = await pool.query('SELECT * FROM returns WHERE shop_domain=$1', [shop]);
    const orderMap = {};
    orders.forEach(o => { orderMap[o.name] = o; orderMap[String(o.id)] = o; });

    const pincodeData = {};
    orders.forEach(o => {
      const pin = o.shipping_address?.zip || 'Unknown';
      const city = o.shipping_address?.city || 'Unknown';
      if (!pincodeData[pin]) pincodeData[pin] = { pincode: pin, city, orders: 0, returns: 0 };
      pincodeData[pin].orders++;
    });
    returns.rows.forEach(ret => {
      const order = orderMap[ret.order_number] || orderMap[ret.order_id];
      if (order) {
        const pin = order.shipping_address?.zip || 'Unknown';
        if (pincodeData[pin]) pincodeData[pin].returns++;
      }
    });

    const result = Object.values(pincodeData)
      .map(p => ({ ...p, return_rate: p.orders ? Math.round(p.returns / p.orders * 100) : 0,
        risk: p.orders >= 3 && (p.returns / p.orders) >= 0.3 ? 'high' : (p.returns / p.orders) >= 0.15 ? 'medium' : 'low' }))
      .filter(p => p.orders >= 2)
      .sort((a, b) => b.return_rate - a.return_rate).slice(0, 20);
    res.json(result);
  } catch(e) { res.json([]); }
});

// Image upload via Shopify Files API
app.post('/api/upload-image', async (req, res) => {
  const { shop, image_data, filename } = req.body;
  if (!shop || !image_data) return res.status(400).json({ error: 'shop and image_data required' });
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
  try {
    const mutation = `mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files { id alt createdAt fileStatus preview { image { url } } }
        userErrors { field message }
      }
    }`;
    const r = await fetch(`https://${shop}/admin/api/2024-01/graphql.json`, {
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
app.post('/api/returns/:id/images', async (req, res) => {
  const { images } = req.body;
  const r = await pool.query('UPDATE returns SET images=$1, updated_at=NOW() WHERE id=$2 RETURNING *', [images || '', req.params.id]);
  res.json(r.rows[0]);
});

// Automation Rules (Wonder Bot)
app.get('/api/automation/rules', async (req, res) => {
  const { shop } = req.query;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS automation_rules (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), name VARCHAR(255),
      condition_field VARCHAR(50), condition_operator VARCHAR(20), condition_value TEXT,
      action_type VARCHAR(50), action_value TEXT, active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('SELECT * FROM automation_rules WHERE shop_domain=$1 ORDER BY created_at DESC', [shop||'']);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/automation/rules', async (req, res) => {
  const { shop, name, condition_field, condition_operator, condition_value, action_type, action_value } = req.body;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS automation_rules (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), name VARCHAR(255),
      condition_field VARCHAR(50), condition_operator VARCHAR(20), condition_value TEXT,
      action_type VARCHAR(50), action_value TEXT, active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('INSERT INTO automation_rules (shop_domain,name,condition_field,condition_operator,condition_value,action_type,action_value) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [shop,name,condition_field,condition_operator,condition_value,action_type,action_value]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/automation/rules/:id', async (req, res) => {
  await pool.query('DELETE FROM automation_rules WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Promotions (Wonder Promotions - incentivize exchange over refund)
app.get('/api/promotions', async (req, res) => {
  const { shop } = req.query;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS promotions (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), name VARCHAR(255),
      type VARCHAR(50) DEFAULT 'store_credit_bonus', bonus_percent INTEGER DEFAULT 10,
      message TEXT DEFAULT 'Choose exchange and get 10% bonus store credit!',
      active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('SELECT * FROM promotions WHERE shop_domain=$1', [shop||'']);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/promotions', async (req, res) => {
  const { shop, name, type, bonus_percent, message } = req.body;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS promotions (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), name VARCHAR(255),
      type VARCHAR(50) DEFAULT 'store_credit_bonus', bonus_percent INTEGER DEFAULT 10,
      message TEXT, active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('INSERT INTO promotions (shop_domain,name,type,bonus_percent,message) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [shop,name||'Exchange Bonus',type||'store_credit_bonus',bonus_percent||10,message||'']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/promotions/:id', async (req, res) => {
  const { active } = req.body;
  const r = await pool.query('UPDATE promotions SET active=$1 WHERE id=$2 RETURNING *', [active, req.params.id]);
  res.json(r.rows[0]);
});

// Webhooks
app.get('/api/webhooks', async (req, res) => {
  const { shop } = req.query;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS webhooks (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), url TEXT NOT NULL,
      events TEXT DEFAULT 'return.created,return.approved,return.rejected,return.refunded',
      active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('SELECT * FROM webhooks WHERE shop_domain=$1', [shop||'']);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/webhooks', async (req, res) => {
  const { shop, url, events } = req.body;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS webhooks (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), url TEXT NOT NULL,
      events TEXT DEFAULT 'return.created,return.approved,return.rejected,return.refunded',
      active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('INSERT INTO webhooks (shop_domain,url,events) VALUES ($1,$2,$3) RETURNING *', [shop,url,events||'return.created,return.approved']);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/webhooks/:id', async (req, res) => {
  await pool.query('DELETE FROM webhooks WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// Mark order as returned on Shopify (tags)
app.post('/api/shopify/tag-order', async (req, res) => {
  const { shop, order_id, tags } = req.body;
  if (!shop || !order_id) return res.status(400).json({ error: 'shop and order_id required' });
  const sr = await pool.query('SELECT access_token FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
  try {
    const r = await fetch(`https://${shop}/admin/api/2024-01/orders/${order_id}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': sr.rows[0].access_token },
      body: JSON.stringify({ order: { id: order_id, tags: tags || 'return-requested' } })
    });
    const d = await r.json();
    res.json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Locations (multiple warehouse addresses)
app.get('/api/locations', async (req, res) => {
  const { shop } = req.query;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), name VARCHAR(255),
      address TEXT, city VARCHAR(100), state VARCHAR(100), pincode VARCHAR(20),
      phone VARCHAR(50), is_default BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW()
    )`);
    const r = await pool.query('SELECT * FROM locations WHERE shop_domain=$1 ORDER BY is_default DESC', [shop||'']);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/locations', async (req, res) => {
  const { shop, name, address, city, state, pincode, phone, is_default } = req.body;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY, shop_domain VARCHAR(255), name VARCHAR(255),
      address TEXT, city VARCHAR(100), state VARCHAR(100), pincode VARCHAR(20),
      phone VARCHAR(50), is_default BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW()
    )`);
    if (is_default) await pool.query('UPDATE locations SET is_default=false WHERE shop_domain=$1', [shop]);
    const r = await pool.query('INSERT INTO locations (shop_domain,name,address,city,state,pincode,phone,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [shop,name,address,city,state,pincode,phone,is_default||false]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/locations/:id', async (req, res) => {
  await pool.query('DELETE FROM locations WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, version: '3.0.0', shiprocket: !!SHIPROCKET_EMAIL }));

app.use(express.static(path.join(__dirname, '../client/build')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/build/index.html')));

const PORT = process.env.PORT || 3001;
initDB().then(() => app.listen(PORT, () => console.log('Taskly Returns v3.0 running on port ' + PORT)));
