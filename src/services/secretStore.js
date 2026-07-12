const crypto = require('crypto');
const { config } = require('../config');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const source = config.credentialEncryptionKey || config.jwtSecret;
  if (!source) throw new Error('JWT_SECRET or CREDENTIAL_ENCRYPTION_KEY is required before saving provider credentials');
  return crypto.createHash('sha256').update(source).digest();
}

function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const plaintext = JSON.stringify(value || {});
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64')).join('.');
}

function decryptJson(payload) {
  const [ivText, tagText, encryptedText] = String(payload || '').split('.');
  if (!ivText || !tagText || !encryptedText) return {};
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

function maskSecret(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 6) return 'configured';
  return `${text.slice(0, 3)}...${text.slice(-3)}`;
}

module.exports = { encryptJson, decryptJson, maskSecret };
