const fs = require('fs/promises');
const path = require('path');
const { config } = require('../config');
const alpacaDocumentRepo = require('../db/repositories/alpacaDocumentRepo');
const providerCredentialRepo = require('../db/repositories/providerCredentialRepo');
const logger = require('../utils/logger');

const DOCUMENT_TYPES = [
  'account_statement',
  'crypto_account_statement',
  'tax_statement',
  'trade_confirmation',
  'trade_confirmation_json',
];

async function syncMonthlyDocuments(userId, options = {}) {
  const credentials = getCredentials(userId);
  if (!credentials.keyId || !credentials.secretKey || !credentials.accountId) {
    return {
      skipped: true,
      reason: 'Alpaca Broker API key, secret, and broker account ID are required for statement sync.',
      items: [],
    };
  }

  const { start, end } = resolveDateWindow(options.now || new Date());
  const types = Array.isArray(options.types) && options.types.length ? options.types : DOCUMENT_TYPES;
  const items = [];
  const errors = [];

  for (const type of types) {
    try {
      const documents = await listDocuments(userId, { start, end, type });
      for (const document of documents) {
        const normalized = normalizeDocument({ document, userId, accountId: credentials.accountId, fallbackType: type });
        if (!normalized.documentId) continue;
        let downloadUrl = null;
        try {
          downloadUrl = await getDocumentDownloadUrl(userId, normalized.documentId);
        } catch (err) {
          logger.warn('Alpaca document download-link resolution failed during sync', {
            userId,
            documentId: normalized.documentId,
            type,
            error: err.message,
          });
        }
        const persisted = downloadUrl ? await persistDownloadedFile(userId, normalized, downloadUrl) : {};
        items.push(alpacaDocumentRepo.upsert({
          ...normalized,
          downloadUrl,
          ...persisted,
          downloadedAt: (persisted.localPath || downloadUrl) ? new Date().toISOString() : null,
          status: persisted.localPath ? 'downloaded' : downloadUrl ? 'download_linked' : 'available',
        }));
      }
    } catch (err) {
      errors.push({ type, error: err.message });
      logger.warn('Alpaca document list sync failed', { userId, type, error: err.message });
    }
  }

  return { skipped: false, start, end, items, errors };
}

async function listDocuments(userId, { start, end, type } = {}) {
  const credentials = getCredentials(userId);
  assertCredentials(credentials);
  const path = `/v1/accounts/${encodeURIComponent(credentials.accountId)}/documents`;
  const url = new URL(`${credentials.brokerBaseUrl}${path}`);
  if (start) url.searchParams.set('start', start);
  if (end) url.searchParams.set('end', end);
  if (type) url.searchParams.set('type', type);

  const response = await fetch(url, {
    headers: authHeaders(credentials, { Accept: 'application/json' }),
  });
  if (!response.ok) throw new Error(`Alpaca documents list failed (${response.status})`);
  const payload = await response.json();
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.documents)) return payload.documents;
  if (Array.isArray(payload?.account_documents)) return payload.account_documents;
  return [];
}

async function getDocumentDownloadUrl(userId, documentId, { acceptJson = false } = {}) {
  const credentials = getCredentials(userId);
  assertCredentials(credentials);
  if (!documentId) throw new Error('Alpaca document id is required.');
  const url = `${credentials.brokerBaseUrl}/v1/accounts/${encodeURIComponent(credentials.accountId)}/documents/${encodeURIComponent(documentId)}/download`;
  const response = await fetch(url, {
    redirect: 'manual',
    headers: authHeaders(credentials, { Accept: acceptJson ? 'application/json' : 'application/pdf' }),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (location) return location;
  }
  if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
    const payload = await response.json();
    return payload.url || payload.download_url || payload.location || null;
  }
  if (response.ok && response.url && response.url !== url) return response.url;
  throw new Error(`Alpaca document download failed (${response.status})`);
}

