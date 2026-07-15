const db = require('../connection');

const SORT_COLUMNS = {
  document_date: 'document_date',
  document_type: 'document_type',
  name: 'name',
  status: 'status',
  downloaded_at: 'downloaded_at',
  created_at: 'created_at',
  updated_at: 'updated_at',
};

const upsertStmt = db.prepare(`
  INSERT INTO alpaca_documents (
    user_id, alpaca_account_id, document_id, document_type, document_date,
    name, status, download_url, local_path, content_type, file_size_bytes, downloaded_at, source_json, updated_at
  )
  VALUES (
    @userId, @alpacaAccountId, @documentId, @documentType, @documentDate,
    @name, @status, @downloadUrl, @localPath, @contentType, @fileSizeBytes, @downloadedAt, @sourceJson, datetime('now')
  )
  ON CONFLICT(user_id, alpaca_account_id, document_id)
  DO UPDATE SET
    document_type = excluded.document_type,
    document_date = excluded.document_date,
    name = excluded.name,
    status = excluded.status,
    download_url = COALESCE(excluded.download_url, alpaca_documents.download_url),
    local_path = COALESCE(excluded.local_path, alpaca_documents.local_path),
    content_type = COALESCE(excluded.content_type, alpaca_documents.content_type),
    file_size_bytes = COALESCE(excluded.file_size_bytes, alpaca_documents.file_size_bytes),
    downloaded_at = COALESCE(excluded.downloaded_at, alpaca_documents.downloaded_at),
    source_json = excluded.source_json,
    updated_at = datetime('now')
`);

const getByCompositeStmt = db.prepare(`
  SELECT * FROM alpaca_documents
  WHERE user_id = ? AND alpaca_account_id = ? AND document_id = ?
`);

const getByIdStmt = db.prepare('SELECT * FROM alpaca_documents WHERE user_id = ? AND id = ?');

const markDownloadedStmt = db.prepare(`
  UPDATE alpaca_documents
  SET download_url = @downloadUrl,
      local_path = COALESCE(@localPath, local_path),
      content_type = COALESCE(@contentType, content_type),
      file_size_bytes = COALESCE(@fileSizeBytes, file_size_bytes),
      downloaded_at = datetime('now'),
      status = 'downloaded',
      updated_at = datetime('now')
  WHERE user_id = @userId AND id = @id
`);

function upsert(doc) {
  const row = normalizeDoc(doc);
  upsertStmt.run(row);
  return getByCompositeStmt.get(row.userId, row.alpacaAccountId, row.documentId);
}

function queryByUser(userId, options = {}) {
  const pageSize = clamp(Number(options.pageSize) || 5, 1, 100);
  const page = Math.max(1, Number(options.page) || 1);
  const offset = (page - 1) * pageSize;
  const where = ['user_id = @userId'];
  const params = { userId, limit: pageSize, offset };

  if (options.search) {
    params.search = `%${String(options.search).trim().toLowerCase()}%`;
    where.push('(LOWER(COALESCE(name, "")) LIKE @search OR LOWER(document_id) LIKE @search OR LOWER(document_type) LIKE @search)');
  }
  if (options.documentType) {
    params.documentType = String(options.documentType).trim();
    where.push('document_type = @documentType');
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;
  const sortBy = SORT_COLUMNS[options.sortBy] || 'document_date';
  const sortDir = String(options.sortDir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const total = db.prepare(`SELECT COUNT(*) AS total FROM alpaca_documents ${whereClause}`).get(params).total;
  const items = db.prepare(`
    SELECT * FROM alpaca_documents
    ${whereClause}
    ORDER BY ${sortBy} ${sortDir}, id ${sortDir}
    LIMIT @limit OFFSET @offset
  `).all(params);

  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function markDownloaded(userId, id, download = {}) {
  markDownloadedStmt.run({
    downloadUrl: download.downloadUrl || null,
    localPath: download.localPath || null,
    contentType: download.contentType || null,
    fileSizeBytes: download.fileSizeBytes || null,
    userId,
    id,
  });
  return getById(userId, id);
}

function getById(userId, id) {
  return getByIdStmt.get(userId, id);
}

function normalizeDoc(doc) {
  return {
    userId: doc.userId,
    alpacaAccountId: String(doc.alpacaAccountId || '').trim(),
    documentId: String(doc.documentId || '').trim(),
    documentType: String(doc.documentType || 'account_statement').trim(),
    documentDate: doc.documentDate || null,
    name: doc.name || null,
    status: doc.status || 'available',
    downloadUrl: doc.downloadUrl || null,
    localPath: doc.localPath || null,
    contentType: doc.contentType || null,
    fileSizeBytes: doc.fileSizeBytes || null,
    downloadedAt: doc.downloadedAt || null,
    sourceJson: JSON.stringify(doc.source || doc.sourceJson || {}),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  upsert,
  queryByUser,
  getById,
  markDownloaded,
};
