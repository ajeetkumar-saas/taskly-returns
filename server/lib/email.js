// Email sending + admin alerting. Extracted from server/index.js (Batch 4 Step 1b) — behavior
// unchanged, verbatim move. Scoped to sendEmail/notifyAdmin and their direct dependencies only;
// email HTML template generators (returnStatusEmail, otpEmailHtml) stay in index.js for now since
// they depend on APP_URL (defined later in index.js) and aren't needed by the db module this
// extraction was unblocking.

const fetch = require('node-fetch');

const ALLOWED_ADMIN_EMAIL = 'ajeetkumar.saas@gmail.com';

// Module-level state, same as it was in index.js — sendEmail() sets it, getLastEmailError()
// lets callers (the /api/health route, OTP-send failure responses) read the current value
// without needing a mutable export (JS doesn't let you export a `let` binding that stays live
// across modules the way a plain variable reference does in the same file).
let lastEmailError = '';
function getLastEmailError() { return lastEmailError; }

// Email throttle to prevent spam: max 3 emails per return per hour
const emailThrottle = {};
function canSendEmail(returnId, toEmail) {
  const key = `${returnId}:${toEmail}`;
  const now = Date.now();
  const sent = emailThrottle[key] || [];
  // Remove entries older than 1 hour
  emailThrottle[key] = sent.filter(t => now - t < 60 * 60 * 1000);
  if (emailThrottle[key].length >= 3) return false;
  emailThrottle[key].push(now);
  return true;
}

async function sendEmail(to, subject, html, attachments, returnId) {
  if (!process.env.RESEND_API_KEY) { lastEmailError = 'RESEND_API_KEY not set'; console.log(lastEmailError); return false; }
  // Throttle emails per return (prevent spam)
  if (returnId && !canSendEmail(returnId, to)) {
    console.log('Email throttled for return', returnId);
    return false;
  }
  const body = { from: process.env.EMAIL_FROM || 'GoReturn <noreply@goreturn.pro>', to: [to], subject, html };
  if (attachments && attachments.length) body.attachments = attachments;
  // Retry transient failures (network error, 429, 5xx) with short backoff — same pattern as
  // shopifyFetch elsewhere in this file, just fewer/shorter retries since this runs inline in
  // request handlers and shouldn't add much latency. Previously a single transient blip meant a
  // customer never got their return-status email at all, with no second attempt.
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (!r.ok || d.error) {
        lastEmailError = d.message || d.error?.message || 'Send failed';
        if ((r.status === 429 || r.status >= 500) && attempt < maxRetries) {
          console.log(`Email transient error (attempt ${attempt + 1}/${maxRetries + 1}):`, lastEmailError);
          await new Promise(res => setTimeout(res, Math.pow(2, attempt) * 1000));
          continue;
        }
        console.log('Email error:', lastEmailError);
        return false;
      }
      console.log('Email sent to:', to, 'id:', d.id);
      lastEmailError = '';
      return true;
    } catch(e) {
      lastEmailError = e.message;
      if (attempt < maxRetries) {
        console.log(`Email network error (attempt ${attempt + 1}/${maxRetries + 1}):`, e.message);
        await new Promise(res => setTimeout(res, Math.pow(2, attempt) * 1000));
        continue;
      }
      console.log('Email error:', e.message);
      return false;
    }
  }
  return false;
}

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

module.exports = { sendEmail, notifyAdmin, getLastEmailError, ALLOWED_ADMIN_EMAIL };
