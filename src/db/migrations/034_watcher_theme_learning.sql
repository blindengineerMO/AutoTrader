ALTER TABLE watcher_agents ADD COLUMN theme TEXT NOT NULL DEFAULT 'general';
ALTER TABLE watcher_agents ADD COLUMN learning_weight REAL NOT NULL DEFAULT 1.0;
