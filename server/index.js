require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { Pool } = require('pg');

let lastEmailError = '';
let lastExchange = { stage: 'none' };
async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) { lastEmailError = 'RESEND_API_KEY not set'; console.log(lastEmailError); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'GoReturn <noreply@goreturn.pro>',
        to: [to],
        subject,
        html
      })
    });
    const d = await r.json();
    if (!r.ok || d.error) { lastEmailError = d.message || d.error?.message || 'Send failed'; console.log('Email error:', lastEmailError); return false; }
    console.log('Email sent to:', to, 'id:', d.id);
    lastEmailError = '';
    return true;
  } catch(e) { lastEmailError = e.message; console.log('Email error:', e.message); return false; }
}

function returnStatusEmail(customerName, orderId, status, amount, extra) {
  const e = extra || {};
  const firstName = customerName ? customerName.split(' ')[0] : 'Customer';
  const statusMessages = {
    pending: { title: 'Return request received', color: '#D97706', msg: `We've received your return request for order <strong>#${orderId}</strong>. Our team will review it within 24-48 hours and notify you once a decision is made.` },
    approved: { title: 'Return approved', color: '#059669', msg: `Great news! Your return for order <strong>#${orderId}</strong> has been approved.`, extra: '<p style="color:#374151;font-size:13px;margin-top:12px"><strong>What to do next:</strong></p><p style="color:#6B7280;font-size:12px;line-height:1.6">1. Pack the item securely in its original packaging<br>2. Include your order number inside the package<br>3. Ship it back — we\'ll email you once received</p>' },
    inspected: { title: 'Product inspected', color: '#7C3AED', msg: `We've received and inspected your returned product from order <strong>#${orderId}</strong>. Your refund will be processed shortly.` },
    refunded: { title: 'Refund processed', color: '#0284C7', msg: `Your refund of <strong>$${amount || '0'}</strong> for order <strong>#${orderId}</strong> has been processed and sent to your original payment method.`, extra: '<p style="color:#6B7280;font-size:12px;margin-top:8px">Processing times depend on your bank or payment provider. If you don\'t see the refund after 7 business days, please contact your bank first.</p>' },
    rejected: { title: 'Return request declined', color: '#DC2626', msg: `Unfortunately, your return request for order <strong>#${orderId}</strong> could not be approved at this time. Please contact the store for more details.` },
    processed: { title: 'Return completed', color: '#1D4ED8', msg: `Your return for order <strong>#${orderId}</strong> has been fully processed. Thank you for your patience!` }
  };
  const s = statusMessages[status] || statusMessages.pending;
  if (e.customMsg) s.msg = e.customMsg;
  const detailRows = [
    `<p style="margin:4px 0;font-size:13px;color:#6B7280">Order: <strong style="color:#111">#${orderId}</strong></p>`,
    e.product ? `<p style="margin:4px 0;font-size:13px;color:#6B7280">Product: <strong style="color:#111">${e.product}</strong></p>` : '',
    e.reason ? `<p style="margin:4px 0;font-size:13px;color:#6B7280">Reason: <strong style="color:#111">${e.reason}</strong></p>` : '',
    e.refund_method ? `<p style="margin:4px 0;font-size:13px;color:#6B7280">Refund to: <strong style="color:#111">${e.refund_method.replace(/_/g,' ')}</strong></p>` : '',
    amount ? `<p style="margin:4px 0;font-size:13px;color:#6B7280">Amount: <strong style="color:#111">$${amount}</strong></p>` : '',
    `<p style="margin:4px 0;font-size:13px;color:#6B7280">Status: <strong style="color:${s.color}">${s.title}</strong></p>`
  ].filter(Boolean).join('');
  const trackBtn = e.returnId ? `<div style="text-align:center;margin:16px 0"><a href="${APP_URL}/return.html?track=${e.returnId}" style="background:#4F46E5;color:white;text-decoration:none;padding:10px 24px;border-radius:8px;font-weight:600;font-size:13px;display:inline-block">Track your return</a></div>` : '';
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:20px">
    <div style="text-align:center;padding:20px;background:#4F46E5;color:white;border-radius:12px 12px 0 0"><h2 style="margin:0;font-size:18px;font-weight:600;letter-spacing:0.5px">GoReturn</h2></div>
    <div style="padding:28px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px">
      <div style="text-align:center;margin-bottom:20px"><span style="display:inline-block;padding:6px 18px;border-radius:20px;background:${s.color}15;color:${s.color};font-weight:600;font-size:13px">${s.title}</span></div>
      <p style="color:#374151;font-size:14px;margin:0 0 8px">Hi ${firstName},</p>
      <p style="color:#6B7280;font-size:14px;line-height:1.6;margin:0 0 16px">${s.msg}</p>
      <div style="background:#F9FAFB;border-radius:10px;padding:14px;margin:16px 0">${detailRows}</div>
      ${s.extra || ''}
      ${trackBtn}
      <p style="color:#9CA3AF;font-size:11px;margin-top:24px;text-align:center">Need help? Reply to this email or contact the store directly.</p>
      <div style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid #F3F4F6"><span style="color:#9CA3AF;font-size:11px">Powered by</span> <span style="color:#4F46E5;font-size:11px;font-weight:600">GoReturn</span></div>
    </div>
  </div>`;
}

const app = express();
app.use(cors());
// Allow embedding inside Shopify Admin iframe (required for App Bridge)
app.use((req, res, next) => {
  const shop = req.query.shop;
  const allowShop = shop ? `https://${shop}` : 'https://*.myshopify.com';
  res.setHeader('Content-Security-Policy', `frame-ancestors ${allowShop} https://admin.shopify.com;`);
  res.removeHeader('X-Frame-Options');
  next();
});
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
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
    );`);
  // Token rotation columns (idempotent). Force token_expires_at to BIGINT (epoch ms).
  await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS refresh_token TEXT DEFAULT ''`).catch(e=>console.log('alter refresh_token:',e.message));
  await pool.query(`ALTER TABLE shopify_stores DROP COLUMN IF EXISTS token_expires_at`).catch(e=>console.log('drop token_expires_at:',e.message));
  await pool.query(`ALTER TABLE shopify_stores ADD COLUMN token_expires_at BIGINT DEFAULT 0`).catch(e=>console.log('add token_expires_at:',e.message));
  await pool.query(`
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
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shiprocket_auto_pickup BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shiprocket_pickup_location TEXT DEFAULT ''`);
    // ClickPost
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS clickpost_api_key TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS clickpost_connected BOOLEAN DEFAULT false`);
    // Shadowfax
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shadowfax_client_id TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shadowfax_client_secret TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS shadowfax_connected BOOLEAN DEFAULT false`);
    // Delhivery
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS delhivery_api_key TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS delhivery_connected BOOLEAN DEFAULT false`);
    // XpressBees
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS xpressbees_api_token TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS xpressbees_connected BOOLEAN DEFAULT false`);
    // WareIQ
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS wareiq_client_id TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS wareiq_client_secret TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS wareiq_connected BOOLEAN DEFAULT false`);
    // Logistics config
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS default_logistics VARCHAR(50) DEFAULT 'shiprocket'`);
    await pool.query(`ALTER TABLE shopify_stores ADD COLUMN IF NOT EXISTS logistics_auto_pickup BOOLEAN DEFAULT false`);
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
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS line_items TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS refund_status VARCHAR(20) DEFAULT ''`);
    await pool.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS shopify_refund_id VARCHAR(255) DEFAULT ''`);
    await pool.query(`CREATE TABLE IF NOT EXISTS store_settings (
      id SERIAL PRIMARY KEY,
      shop_domain VARCHAR(255) UNIQUE NOT NULL,
      return_reasons TEXT DEFAULT 'Damaged Product,Wrong Item Received,Size/Fit Issue,Quality Not As Expected,Not As Described,Changed My Mind',
      exchange_reasons TEXT DEFAULT 'Wrong Size,Wrong Color,Want Different Product',
      refund_methods TEXT DEFAULT 'Original Payment Method',
      notification_emails TEXT DEFAULT '',
      auto_approve_enabled BOOLEAN DEFAULT false,
      auto_approve_amount NUMERIC(10,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name VARCHAR(255) DEFAULT '',
      role VARCHAR(50) DEFAULT 'admin',
      shop_domain VARCHAR(255) DEFAULT '',
      session_token TEXT DEFAULT '',
      last_login TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS team_members (
      id SERIAL PRIMARY KEY,
      shop_domain VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      password_hash TEXT DEFAULT '',
      role VARCHAR(50) DEFAULT 'viewer',
      status VARCHAR(20) DEFAULT 'invited',
      session_token TEXT DEFAULT '',
      invite_token TEXT DEFAULT '',
      last_login TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(shop_domain, email)
    )`);
  await pool.query(`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS invite_token TEXT DEFAULT ''`).catch(()=>{});
    await pool.query(`CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      user_name VARCHAR(255) DEFAULT '',
      user_email VARCHAR(255) DEFAULT '',
      user_role VARCHAR(50) DEFAULT '',
      action VARCHAR(255) NOT NULL,
      details TEXT DEFAULT '',
      ip_address VARCHAR(50) DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  } catch(e) {}
  console.log('DB ready');
}

async function logActivity(req, action, details) {
  try {
    const userName = req.user?.name || 'System';
    const userEmail = req.user?.email || '';
    const userRole = req.user?.role || '';
    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
    await pool.query('INSERT INTO activity_log (user_name, user_email, user_role, action, details, ip_address) VALUES ($1,$2,$3,$4,$5,$6)',
      [userName, userEmail, userRole, action, details || '', ip]);
  } catch(e) {}
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'goreturn_salt_2026').digest('hex');
}

async function authenticateRequest(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'Login required' });
  const admin = await pool.query('SELECT * FROM admin_users WHERE session_token=$1', [token]);
  if (admin.rows.length > 0) { req.user = admin.rows[0]; return next(); }
  const member = await pool.query('SELECT * FROM team_members WHERE session_token=$1', [token]);
  if (member.rows.length > 0) { req.user = member.rows[0]; return next(); }
  return res.status(401).json({ error: 'Invalid session' });
}

const ALLOWED_ADMIN_EMAIL = 'ajeetkumar.saas@gmail.com';

// Send an alert email to the app owner/admin (install, uninstall, etc.)
async function notifyAdmin(subject, bodyHtml) {
  try {
    await sendEmail(ALLOWED_ADMIN_EMAIL,
      subject,
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <div style="text-align:center;padding:16px;background:#4F46E5;color:white;border-radius:8px 8px 0 0"><h2 style="margin:0;font-size:18px">GoReturn Admin Alert</h2></div>
        <div style="padding:24px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 8px 8px;color:#374151;font-size:14px">${bodyHtml}</div>
      </div>`);
  } catch(e) { console.log('notifyAdmin error:', e.message); }
}

