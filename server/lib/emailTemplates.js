// Return-status email HTML generation + per-store email template customization. Extracted from
// server/index.js (Batch 4 Step 2, prep for Group 4) — behavior unchanged, verbatim move.
// Needed by the return routes (refund/patch send status emails via these) as well as the
// email-templates config routes (still in index.js, a later extraction group).

const pool = require('./db');

const APP_URL = process.env.APP_URL || 'http://localhost:3001';

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

module.exports = { returnStatusEmail, DEFAULT_EMAIL_TEMPLATES, getEmailTemplates, fillPlaceholders };
