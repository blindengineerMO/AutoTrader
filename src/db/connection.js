const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');

const dataDir = path.dirname(config.dbPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// WAL + synchronous=NORMAL is crash-safe across application/process crashes:
// every committed transaction is durable and better-sqlite3 statements are
// atomic, so a mid-run restart can never leave a half-written brain-model row.
db.pragma('synchronous = NORMAL');

module.exports = db;