// Admin Registration (locked to owner email only)
app.post('/api/admin/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (email.toLowerCase() !== ALLOWED_ADMIN_EMAIL) return res.status(403).json({ error: 'Admin registration is not available. Contact admin.' });
  try {
    const existing = await pool.query('SELECT id FROM admin_users LIMIT 1');
    if (existing.rows.length > 0) return res.status(403).json({ error: 'Admin already exists. Use login.' });
    const hash = hashPassword(password);
    const token = crypto.randomBytes(32).toString('hex');
    const r = await pool.query(
      'INSERT INTO admin_users (email, password_hash, name, role, session_token, last_login) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id, email, name, role',
      [email, hash, name || '', 'owner', token]
    );
    res.json({ ok: true, user: r.rows[0], token });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// OTP store (in-memory, expires in 5 min)
const otpStore = {};

function generateOTP() { return Math.floor(100000 + Math.random() * 900000).toString(); }

function otpEmailHtml(otp, name) {
  return `<div style="font-family:sans-serif;max-width:440px;margin:0 auto;padding:20px">
    <div style="text-align:center;padding:16px;background:#4F46E5;color:white;border-radius:12px 12px 0 0"><h2 style="margin:0;font-size:20px">GoReturn</h2></div>
    <div style="padding:28px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px;text-align:center">
      <p style="color:#374151;font-size:15px;margin-bottom:4px">Hi ${name || 'there'},</p>
      <p style="color:#6B7280;font-size:14px;margin-bottom:24px">Your login verification code is:</p>
      <div style="background:#F3F4F6;border-radius:12px;padding:20px;margin:0 auto;display:inline-block">
        <span style="font-size:36px;font-weight:800;letter-spacing:8px;color:#4F46E5">${otp}</span>
      </div>
      <p style="color:#9CA3AF;font-size:12px;margin-top:20px">This code expires in 5 minutes. Do not share it.</p>
      <p style="color:#D1D5DB;font-size:11px;margin-top:16px">If you didn't request this, ignore this email.</p>
    </div>
  </div>`;
}

// Admin/Team Login — Step 1: Verify credentials & send OTP
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const hash = hashPassword(password);
  let user = null, userType = '';
  const admin = await pool.query('SELECT * FROM admin_users WHERE email=$1 AND password_hash=$2', [email, hash]);
  if (admin.rows.length > 0) { user = admin.rows[0]; userType = 'admin'; }
  else {
    const member = await pool.query('SELECT * FROM team_members WHERE email=$1 AND password_hash=$2', [email, hash]);
    if (member.rows.length > 0) { user = member.rows[0]; userType = 'member'; }
  }
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const otp = generateOTP();
  otpStore[email] = { otp, userType, userId: user.id, expires: Date.now() + 5 * 60 * 1000 };
  const sent = await sendEmail(email, 'GoReturn Login OTP - ' + otp, otpEmailHtml(otp, user.name));
  if (!sent) return res.status(500).json({ error: 'Email failed: ' + (lastEmailError || 'Unknown error') });
  res.json({ ok: true, otpSent: true, message: 'OTP sent to ' + email });
});

// Admin/Team Login — Step 2: Verify OTP
app.post('/api/admin/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });
  const stored = otpStore[email];
  if (!stored) return res.status(400).json({ error: 'No OTP found. Please login again.' });
  if (Date.now() > stored.expires) { delete otpStore[email]; return res.status(400).json({ error: 'OTP expired. Please login again.' }); }
  if (stored.otp !== otp) return res.status(400).json({ error: 'Invalid OTP. Please try again.' });
  delete otpStore[email];
  const token = crypto.randomBytes(32).toString('hex');
  if (stored.userType === 'admin') {
    await pool.query('UPDATE admin_users SET session_token=$1, last_login=NOW() WHERE id=$2', [token, stored.userId]);
    const u = await pool.query('SELECT id, email, name, role FROM admin_users WHERE id=$1', [stored.userId]);
    req.user = u.rows[0];
    await logActivity(req, 'Login', 'Admin login via OTP');
    return res.json({ ok: true, user: u.rows[0], token });
  } else {
    await pool.query('UPDATE team_members SET session_token=$1, last_login=NOW(), status=$3 WHERE id=$2', [token, stored.userId, 'active']);
    const u = await pool.query('SELECT id, email, name, role, shop_domain FROM team_members WHERE id=$1', [stored.userId]);
    req.user = u.rows[0];
    await logActivity(req, 'Login', 'Team member login via OTP');
    return res.json({ ok: true, user: u.rows[0], token });
  }
});

// Resend OTP
app.post('/api/admin/resend-otp', async (req, res) => {
  const { email } = req.body;
  const stored = otpStore[email];
  if (!stored) return res.status(400).json({ error: 'Please login again first.' });
  const otp = generateOTP();
  stored.otp = otp;
  stored.expires = Date.now() + 5 * 60 * 1000;
  const u = stored.userType === 'admin'
    ? await pool.query('SELECT name FROM admin_users WHERE id=$1', [stored.userId])
    : await pool.query('SELECT name FROM team_members WHERE id=$1', [stored.userId]);
  await sendEmail(email, 'GoReturn Login OTP - ' + otp, otpEmailHtml(otp, u.rows[0]?.name));
  res.json({ ok: true, message: 'New OTP sent to ' + email });
});

