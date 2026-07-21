// Admin registration/login/OTP/session/logout + team member management routes. Extracted from
// server/index.js (Batch 4 Step 2, Group 2a) — behavior unchanged, verbatim move.

const crypto = require('crypto');
const pool = require('../lib/db');
const { sendEmail, getLastEmailError, ALLOWED_ADMIN_EMAIL } = require('../lib/email');
const { logActivity } = require('../lib/activityLog');
const { hashPassword, verifyPassword, authenticateRequest } = require('../lib/auth');

const APP_URL = process.env.APP_URL || 'http://localhost:3001';

// Valid shop-scoped team roles. Enforced on invite and on role edit so a caller can never write
// an arbitrary string into team_members.role.
const ALLOWED_TEAM_ROLES = ['owner', 'admin', 'viewer'];

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

function registerAdminAuthRoutes(app) {
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
      console.log('Admin register error:', e.message);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // Admin/Team Login — Step 1: Verify credentials & send OTP
  app.post('/api/admin/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    let user = null, userType = '';
    const admin = await pool.query('SELECT * FROM admin_users WHERE email=$1', [email]);
    if (admin.rows.length > 0) { user = admin.rows[0]; userType = 'admin'; }
    else {
      const member = await pool.query('SELECT * FROM team_members WHERE email=$1', [email]);
      if (member.rows.length > 0) { user = member.rows[0]; userType = 'member'; }
    }
    if (!user) { await logActivity(req, 'Login Failed', `Unknown email: ${email}`); return res.status(401).json({ error: 'Invalid email or password' }); }
    const check = verifyPassword(password, user.password_hash);
    if (!check.ok) { await logActivity(req, 'Login Failed', `Wrong password: ${email}`); return res.status(401).json({ error: 'Invalid email or password' }); }
    if (check.upgradedHash) {
      const table = userType === 'admin' ? 'admin_users' : 'team_members';
      pool.query(`UPDATE ${table} SET password_hash=$1 WHERE id=$2`, [check.upgradedHash, user.id]).catch(()=>{});
    }
    const otp = generateOTP();
    otpStore[email] = { otp, userType, userId: user.id, expires: Date.now() + 5 * 60 * 1000 };
    const sent = await sendEmail(email, 'Your GoReturn Login Code', otpEmailHtml(otp, user.name));
    if (!sent) return res.status(500).json({ error: 'Email failed: ' + (getLastEmailError() || 'Unknown error') });
    res.json({ ok: true, otpSent: true, message: 'OTP sent to ' + email });
  });

  // Admin/Team Login — Step 2: Verify OTP
  app.post('/api/admin/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });
    const stored = otpStore[email];
    if (!stored) { await logActivity(req, 'OTP Verify Failed', `No OTP on file: ${email}`); return res.status(400).json({ error: 'No OTP found. Please login again.' }); }
    if (Date.now() > stored.expires) { delete otpStore[email]; await logActivity(req, 'OTP Verify Failed', `Expired: ${email}`); return res.status(400).json({ error: 'OTP expired. Please login again.' }); }
    if (stored.otp !== otp) { await logActivity(req, 'OTP Verify Failed', `Wrong code: ${email}`); return res.status(400).json({ error: 'Invalid OTP. Please try again.' }); }
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
    if (!sent) return res.status(500).json({ error: 'Email failed: ' + (getLastEmailError() || 'Unknown error') });
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
    // Platform owner (admin_users) sees everyone; a shop's own admin/viewer (team_members) must
    // only see their OWN shop's team. isPlatformOwner is set only from which table actually
    // matched in authenticateRequest — never from req.user.role, since a merchant's own team
    // member can legitimately have role='owner' too (a shop-scoped role, not platform-wide).
    const members = req.user.isPlatformOwner
      ? await pool.query('SELECT id, name, email, role, status, last_login, created_at FROM team_members ORDER BY created_at DESC')
      : await pool.query('SELECT id, name, email, role, status, last_login, created_at FROM team_members WHERE shop_domain=$1 ORDER BY created_at DESC', [req.user.shop_domain]);
    res.json(members.rows);
  });

  app.post('/api/team', authenticateRequest, async (req, res) => {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can add team members' });
    const { name, email, role, shop_domain } = req.body;
    // A shop-scoped admin can only invite members to their OWN shop — without this, an admin
    // for Shop A could add a team member to any OTHER shop just by passing its domain here.
    if (!req.user.isPlatformOwner && shop_domain !== req.user.shop_domain) {
      return res.status(403).json({ error: 'Cannot add team members to a different store' });
    }
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
    if (role && !ALLOWED_TEAM_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${ALLOWED_TEAM_ROLES.join(', ')}` });
    }
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
      console.log('Team invite error:', e.message);
      res.status(500).json({ error: 'Failed to send invite' });
    }
  });

  // Validate invite token (for set-password page) — expires 7 days after creation
  app.get('/api/team/invite/:token', async (req, res) => {
    const r = await pool.query('SELECT name, email, role, created_at FROM team_members WHERE invite_token=$1 AND invite_token != $2', [req.params.token, '']);
    if (!r.rows.length) return res.status(404).json({ error: 'Invalid or expired invite link' });
    const ageDays = (Date.now() - new Date(r.rows[0].created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > 7) return res.status(410).json({ error: 'Invite link has expired. Ask the admin to resend the invite.' });
    const { created_at: _, ...safe } = r.rows[0];
    res.json(safe);
  });

  // Invited member sets their own password
  app.post('/api/team/set-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'token and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const r = await pool.query('SELECT id, email, created_at FROM team_members WHERE invite_token=$1 AND invite_token != $2', [token, '']);
    if (!r.rows.length) return res.status(404).json({ error: 'Invalid or expired invite link' });
    const ageDays = (Date.now() - new Date(r.rows[0].created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > 7) return res.status(410).json({ error: 'Invite link has expired. Ask the admin to resend the invite.' });
    await pool.query('UPDATE team_members SET password_hash=$1, status=$2, invite_token=$3 WHERE id=$4',
      [hashPassword(password), 'active', '', r.rows[0].id]);
    res.json({ ok: true, email: r.rows[0].email });
  });

  app.patch('/api/team/:id', authenticateRequest, async (req, res) => {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can edit members' });
    const { name, role, password } = req.body;
    if (role && !ALLOWED_TEAM_ROLES.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Must be one of: ${ALLOWED_TEAM_ROLES.join(', ')}` });
    }
    // Scope by shop_domain unless the caller is the REAL platform owner (isPlatformOwner, set only
    // from admin_users — never from a role string, since a shop's own team member can legitimately
    // have role='owner' too without being platform-wide) — otherwise a shop-scoped admin could
    // edit/reset the password of a team member belonging to a DIFFERENT shop by guessing ids.
    const shopFilter = req.user.isPlatformOwner ? null : req.user.shop_domain;
    const target = await pool.query('SELECT shop_domain FROM team_members WHERE id=$1', [req.params.id]);
    if (!target.rows.length) return res.status(404).json({ error: 'Member not found' });
    if (shopFilter && target.rows[0].shop_domain !== shopFilter) return res.status(404).json({ error: 'Member not found' });
    if (name) await pool.query('UPDATE team_members SET name=$1 WHERE id=$2', [name, req.params.id]);
    if (role) await pool.query('UPDATE team_members SET role=$1 WHERE id=$2', [role, req.params.id]);
    if (password) await pool.query('UPDATE team_members SET password_hash=$1 WHERE id=$2', [hashPassword(password), req.params.id]);
    res.json({ ok: true });
  });

  app.delete('/api/team/:id', authenticateRequest, async (req, res) => {
    if (req.user.role !== 'owner' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can remove members' });
    const shopFilter = req.user.isPlatformOwner ? null : req.user.shop_domain;
    const m = await pool.query('SELECT name, email, shop_domain FROM team_members WHERE id=$1', [req.params.id]);
    if (!m.rows.length) return res.status(404).json({ error: 'Member not found' });
    if (shopFilter && m.rows[0].shop_domain !== shopFilter) return res.status(404).json({ error: 'Member not found' });
    await pool.query('DELETE FROM team_members WHERE id=$1', [req.params.id]);
    await logActivity(req, 'Team Member Removed', `${m.rows[0]?.name} (${m.rows[0]?.email})`);
    res.json({ ok: true });
  });
}

module.exports = { registerAdminAuthRoutes };
