// AES-256-GCM encryption for sensitive credentials (Shopify access/refresh tokens, Shiprocket
// passwords) stored in DB. Requires CREDENTIAL_ENCRYPTION_KEY env var (32-byte hex = 64 hex
// chars). Extracted verbatim from server/index.js — behavior is unchanged, only the file it
// lives in has moved.

const crypto = require('crypto');

function encryptCredential(plaintext) {
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!key || key.length < 64) {
    // In production, this is a critical misconfiguration
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CRITICAL: CREDENTIAL_ENCRYPTION_KEY not set or invalid. Production cannot run without encryption key.');
    }
    // In development, allow plaintext fallback
    console.warn('WARNING: CREDENTIAL_ENCRYPTION_KEY not set. Using plaintext (dev only).');
    return plaintext;
  }
  const keyBuf = Buffer.from(key.slice(0, 64), 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, encrypted]).toString('base64');
}
function decryptCredential(stored) {
  if (!stored || !stored.startsWith('enc:')) return stored; // plaintext legacy data
  const key = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!key || key.length < 64) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CRITICAL: CREDENTIAL_ENCRYPTION_KEY not set or invalid. Cannot decrypt credentials.');
    }
    // Dev fallback: try to recover by slicing (works only if stored as 'enc:' + plaintext)
    console.warn('WARNING: Cannot decrypt without CREDENTIAL_ENCRYPTION_KEY (dev only).');
    return stored.slice(4);
  }
  try {
    const keyBuf = Buffer.from(key.slice(0, 64), 'hex');
    const buf = Buffer.from(stored.slice(4), 'base64');
    if (buf.length < 28) throw new Error('Corrupted credential data (too short)');
    const iv = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const encrypted = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch(e) {
    console.error('Credential decrypt error:', e.message);
    throw new Error('Failed to decrypt credential: ' + e.message);
  }
}

module.exports = { encryptCredential, decryptCredential };