// Forgot Password — send reset OTP
app.post('/api/admin/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const admin = await pool.query('SELECT id, name FROM admin_users WHERE email=$1', [email]);
  const member = await pool.query('SELECT id, name FROM team_members WHERE email=$1', [email]);
  if (!admin.rows.length && !member.rows.length) return res.status(404).json({ error: 'No account found with this email' });
  const user = admin.rows[0] || member.rows[0];
  const userType = admin.rows.length ? 'admin' : 'member';
  const otp = generateOTP();
  otpStore['reset_' + email] = { otp, userType, userId: user.id, expires: Date.now() + 5 * 60 * 1000 };
  const sent = await sendEmail(email, 'GoReturn Password Reset OTP - ' + otp, otpEmailHtml(otp, user.name));
  if (!sent) return res.status(500).json({ error: 'Email failed: ' + (lastEmailError || 'Unknown error') });
  res.json({ ok: true, message: 'Reset OTP sent to ' + email });
});

// Reset Password — verify OTP and set new password
app.post('/api/admin/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;
  if (!email || !otp || !newPassword) return res.status(400).json({ error: 'All fields required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const stored = otpStore['reset_' + email];
  if (!stored) return res.status(400).json({ error: 'No reset OTP found. Please try again.' });
  if (Date.now() > stored.expires) { delete otpStore['reset_' + email]; return res.status(400).json({ error: 'OTP expired. Please request a new one.' }); }
  if (stored.otp !== otp) return res.status(400).json({ error: 'Invalid OTP' });
  delete otpStore['reset_' + email];
  const hash = hashPassword(newPassword);
  if (stored.userType === 'admin') {
    await pool.query('UPDATE admin_users SET password_hash=$1 WHERE id=$2', [hash, stored.userId]);
  } else {
    await pool.query('UPDATE team_members SET password_hash=$1 WHERE id=$2', [hash, stored.userId]);
  }
  res.json({ ok: true, message: 'Password reset successful' });
});

// Check session
app.get('/api/admin/session', async (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!token) return res.json({ loggedIn: false });
  const admin = await pool.query('SELECT id, email, name, role FROM admin_users WHERE session_token=$1', [token]);
  if (admin.rows.length > 0) return res.json({ loggedIn: true, user: admin.rows[0] });
  const member = await pool.query('SELECT id, email, name, role, shop_domain FROM team_members WHERE session_token=$1', [token]);
  if (member.rows.length > 0) return res.json({ loggedIn: true, user: member.rows[0] });
  res.json({ loggedIn: false });
});

// Logout
app.post('/api/admin/logout', async (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) {
    await pool.query('UPDATE admin_users SET session_token=$1 WHERE session_token=$2', ['', token]);
    await pool.query('UPDATE team_members SET session_token=$1 WHERE session_token=$2', ['', token]);
  }
  res.json({ ok: true });
});

// Team Members CRUD
app.get('/api/team', authenticateRequest, async (req, res) => {
  const members = await pool.query('SELECT id, name, email, role, status, last_login, created_at FROM team_members ORDER BY created_at DESC');
  res.json(members.rows);
});

