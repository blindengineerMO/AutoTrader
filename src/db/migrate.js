const fs = require('fs');
const path = require('path');
const db = require('./connection');
const logger = require('../utils/logger');

function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  const applied = new Set(db.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename));
  const insertApplied = db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const runMigration = db.transaction(() => {
      db.exec(sql);
      insertApplied.run(file);
    });
    runMigration();
    logger.info(`Applied migration ${file}`);
  }
}

if (require.main === module) {
  migrate();
  logger.info('Migrations complete');
}

module.exports = migrate;
