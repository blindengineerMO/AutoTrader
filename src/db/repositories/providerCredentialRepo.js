const db = require('../connection');
const { encryptJson, decryptJson, maskSecret } = require('../../services/secretStore');

const upsertStmt = db.prepare(`
  INSERT INTO provider_credentials (
    user_id, provider_type, provider_key, display_name, secret_json_encrypted, status, last_error, updated_at
  )
  VALUES (@userId, @providerType, @providerKey, @displayName, @secretJsonEncrypted, @status, @lastError, datetime('now'))
  ON CONFLICT (user_id, provider_key)
  DO UPDATE SET
    provider_type = @providerType,
    display_name = @displayName,
    secret_json_encrypted = @secretJsonEncrypted,
    status = @status,
    last_error = @lastError,
    updated_at = datetime('now')
`);
const byUser = db.prepare('SELECT * FROM provider_credentials WHERE user_id = ? ORDER BY provider_type, provider_key');
const byUserAndKey = db.prepare('SELECT * FROM provider_credentials WHERE user_id = ? AND provider_key = ?');

function save({ userId, providerType, providerKey, displayName, fields, status = 'configured', lastError = null }) {
  upsertStmt.run({
    userId,
    providerType,
    providerKey,
    displayName,
    secretJsonEncrypted: encryptJson(fields),
    status,
    lastError,
  });
  return getMasked(userId, providerKey);
}

function getSecret(userId, providerKey) {
  const row = byUserAndKey.get(userId, providerKey);
  if (!row) return null;
  return decryptJson(row.secret_json_encrypted);
}

function getMasked(userId, providerKey) {
  const row = byUserAndKey.get(userId, providerKey);
  return row ? maskRow(row) : null;
}

function listMasked(userId) {
  return byUser.all(userId).map(maskRow);
}

function maskRow(row) {
  const fields = decryptJson(row.secret_json_encrypted);
  return {
    id: row.id,
    providerType: row.provider_type,
    providerKey: row.provider_key,
    displayName: row.display_name,
    status: row.status,
    configured: Object.values(fields).some(Boolean),
    maskedFields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, maskSecret(value)])),
    lastValidatedAt: row.last_validated_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

module.exports = { save, getSecret, getMasked, listMasked };