app.post('/api/team', authenticateRequest, async (req, res) => {
  if (req.user.role !== 'owner' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can add team members' });
  const { name, email, role, shop_domain } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  try {
    const inviteToken = crypto.randomBytes(24).toString('hex');
    const r = await pool.query(
      'INSERT INTO team_members (shop_domain, name, email, password_hash, role, status, invite_token) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, email, role, status',
      [shop_domain || '', name, email, '', role || 'viewer', 'invited', inviteToken]
    );
    const inviteLink = `${APP_URL}/set-password.html?token=${inviteToken}`;
    const roleDesc = { owner: 'Full access to all settings and billing', admin: 'Manage returns, settings, and team members', viewer: 'View returns, analytics, and customer data' };
    const emailed = await sendEmail(email, `You're invited to join ${shop_domain ? shop_domain.replace('.myshopify.com','') : 'a store'} on GoReturn`,
      `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:20px">
        <div style="text-align:center;padding:20px;background:#4F46E5;color:white;border-radius:12px 12px 0 0"><h2 style="margin:0;font-size:18px;font-weight:600;letter-spacing:0.5px">GoReturn</h2></div>
        <div style="padding:28px;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 12px 12px">
          <p style="color:#374151;font-size:14px;margin:0 0 8px">Hi ${name},</p>
          <p style="color:#6B7280;font-size:14px;line-height:1.6;margin:0 0 16px">You've been invited to join <strong>${shop_domain ? shop_domain.replace('.myshopify.com','') : 'a store'}</strong> on GoReturn as a <strong>${(role||'viewer').charAt(0).toUpperCase()+(role||'viewer').slice(1)}</strong>.</p>
          <div style="background:#F9FAFB;border-radius:10px;padding:14px;margin:16px 0">
            <p style="margin:4px 0;font-size:13px;color:#6B7280">Role: <strong style="color:#111">${(role||'viewer').charAt(0).toUpperCase()+(role||'viewer').slice(1)}</strong></p>
            <p style="margin:4px 0;font-size:12px;color:#9CA3AF">${roleDesc[role]||roleDesc.viewer}</p>
          </div>
          <div style="text-align:center;margin:24px 0"><a href="${inviteLink}" style="background:#4F46E5;color:white;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;display:inline-block">Accept invite & set password</a></div>
          <p style="color:#9CA3AF;font-size:11px;margin-top:16px;text-align:center">This invite expires in 7 days. If you didn't expect this, you can safely ignore it.</p>
          <div style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid #F3F4F6"><span style="color:#9CA3AF;font-size:11px">Powered by</span> <span style="color:#4F46E5;font-size:11px;font-weight:600">GoReturn</span></div>
        </div>
      </div>`);
    await logActivity(req, 'Team Member Invited', `${name} (${email}) as ${role}`);
    res.json({ ...r.rows[0], emailed, invite_link: inviteLink });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Member with this email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// Validate invite token (for set-password page)
app.get('/api/team/invite/:token', async (req, res) => {
  const r = await pool.query('SELECT name, email, role FROM team_members WHERE invite_token=$1 AND invite_token != $2', [req.params.token, '']);
  if (!r.rows.length) return res.status(404).json({ error: 'Invalid or expired invite link' });
  res.json(r.rows[0]);
});

// Invited member sets their own password
app.post('/api/team/set-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'token and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const r = await pool.query('SELECT id, email FROM team_members WHERE invite_token=$1 AND invite_token != $2', [token, '']);
  if (!r.rows.length) return res.status(404).json({ error: 'Invalid or expired invite link' });
  await pool.query('UPDATE team_members SET password_hash=$1, status=$2, invite_token=$3 WHERE id=$4',
    [hashPassword(password), 'active', '', r.rows[0].id]);
  res.json({ ok: true, email: r.rows[0].email });
});

app.patch('/api/team/:id', authenticateRequest, async (req, res) => {
  if (req.user.role !== 'owner' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can edit members' });
  const { name, role, password } = req.body;
  if (name) await pool.query('UPDATE team_members SET name=$1 WHERE id=$2', [name, req.params.id]);
  if (role) await pool.query('UPDATE team_members SET role=$1 WHERE id=$2', [role, req.params.id]);
  if (password) await pool.query('UPDATE team_members SET password_hash=$1 WHERE id=$2', [hashPassword(password), req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/team/:id', authenticateRequest, async (req, res) => {
  if (req.user.role !== 'owner' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can remove members' });
  const m = await pool.query('SELECT name, email FROM team_members WHERE id=$1', [req.params.id]);
  await pool.query('DELETE FROM team_members WHERE id=$1', [req.params.id]);
  await logActivity(req, 'Team Member Removed', `${m.rows[0]?.name} (${m.rows[0]?.email})`);
  res.json({ ok: true });
});

// Refresh an expiring offline token using the stored refresh_token
async function refreshAccessToken(shop, refreshToken) {
  const params = new URLSearchParams({
    client_id: SHOPIFY_CLIENT_ID,
    client_secret: SHOPIFY_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: params.toString()
  });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch(e) { console.log('Refresh parse fail:', r.status, text.substring(0,150)); return null; }
  if (d.access_token) {
    const expiresAt = Date.now() + ((d.expires_in || 3600) * 1000);
    await pool.query(
      'UPDATE shopify_stores SET access_token=$1, refresh_token=$2, token_expires_at=$3 WHERE shop_domain=$4',
      [d.access_token, d.refresh_token || refreshToken, expiresAt, shop]
    );
    console.log('Token refreshed:', { shop, expires_in: d.expires_in });
    return d.access_token;
  }
  console.log('Refresh failed:', d);
  return null;
}

// Auto-fix: when API returns 401, try refreshing the token
async function attemptReauth(shop) {
  const sr = await pool.query('SELECT access_token, refresh_token, token_expires_at FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return null;
  const row = sr.rows[0];
  if (row.refresh_token) {
    console.log(`attemptReauth: trying refresh for ${shop}`);
    const fresh = await refreshAccessToken(shop, row.refresh_token);
    if (fresh) return fresh;
  }
  console.log(`attemptReauth: no refresh token for ${shop}, needs App Bridge re-auth`);
  return null;
}

// Drop-in replacement for the old DB query - returns refreshed token in same shape
async function getStoreToken(shop) {
  const tok = await getValidToken(shop);
  return { rows: tok ? [{ access_token: tok }] : [] };
}

// Returns a valid (non-expired) access token, refreshing if needed
async function getValidToken(shop) {
  const sr = await pool.query('SELECT access_token, refresh_token, token_expires_at FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return null;
  const row = sr.rows[0];
  if (!row.access_token) return null;
  const expiresAt = Number(row.token_expires_at || 0);
  // If token has expiry info and is within 2 min of expiry, refresh it
  if (row.refresh_token && expiresAt > 0 && Date.now() > (expiresAt - 120000)) {
    const fresh = await refreshAccessToken(shop, row.refresh_token);
    if (fresh) return fresh;
  }
  // If token has expiry info and is already expired but no refresh token, it's dead
  if (expiresAt > 0 && Date.now() > expiresAt && !row.refresh_token) {
    console.log(`Store ${shop} token expired with no refresh token`);
    return null;
  }
  return row.access_token;
}

// Token exchange - convert App Bridge session token to EXPIRING offline access token
app.post('/api/auth/token-exchange', async (req, res) => {
  const { shop, sessionToken } = req.body;
  lastExchange = { at: new Date().toISOString(), shop, token_len: sessionToken?.length || 0, stage: 'received' };
  if (!shop || !sessionToken) { lastExchange.stage = 'missing-params'; return res.status(400).json({ error: 'shop and sessionToken required' }); }
  try {
    console.log('Token exchange attempt:', { shop, token_len: sessionToken?.length });
    const params = new URLSearchParams({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1'
    });
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: params.toString()
    });
    const text = await r.text();
    console.log('Token exchange response:', r.status, text.substring(0, 250));
    lastExchange.shopify_status = r.status; lastExchange.shopify_resp = text.substring(0, 250); lastExchange.stage = 'shopify-responded';
    let d;
    try { d = JSON.parse(text); } catch(e) { lastExchange.stage = 'parse-fail'; return res.status(400).json({ error: 'Invalid response from Shopify', status: r.status, body: text.substring(0, 200) }); }
    if (d.access_token) {
      const expiresAt = d.expires_in ? Date.now() + (d.expires_in * 1000) : 0;
      lastExchange.stage = 'success'; lastExchange.token_prefix = d.access_token.substring(0,10); lastExchange.expires_in = d.expires_in; lastExchange.has_refresh = !!d.refresh_token;
      console.log('Token exchange SUCCESS:', { shop, token_prefix: d.access_token.substring(0,10), expires_in: d.expires_in, has_refresh: !!d.refresh_token });
      let storeName = shop, storeEmail = '';
      try {
        const shopInfo = await fetch(`https://${shop}/admin/api/2025-04/shop.json`, { headers: { 'X-Shopify-Access-Token': d.access_token } });
        const shopData = await shopInfo.json();
        storeName = shopData.shop?.name || shop;
        storeEmail = shopData.shop?.email || '';
      } catch(e) {}
      // Detect NEW install (store not already in DB) for install alert email
      let isNewInstall = false;
      try { const ex = await pool.query('SELECT 1 FROM shopify_stores WHERE shop_domain=$1', [shop]); isNewInstall = ex.rows.length === 0; } catch(e) {}
      try {
        await pool.query(
          'INSERT INTO shopify_stores (shop_domain, access_token, refresh_token, token_expires_at, store_name, store_email) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (shop_domain) DO UPDATE SET access_token=$2, refresh_token=$3, token_expires_at=$4, store_name=$5, store_email=$6',
          [shop, d.access_token, d.refresh_token || '', expiresAt, storeName, storeEmail]
        );
        lastExchange.db = 'saved';
        if (isNewInstall) {
          notifyAdmin('🎉 New GoReturn Install', `<p><strong>${storeName}</strong> (${shop}) just installed GoReturn.</p><p>Store email: ${storeEmail || 'N/A'}</p><p>Time: ${new Date().toUTCString()}</p>`);
        }
      } catch(dbErr) {
        lastExchange.db = 'FAILED: ' + dbErr.message;
        try { await pool.query('UPDATE shopify_stores SET access_token=$1 WHERE shop_domain=$2', [d.access_token, shop]); lastExchange.db += ' | fallback-saved'; } catch(e2) { lastExchange.db += ' | fallback-failed:'+e2.message; }
      }
      res.json({ ok: true, shop: storeName, expires_in: d.expires_in, expiring: !!d.refresh_token });
    } else {
      console.log('Token exchange no token:', d);
      res.status(400).json({ error: 'No access_token in response', details: d });
    }
  } catch(e) { console.log('Token exchange error:', e.message); res.status(500).json({ error: e.message }); }
});

// OAuth (legacy fallback)
app.get('/api/auth/shopify', (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const nonce = crypto.randomBytes(16).toString('hex');
  const redirectUri = encodeURIComponent(`${APP_URL}/api/auth/callback`);
  const scopes = 'read_orders,write_orders,read_customers,read_products,read_inventory';
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${redirectUri}&state=${nonce}`);
});

app.get('/api/auth/callback', async (req, res) => {
  const { shop, code, hmac, ...rest } = req.query;
  if (!shop || !code) return res.status(400).send('Missing params');
  if (hmac && SHOPIFY_CLIENT_SECRET) {
    const params = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&') + (Object.keys(rest).length ? '&' : '') + `code=${code}&shop=${shop}&state=${req.query.state || ''}&timestamp=${req.query.timestamp || ''}`;
    const sortedParams = Object.entries(req.query).filter(([k]) => k !== 'hmac').sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('&');
    const digest = crypto.createHmac('sha256', SHOPIFY_CLIENT_SECRET).update(sortedParams).digest('hex');
    if (digest !== hmac) return res.status(403).send('HMAC verification failed');
  }
  try {
    // Request an EXPIRING token via authorization code grant (expiring=1)
    const tokenParams = new URLSearchParams({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code, expiring: '1' });
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: tokenParams.toString()
    });
    const tokenData = await r.json();
    let access_token = tokenData.access_token;
    const expiresAt = tokenData.expires_in ? Date.now() + (tokenData.expires_in * 1000) : 0;
    console.log('OAuth token received:', { shop, token_type: access_token?.substring(0,5), expires_in: tokenData.expires_in, has_refresh: !!tokenData.refresh_token });

    let storeName = shop, storeEmail = '';
    try {
      const shopInfo = await fetch(`https://${shop}/admin/api/2025-04/shop.json`, {
        headers: { 'X-Shopify-Access-Token': access_token }
      });
      const shopData = await shopInfo.json();
      storeName = shopData.shop?.name || shop;
      storeEmail = shopData.shop?.email || '';
    } catch(e) {}
    try {
      await pool.query(
        'INSERT INTO shopify_stores (shop_domain, access_token, refresh_token, token_expires_at, store_name, store_email) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (shop_domain) DO UPDATE SET access_token=$2, refresh_token=$3, token_expires_at=$4, store_name=$5, store_email=$6',
        [shop, access_token, tokenData.refresh_token || '', expiresAt, storeName, storeEmail]
      );
    } catch(e) {
      await pool.query('UPDATE shopify_stores SET access_token=$1 WHERE shop_domain=$2', [access_token, shop]).catch(()=>{});
    }

    const plan = req.query.plan || 'starter';
    if (plan === 'free_trial' || plan === 'free') {
      res.redirect(`/?shop=${shop}`);
    } else {
      res.redirect(`/api/billing/create?shop=${shop}&plan=${plan}`);
    }
  } catch(e) { res.status(500).send('OAuth error: ' + e.message); }
});

// Billing
const PLANS = {
  free: { name: 'Free', price: 0, returns: 5, trial_days: 0 },
  starter: { name: 'Starter', price: 11.99, returns: 50, trial_days: 15 },
  growth: { name: 'Growth', price: 23.99, returns: 150, trial_days: 15 },
  pro: { name: 'Pro', price: 47.99, returns: 500, trial_days: 15 }
};

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
  const sr = await getStoreToken(shop);
  if (!sr.rows.length) return res.redirect('/');
  try {
    const r = await fetch(`https://${shop}/admin/api/2025-04/recurring_application_charges/${charge_id}.json`, {
      headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
    });
    const data = await r.json();
    const charge = data.recurring_application_charge;
    if (charge && charge.status === 'accepted') {
      await fetch(`https://${shop}/admin/api/2025-04/recurring_application_charges/${charge_id}/activate.json`, {
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
  const { shop } = req.query;
  // Embedded mode passes ?shop= — return ONLY that store so a seller can never see others
  if (shop) {
    const r = await pool.query('SELECT shop_domain, store_name, store_email, plan, created_at FROM shopify_stores WHERE shop_domain=$1', [shop]);
    return res.json(r.rows);
  }
  const r = await pool.query('SELECT shop_domain, store_name, store_email, plan, created_at FROM shopify_stores ORDER BY created_at DESC');
  res.json(r.rows);
});

// Orders from Shopify
app.get('/api/shopify/orders', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  const sr = await getStoreToken(shop);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected. Open GoReturn in Shopify Admin first.' });
  try {
    const r = await fetch(`https://${shop}/admin/api/2025-04/orders.json?status=any&limit=50`, {
      headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
    });
    if (r.status === 401 || r.status === 403) {
      const reauth = await attemptReauth(shop);
      if (reauth) {
        const retry = await fetch(`https://${shop}/admin/api/2025-04/orders.json?status=any&limit=50`, {
          headers: { 'X-Shopify-Access-Token': reauth }
        });
        if (retry.ok) { const rd = await retry.json(); return res.json(rd.orders || []); }
      }
      return res.status(503).json({ error: 'Store connection expired. Open GoReturn in Shopify Admin to reconnect.' });
    }
    const d = await r.json();
    res.json(d.orders || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Single order lookup (for customer return portal)
app.get('/api/shopify/order-lookup', async (req, res) => {
  const { shop, order_number, email } = req.query;
  if (!shop || !order_number) return res.status(400).json({ error: 'shop and order_number required' });
  const sr = await getStoreToken(shop);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected. The store owner needs to open GoReturn app in Shopify Admin first.' });
  try {
    const r = await fetch(`https://${shop}/admin/api/2025-04/orders.json?name=${encodeURIComponent(order_number)}&status=any`, {
      headers: { 'X-Shopify-Access-Token': sr.rows[0].access_token }
    });
    if (r.status === 401 || r.status === 403) {
      // Token invalid — try to fix it automatically via token re-fetch from OAuth
      const reauth = await attemptReauth(shop);
      if (reauth) {
        // Retry the request with new token
        const retry = await fetch(`https://${shop}/admin/api/2025-04/orders.json?name=${encodeURIComponent(order_number)}&status=any`, {
          headers: { 'X-Shopify-Access-Token': reauth }
        });
        if (retry.ok) {
          const retryData = await retry.json();
          const retryOrders = retryData.orders || [];
          if (!retryOrders.length) return res.status(404).json({ error: 'Order not found' });
          const order = retryOrders[0];
          if (email && order.email && order.email.toLowerCase() !== email.toLowerCase()) {
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

// Process a real Shopify refund for a return (Shopify App Store rule 1.1.15: refunds must go through
// the original payment processor via Shopify's refund APIs — never a manual/bank/UPI/store-credit ledger).
async function processShopifyRefund(shop, ret) {
  const sr = await getStoreToken(shop);
  if (!sr.rows.length) throw new Error('Store not connected');
  const access_token = sr.rows[0].access_token;

  let lineItems = [];
  try { lineItems = JSON.parse(ret.line_items || '[]'); } catch(e) {}
  if (!lineItems.length) throw new Error('No order line items linked to this return — cannot process a Shopify refund automatically.');

  const refund_line_items = lineItems.map(li => ({ line_item_id: li.id, quantity: li.quantity || 1, restock_type: 'no_restock' }));

  const calcResp = await fetch(`https://${shop}/admin/api/2025-04/orders/${ret.order_id}/refunds/calculate.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': access_token },
    body: JSON.stringify({ refund: { currency: 'INR', refund_line_items, shipping: { full_refund: false } } })
  });
  const calcData = await calcResp.json();
  if (!calcData.refund) throw new Error(calcData.errors ? JSON.stringify(calcData.errors) : 'Shopify could not calculate this refund');

  const refundResp = await fetch(`https://${shop}/admin/api/2025-04/orders/${ret.order_id}/refunds.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': access_token },
    body: JSON.stringify({
      refund: {
        note: `Refund via GoReturn — Return #${ret.id}`,
        notify: true,
        refund_line_items,
        transactions: calcData.refund.transactions || [],
        shipping: calcData.refund.shipping || { full_refund: false }
      }
    })
  });
  const refundData = await refundResp.json();
  if (!refundData.refund) throw new Error(refundData.errors ? JSON.stringify(refundData.errors) : 'Shopify refund creation failed');
  return refundData.refund;
}

// Trigger the actual Shopify refund for a return — only marks it 'refunded' once Shopify confirms it
app.post('/api/returns/:id/refund', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM returns WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Return not found' });
    const ret = r.rows[0];
    if (!ret.shop_domain) return res.status(400).json({ error: 'No store linked to this return' });

    const refund = await processShopifyRefund(ret.shop_domain, ret);

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
    res.status(400).json({ error: e.message });
  }
});

// Returns CRUD with date filters
app.get('/api/returns', async (req, res) => {
  const { shop, status, type, date_from, date_to, archived } = req.query;
  let query = 'SELECT * FROM returns';
  const params = [];
  const conditions = [];
  let idx = 1;
  if (shop && shop !== 'all') { conditions.push(`shop_domain=$${idx++}`); params.push(shop); }
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
  const sr = await getStoreToken(shop);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
  try {
    const r = await fetch(`https://${shop}/admin/api/2025-04/orders.json?status=any&limit=250`, {
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
  const sr = await getStoreToken(shop);
  if (!sr.rows.length) return res.json({ by_product: [], by_city: [] });
  try {
    const ordersResp = await fetch(`https://${shop}/admin/api/2025-04/orders.json?status=any&limit=250`, {
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
      return_reasons: (ss.return_reasons && ss.return_reasons.includes(',')) ? ss.return_reasons : 'Damaged Product,Wrong Item Received,Size/Fit Issue,Quality Not As Expected,Not As Described,Changed My Mind',
      exchange_reasons: (ss.exchange_reasons && ss.exchange_reasons.includes(',')) ? ss.exchange_reasons : 'Wrong Size,Wrong Color,Want Different Product',
      exchange_enabled: ss.exchange_enabled !== false,
      refund_methods: 'Original Payment Method'
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

// ---- Email Templates (per-store customization) ----
const DEFAULT_EMAIL_TEMPLATES = {
  pending:  { subject: 'Return Request Received - #{order}', message: "We've received your return request for order #{order}. Our team will review it within 24-48 hours and notify you once a decision is made." },
  approved: { subject: 'Return Approved - #{order}', message: 'Great news! Your return for order #{order} has been approved.' },
  inspected:{ subject: 'Product Inspected - #{order}', message: "We've received and inspected your returned product from order #{order}. Your refund will be processed shortly." },
  refunded: { subject: 'Refund Processed - #{order}', message: 'Your refund of ${amount} for order #{order} has been processed and sent to your original payment method.' },
  rejected: { subject: 'Return Request Declined - #{order}', message: 'Unfortunately, your return request for order #{order} could not be approved at this time. Please contact us for more details.' }
};
async function getEmailTemplates(shop) {
  try {
    await pool.query('ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS email_templates TEXT');
    const r = await pool.query('SELECT email_templates FROM store_settings WHERE shop_domain=$1', [shop]);
    const raw = r.rows[0]?.email_templates;
    if (!raw) return DEFAULT_EMAIL_TEMPLATES;
    const custom = JSON.parse(raw);
    const merged = {};
    for (const k of Object.keys(DEFAULT_EMAIL_TEMPLATES)) merged[k] = { ...DEFAULT_EMAIL_TEMPLATES[k], ...(custom[k]||{}) };
    return merged;
  } catch(e) { return DEFAULT_EMAIL_TEMPLATES; }
}
function fillPlaceholders(str, data) {
  return (str||'').replace(/\{order\}/g, data.order||'').replace(/\{name\}/g, data.name||'').replace(/\{amount\}/g, data.amount||'0').replace(/\{product\}/g, data.product||'');
}
app.get('/api/email-templates', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.json({ templates: DEFAULT_EMAIL_TEMPLATES, defaults: DEFAULT_EMAIL_TEMPLATES });
  const templates = await getEmailTemplates(shop);
  res.json({ templates, defaults: DEFAULT_EMAIL_TEMPLATES });
});
app.post('/api/email-templates', async (req, res) => {
  const { shop, templates } = req.body;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  try {
    await pool.query('ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS email_templates TEXT');
    await pool.query(
      `INSERT INTO store_settings (shop_domain, email_templates) VALUES ($1,$2)
       ON CONFLICT (shop_domain) DO UPDATE SET email_templates=$2`,
      [shop, JSON.stringify(templates||{})]);
    logActivity(req, 'Email Templates Updated', `Store ${shop}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create return/exchange
app.post('/api/returns', async (req, res) => {
  const { order_id, order_number, customer_name, customer_email, customer_phone, product_name, product_sku, quantity, reason, reason_detail, refund_method, amount, shop_domain, type, exchange_product, exchange_variant, images, line_items } = req.body;
  const r = await pool.query(
    `INSERT INTO returns (order_id,order_number,customer_name,customer_email,customer_phone,product_name,product_sku,quantity,reason,reason_detail,refund_method,amount,shop_domain,type,exchange_product,exchange_variant,images,line_items)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [order_id||'',order_number||'',customer_name||'',customer_email||'',customer_phone||'',product_name||'',product_sku||'',quantity||1,reason||'',reason_detail||'',refund_method||'original',amount||0,shop_domain||'',type||'return',exchange_product||'',exchange_variant||'',images||'',line_items||'']
  );
  if (customer_email) {
    const tpl = await getEmailTemplates(shop_domain);
    const ph = { order: order_number||order_id, name: customer_name, amount, product: product_name };
    const subj = fillPlaceholders(tpl.pending.subject, ph);
    const msg = fillPlaceholders(tpl.pending.message, ph);
    sendEmail(customer_email, subj, returnStatusEmail(customer_name||'Customer', order_number||order_id, 'pending', amount, { product: product_name, reason, refund_method, returnId: r.rows[0].id, customMsg: msg }));
  }
  res.json(r.rows[0]);
});

app.patch('/api/returns/:id', async (req, res) => {
  const { status, merchant_notes, tracking_number, pickup_status, archived, risk_level } = req.body;
  // Refunds must go through Shopify's refund API (POST /api/returns/:id/refund), never a bare status flip
  if (status === 'refunded') return res.status(400).json({ error: 'Use POST /api/returns/:id/refund to process refunds through Shopify' });
  const fields = [];
  const values = [];
  let idx = 1;
  if (status) {
    fields.push(`status=$${idx++}`); values.push(status);
    if (status === 'inspected') fields.push('inspected_at=NOW()');
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
  if (status && ret.customer_email) {
    const tpl = await getEmailTemplates(ret.shop_domain);
    const t = tpl[status];
    const ph = { order: ret.order_number||ret.order_id, name: ret.customer_name, amount: ret.amount, product: ret.product_name };
    const subj = t ? fillPlaceholders(t.subject, ph) : `Return ${status.toUpperCase()} - #${ret.order_number||ret.order_id}`;
    const msg = t ? fillPlaceholders(t.message, ph) : null;
    sendEmail(ret.customer_email, subj, returnStatusEmail(ret.customer_name||'Customer', ret.order_number||ret.order_id, status, ret.amount, { product: ret.product_name, reason: ret.reason, refund_method: ret.refund_method, returnId: ret.id, customMsg: msg }));
  }
  if (status) logActivity(req, 'Return Status Changed', `#${req.params.id} → ${status} (${ret.customer_name}, ${ret.order_id})`);
  if (archived) logActivity(req, 'Return Archived', `#${req.params.id} (${ret.customer_name})`);
  // Auto-pickup: if approved & store has Shiprocket auto-pickup enabled
  if (status === 'approved' && ret.type !== 'exchange' && ret.pickup_status !== 'pickup_scheduled') {
    try {
      const st = await pool.query('SELECT shiprocket_connected, shiprocket_auto_pickup FROM shopify_stores WHERE shop_domain=$1', [ret.shop_domain]);
      if (st.rows[0]?.shiprocket_connected && st.rows[0]?.shiprocket_auto_pickup) {
        createShiprocketPickup(ret.shop_domain, ret).catch(e => console.log('Auto-pickup failed:', e.message));
      }
    } catch(e) {}
  }
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
  const r = await pool.query('SELECT shiprocket_connected, shiprocket_email, shiprocket_auto_pickup, shiprocket_pickup_location FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!r.rows.length) return res.json({ connected: false });
  res.json({ connected: r.rows[0].shiprocket_connected, email: r.rows[0].shiprocket_email, auto_pickup: r.rows[0].shiprocket_auto_pickup, pickup_location: r.rows[0].shiprocket_pickup_location });
});

// Fetch the seller's Shiprocket pickup locations (return destinations)
app.get('/api/shiprocket/pickup-locations', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  try {
    const d = await sellerShiprocketAPI(shop, '/settings/company/pickup', 'GET');
    const locations = (d?.data?.shipping_address || []).map(l => ({
      id: l.pickup_location, name: l.pickup_location, address: l.address, city: l.city, state: l.state, pincode: l.pin_code
    }));
    res.json({ locations });
  } catch(e) { res.json({ locations: [], error: e.message }); }
});

// Save Shiprocket automation settings
app.post('/api/shiprocket/settings', async (req, res) => {
  const { shop, auto_pickup, pickup_location } = req.body;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  await pool.query('UPDATE shopify_stores SET shiprocket_auto_pickup=$1, shiprocket_pickup_location=$2 WHERE shop_domain=$3',
    [auto_pickup === true, pickup_location || '', shop]);
  logActivity(req, 'Shiprocket Settings Updated', `auto_pickup=${auto_pickup}, location=${pickup_location||'-'}`);
  res.json({ ok: true });
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

// Reusable: create Shiprocket return pickup + AWB + schedule, update DB
async function createShiprocketPickup(shop, d) {
  const return_id = d.id || d.return_id;
  // Get seller's registered pickup location (return destination/warehouse)
  const stRow = await pool.query('SELECT shiprocket_pickup_location FROM shopify_stores WHERE shop_domain=$1', [shop]);
  let dest = { name: 'Primary', address: 'Warehouse', city: 'City', state: 'State', pincode: '110001', phone: '0000000000', email: '' };
  try {
    const locResp = await sellerShiprocketAPI(shop, '/settings/company/pickup', 'GET');
    const locs = locResp?.data?.shipping_address || [];
    const chosen = locs.find(l => l.pickup_location === stRow.rows[0]?.shiprocket_pickup_location) || locs[0];
    if (chosen) dest = { name: chosen.pickup_location, address: chosen.address, city: chosen.city, state: chosen.state, pincode: chosen.pin_code, phone: chosen.phone, email: chosen.email };
  } catch(e) {}
  const orderData = await sellerShiprocketAPI(shop, '/orders/create/return', 'POST', {
    order_id: `RETURN-${return_id}`,
    order_date: new Date().toISOString().split('T')[0],
    channel_id: '',
    pickup_customer_name: d.customer_name,
    pickup_address: d.customer_address || 'Customer Address',
    pickup_city: d.customer_city || 'City',
    pickup_state: d.customer_state || 'State',
    pickup_country: 'India',
    pickup_pincode: d.customer_pincode || '110001',
    pickup_email: d.customer_email || '',
    pickup_phone: d.customer_phone || '',
    shipping_customer_name: dest.name,
    shipping_address: dest.address,
    shipping_city: dest.city,
    shipping_state: dest.state,
    shipping_country: 'India',
    shipping_pincode: dest.pincode,
    shipping_email: dest.email || d.customer_email || '',
    shipping_phone: dest.phone || '0000000000',
    order_items: [{ name: d.product_name || 'Return Item', sku: d.product_sku || 'SKU', units: d.quantity || 1, selling_price: d.amount || 0 }],
    payment_method: 'prepaid',
    sub_total: d.amount || 0,
    length: 10, breadth: 10, height: 10, weight: 0.5
  });
  let awb = '', awbData = null;
  if (orderData.shipment_id) {
    try {
      awbData = await sellerShiprocketAPI(shop, '/courier/assign/awb', 'POST', { shipment_id: orderData.shipment_id });
      awb = awbData?.response?.data?.awb_code || '';
      await sellerShiprocketAPI(shop, '/courier/generate/pickup', 'POST', { shipment_id: [orderData.shipment_id] });
    } catch(e) {}
  }
  if (orderData.order_id) {
    await pool.query('UPDATE returns SET pickup_status=$1, tracking_number=$2, updated_at=NOW() WHERE id=$3',
      ['pickup_scheduled', awb || orderData.shipment_id || '', return_id]);
  }
  return { ...orderData, awb_code: awb, awb: awbData };
}

// Shiprocket APIs (per seller)
app.post('/api/shiprocket/pickup', async (req, res) => {
  const { return_id, shop } = req.body;
  if (!return_id || !shop) return res.status(400).json({ error: 'return_id and shop required' });
  try {
    const result = await createShiprocketPickup(shop, { ...req.body, id: return_id });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/shiprocket/track/:shipment_id', async (req, res) => {
  const { shop } = req.query;
  try {
    const data = shop ? await sellerShiprocketAPI(shop, `/courier/track/shipment/${req.params.shipment_id}`, 'GET') : await shiprocketAPI(`/courier/track/shipment/${req.params.shipment_id}`, 'GET');
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ========== MULTI-LOGISTICS ENDPOINTS ==========
const LogisticsProviders = require('./logistics-providers.js');

// Get all connected logistics providers for a store
app.get('/api/logistics/status', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  try {
    const r = await pool.query(
      `SELECT
        shiprocket_connected, clickpost_connected, shadowfax_connected,
        delhivery_connected, xpressbees_connected, wareiq_connected,
        default_logistics, logistics_auto_pickup
      FROM shopify_stores WHERE shop_domain=$1`,
      [shop]
    );
    const store = r.rows[0] || {};
    res.json({
      providers: {
        shiprocket: store.shiprocket_connected || false,
        clickpost: store.clickpost_connected || false,
        shadowfax: store.shadowfax_connected || false,
        delhivery: store.delhivery_connected || false,
        xpressbees: store.xpressbees_connected || false,
        wareiq: store.wareiq_connected || false
      },
      default: store.default_logistics || 'shiprocket',
      auto_pickup: store.logistics_auto_pickup || false
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---- ClickPost ----
app.post('/api/logistics/clickpost/connect', async (req, res) => {
  const { shop, api_key } = req.body;
  if (!shop || !api_key) return res.status(400).json({ error: 'shop and api_key required' });
  try {
    const cp = new LogisticsProviders.ClickPost(api_key);
    await pool.query(
      'UPDATE shopify_stores SET clickpost_api_key=$1, clickpost_connected=true WHERE shop_domain=$2',
      [api_key, shop]
    );
    logActivity(req, 'ClickPost Connected', shop);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logistics/clickpost/disconnect', async (req, res) => {
  const { shop } = req.body;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  await pool.query('UPDATE shopify_stores SET clickpost_api_key=\'\', clickpost_connected=false WHERE shop_domain=$1', [shop]);
  logActivity(req, 'ClickPost Disconnected', shop);
  res.json({ ok: true });
});

// ---- Shadowfax ----
app.post('/api/logistics/shadowfax/connect', async (req, res) => {
  const { shop, client_id, client_secret } = req.body;
  if (!shop || !client_id || !client_secret) return res.status(400).json({ error: 'shop, client_id, client_secret required' });
  try {
    const sf = new LogisticsProviders.Shadowfax(client_id, client_secret);
    await sf.getToken();
    await pool.query(
      'UPDATE shopify_stores SET shadowfax_client_id=$1, shadowfax_client_secret=$2, shadowfax_connected=true WHERE shop_domain=$3',
      [client_id, client_secret, shop]
    );
    logActivity(req, 'Shadowfax Connected', shop);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logistics/shadowfax/disconnect', async (req, res) => {
  const { shop } = req.body;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  await pool.query('UPDATE shopify_stores SET shadowfax_client_id=\'\', shadowfax_client_secret=\'\', shadowfax_connected=false WHERE shop_domain=$1', [shop]);
  logActivity(req, 'Shadowfax Disconnected', shop);
  res.json({ ok: true });
});

// ---- Delhivery ----
app.post('/api/logistics/delhivery/connect', async (req, res) => {
  const { shop, api_key } = req.body;
  if (!shop || !api_key) return res.status(400).json({ error: 'shop and api_key required' });
  try {
    await pool.query(
      'UPDATE shopify_stores SET delhivery_api_key=$1, delhivery_connected=true WHERE shop_domain=$2',
      [api_key, shop]
    );
    logActivity(req, 'Delhivery Connected', shop);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logistics/delhivery/disconnect', async (req, res) => {
  const { shop } = req.body;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  await pool.query('UPDATE shopify_stores SET delhivery_api_key=\'\', delhivery_connected=false WHERE shop_domain=$1', [shop]);
  logActivity(req, 'Delhivery Disconnected', shop);
  res.json({ ok: true });
});

// ---- XpressBees ----
app.post('/api/logistics/xpressbees/connect', async (req, res) => {
  const { shop, api_token } = req.body;
  if (!shop || !api_token) return res.status(400).json({ error: 'shop and api_token required' });
  try {
    await pool.query(
      'UPDATE shopify_stores SET xpressbees_api_token=$1, xpressbees_connected=true WHERE shop_domain=$2',
      [api_token, shop]
    );
    logActivity(req, 'XpressBees Connected', shop);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logistics/xpressbees/disconnect', async (req, res) => {
  const { shop } = req.body;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  await pool.query('UPDATE shopify_stores SET xpressbees_api_token=\'\', xpressbees_connected=false WHERE shop_domain=$1', [shop]);
  logActivity(req, 'XpressBees Disconnected', shop);
  res.json({ ok: true });
});

// ---- WareIQ ----
app.post('/api/logistics/wareiq/connect', async (req, res) => {
  const { shop, client_id, client_secret } = req.body;
  if (!shop || !client_id || !client_secret) return res.status(400).json({ error: 'shop, client_id, client_secret required' });
  try {
    const wq = new LogisticsProviders.WareIQ(client_id, client_secret);
    await wq.getToken();
    await pool.query(
      'UPDATE shopify_stores SET wareiq_client_id=$1, wareiq_client_secret=$2, wareiq_connected=true WHERE shop_domain=$3',
      [client_id, client_secret, shop]
    );
    logActivity(req, 'WareIQ Connected', shop);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logistics/wareiq/disconnect', async (req, res) => {
  const { shop } = req.body;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  await pool.query('UPDATE shopify_stores SET wareiq_client_id=\'\', wareiq_client_secret=\'\', wareiq_connected=false WHERE shop_domain=$1', [shop]);
  logActivity(req, 'WareIQ Disconnected', shop);
  res.json({ ok: true });
});

// Set default logistics provider & auto-pickup preference
app.post('/api/logistics/settings', async (req, res) => {
  const { shop, default_provider, auto_pickup } = req.body;
  if (!shop) return res.status(400).json({ error: 'shop required' });
  await pool.query(
    'UPDATE shopify_stores SET default_logistics=$1, logistics_auto_pickup=$2 WHERE shop_domain=$3',
    [default_provider || 'shiprocket', auto_pickup || false, shop]
  );
  logActivity(req, 'Logistics Settings Updated', `Provider: ${default_provider}, Auto-pickup: ${auto_pickup}`);
  res.json({ ok: true });
});

// Admin APIs
const ADMIN_KEY = process.env.ADMIN_KEY || 'goreturn2026admin';

function checkAdmin(req, res) {
  const key = req.body?.admin_key || req.query?.admin_key;
  if (key !== ADMIN_KEY) { res.status(403).json({ error: 'Unauthorized' }); return false; }
  return true;
}

app.post('/api/admin/change-plan', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { shop, plan } = req.body;
  await pool.query('UPDATE shopify_stores SET plan=$1 WHERE shop_domain=$2', [plan, shop]);
  await logActivity(req, 'Plan Changed', `${shop} → ${plan}`);
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
  const sr = await getStoreToken(shop);
  if (!sr.rows.length) return res.json([]);
  try {
    const ordersResp = await fetch(`https://${shop}/admin/api/2025-04/orders.json?status=any&limit=250`, {
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
  const sr = await getStoreToken(shop);
  if (!sr.rows.length) return res.status(404).json({ error: 'Store not connected' });
  try {
    const r = await fetch(`https://${shop}/admin/api/2025-04/orders/${order_id}.json`, {
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

// Activity Log API
app.get('/api/activity-log', authenticateRequest, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 200');
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

// Shopify HMAC verification
function verifyShopifyHmac(req) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  if (!hmac || !SHOPIFY_CLIENT_SECRET) return false;
  const body = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const hash = crypto.createHmac('sha256', SHOPIFY_CLIENT_SECRET).update(body).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac));
  } catch(e) { return false; }
}

// Mandatory Shopify Compliance Webhooks
app.post('/api/webhooks/customers/data_request', (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');
  console.log('Customer data request webhook received');
  res.status(200).json({ ok: true });
});

app.post('/api/webhooks/customers/redact', (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');
  console.log('Customer redact webhook received');
  res.status(200).json({ ok: true });
});

app.post('/api/webhooks/shop/redact', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send('Unauthorized');
  console.log('Shop redact webhook received');
  const shopDomain = req.body?.shop_domain;
  if (shopDomain) {
    try { await pool.query('DELETE FROM shopify_stores WHERE shop_domain = $1', [shopDomain]); } catch(e) {}
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
    try { await pool.query('DELETE FROM shopify_stores WHERE shop_domain = $1', [shopDomain]); } catch(e) {}
    notifyAdmin('⚠️ GoReturn Uninstalled', `<p><strong>${storeName}</strong> (${shopDomain}) just <strong>uninstalled</strong> GoReturn.</p><p>Time: ${new Date().toUTCString()}</p><p>Their stored data has been removed. A reinstall will be detected as a new install.</p>`);
  }
  res.status(200).json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, version: '3.6.0-features', shiprocket: !!SHIPROCKET_EMAIL, email: !!process.env.RESEND_API_KEY, last_email_error: lastEmailError || 'none' }));

app.get('/api/debug/reset-store', async (req, res) => {
  const { shop, key } = req.query;
  if (key !== 'goreturn2026admin') return res.status(403).json({ error: 'invalid key' });
  if (!shop) return res.json({ error: 'shop required' });
  await pool.query('DELETE FROM shopify_stores WHERE shop_domain=$1', [shop]);
  res.json({ ok: true, deleted: shop });
});

app.get('/api/debug/last-exchange', (req, res) => res.json(lastExchange));

// Force re-auth: redirects store through OAuth to get fresh expiring token
app.get('/api/auth/reauth', (req, res) => {
  const { shop, key } = req.query;
  if (key !== 'goreturn2026admin') return res.status(403).send('invalid key');
  if (!shop) return res.status(400).send('shop required');
  const redirectUri = encodeURIComponent(`${APP_URL}/api/auth/callback`);
  const scopes = 'read_orders,write_orders,read_customers,read_products,read_inventory';
  const nonce = crypto.randomBytes(8).toString('hex');
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${redirectUri}&state=${nonce}`);
});

app.get('/api/debug/force-refresh', async (req, res) => {
  const { shop, key } = req.query;
  if (key !== 'goreturn2026admin') return res.status(403).json({ error: 'invalid key' });
  const sr = await pool.query('SELECT refresh_token, token_expires_at FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.json({ error: 'store not in db' });
  const rt = sr.rows[0].refresh_token;
  if (!rt) return res.json({ error: 'no refresh_token stored (token is non-expiring type - reopen embedded app)' });
  const before = sr.rows[0].token_expires_at;
  const fresh = await refreshAccessToken(shop, rt);
  const after = await pool.query('SELECT token_expires_at, LEFT(refresh_token,10) AS rt FROM shopify_stores WHERE shop_domain=$1', [shop]);
  res.json({ refreshed: !!fresh, token_prefix: fresh ? fresh.substring(0,10) : null, expires_before: Number(before), expires_after: Number(after.rows[0].token_expires_at), new_refresh_prefix: after.rows[0].rt });
});

app.get('/api/debug/shop-check', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.json({ error: 'shop param required' });
  const sr = await pool.query('SELECT shop_domain, store_name, created_at FROM shopify_stores WHERE shop_domain=$1', [shop]);
  if (!sr.rows.length) return res.json({ error: 'Store not in DB', shop });
  const token = await getValidToken(shop);
  try {
    const shopR = await fetch(`https://${shop}/admin/api/2025-04/shop.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const shopStatus = shopR.status;
    const shopBody = await shopR.text();
    const ordR = await fetch(`https://${shop}/admin/api/2025-04/orders.json?status=any&limit=3`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const ordStatus = ordR.status;
    const ordBody = await ordR.text();
    res.json({ store: sr.rows[0], shop_api: shopStatus, shop_resp: shopBody.substring(0,200), orders_api: ordStatus, orders_resp: ordBody.substring(0,200), token_prefix: token?.substring(0,12)+'...' });
  } catch(e) { res.json({ store: sr.rows[0], error: e.message }); }
});

app.get('/', async (req, res) => {
  const shop = req.query.shop;
  if (shop) {
    return res.sendFile(path.join(__dirname, '../client/build/index.html'));
  }
  res.sendFile(path.join(__dirname, '../client/build/landing.html'));
});
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../client/build/login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../client/build/index.html')));
app.get('/return', (req, res) => res.sendFile(path.join(__dirname, '../client/build/return.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, '../client/build/privacy.html')));

app.use(express.static(path.join(__dirname, '../client/build'), { index: false }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/build/index.html')));

const PORT = process.env.PORT || 3001;
initDB().then(() => app.listen(PORT, () => console.log('GoReturn v3.0 running on port ' + PORT)));