async function refreshDownloadLink(userId, localDocumentId) {
  const row = alpacaDocumentRepo.getById(userId, localDocumentId);
  if (!row) return null;
  const url = await getDocumentDownloadUrl(userId, row.document_id, {
    acceptJson: row.document_type === 'trade_confirmation_json',
  });
  return alpacaDocumentRepo.markDownloaded(userId, localDocumentId, { downloadUrl: url });
}

function queryDocuments(userId, options) {
  return alpacaDocumentRepo.queryByUser(userId, options);
}

function getCredentials(userId) {
  const saved = userId ? providerCredentialRepo.getSecret(userId, 'alpaca') : null;
  const paper = parseBoolean(saved?.paper, config.alpaca.paper);
  return {
    keyId: saved?.keyId || config.alpaca.keyId,
    secretKey: saved?.secretKey || config.alpaca.secretKey,
    paper,
    brokerBaseUrl: stripTrailingSlash(saved?.brokerBaseUrl || config.alpaca.brokerBaseUrl || defaultBrokerBaseUrl(paper)),
    accountId: saved?.brokerAccountId || saved?.accountId || config.alpaca.brokerAccountId,
  };
}

async function persistDownloadedFile(userId, document, downloadUrl) {
  try {
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`signed document fetch failed (${response.status})`);
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await response.arrayBuffer());
    const extension = contentType.includes('json') || document.documentType.endsWith('_json') ? 'json' : 'pdf';
    const dir = path.join(path.dirname(config.dbPath), 'alpaca-documents', `user-${userId}`, safePathPart(document.alpacaAccountId));
    await fs.mkdir(dir, { recursive: true });
    const localPath = path.join(dir, `${safePathPart(document.documentId)}.${extension}`);
    await fs.writeFile(localPath, buffer);
    return {
      localPath,
      contentType,
      fileSizeBytes: buffer.length,
    };
  } catch (err) {
    logger.warn('Alpaca signed document fetch failed; retaining download URL only', {
      userId,
      documentId: document.documentId,
      error: err.message,
    });
    return {};
  }
}

function normalizeDocument({ document, userId, accountId, fallbackType }) {
  const documentId = document.id || document.document_id || document.documentId || document.uuid;
  const documentType = document.type || document.document_type || fallbackType || 'account_statement';
  const documentDate = document.date || document.document_date || document.created_at || document.updated_at || document.period || null;
  const name = document.name || document.filename || document.description || `${documentType} ${documentDate || documentId}`;
  return {
    userId,
    alpacaAccountId: accountId,
    documentId,
    documentType,
    documentDate,
    name,
    status: document.status || 'available',
    source: document,
  };
}

function resolveDateWindow(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const startDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 2, 1));
  const endDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return {
    start: startDate.toISOString().slice(0, 10),
    end: endDate.toISOString().slice(0, 10),
  };
}

function assertCredentials(credentials) {
  if (!credentials.keyId || !credentials.secretKey) throw new Error('Alpaca API key ID and secret key are required.');
  if (!credentials.accountId) throw new Error('Alpaca Broker account ID is required.');
}

function authHeaders(credentials, extra = {}) {
  return {
    ...extra,
    Authorization: `Basic ${Buffer.from(`${credentials.keyId}:${credentials.secretKey}`).toString('base64')}`,
  };
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'paper'].includes(String(value).trim().toLowerCase());
}

function defaultBrokerBaseUrl(paper) {
  return paper ? 'https://broker-api.sandbox.alpaca.markets' : 'https://broker-api.alpaca.markets';
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function safePathPart(value) {
  return String(value || 'document').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

module.exports = {
  DOCUMENT_TYPES,
  syncMonthlyDocuments,
  listDocuments,
  getDocumentDownloadUrl,
  refreshDownloadLink,
  queryDocuments,
  getCredentials,
  resolveDateWindow,
  persistDownloadedFile,
};
