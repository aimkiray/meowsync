const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../../data');
const dbPath = path.join(dataDir, 'meowsync.sqlite');

let db = null;

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function hasColumn(database, tableName, columnName) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some(column => column.name === columnName);
}

function hasIndex(database, indexName) {
  const row = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name = ?
  `).get(indexName);
  return Boolean(row);
}

function migrateDownloadTasks(database) {
  const hasQueueId = hasColumn(database, 'download_tasks', 'queue_id');
  if (!hasQueueId) {
    database.exec(`
      ALTER TABLE download_tasks ADD COLUMN queue_id INTEGER;
    `);
  }

  const queueRows = database.prepare(`
    SELECT id, playlist_id
    FROM download_queues
    ORDER BY id ASC
  `).all();

  const assignQueueId = database.prepare(`
    UPDATE download_tasks
    SET queue_id = ?
    WHERE playlist_id = ? AND queue_id IS NULL
  `);

  for (const queue of queueRows) {
    assignQueueId.run(queue.id, queue.playlist_id);
  }

  database.exec(`
    DELETE FROM download_tasks
    WHERE queue_id IS NULL
  `);

  if (!hasIndex(database, 'idx_download_tasks_queue')) {
    database.exec(`
      CREATE INDEX idx_download_tasks_queue ON download_tasks(queue_id)
    `);
  }
}

function initSchema(database) {
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      netease_playlist_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      cover_img_url TEXT,
      creator_nickname TEXT,
      track_count INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'netease',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      song_id TEXT NOT NULL,
      name TEXT NOT NULL,
      artist_json TEXT,
      album_json TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      UNIQUE (playlist_id, position)
    );

    CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_id ON playlist_tracks(playlist_id);
    CREATE INDEX IF NOT EXISTS idx_playlist_tracks_song_id ON playlist_tracks(song_id);

    CREATE TABLE IF NOT EXISTS download_queues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      total_tasks INTEGER DEFAULT 0,
      completed_tasks INTEGER DEFAULT 0,
      failed_tasks INTEGER DEFAULT 0,
      concurrent_limit INTEGER DEFAULT 3,
      bitrate INTEGER DEFAULT 320000,
      download_audio INTEGER DEFAULT 1,
      download_lyrics INTEGER DEFAULT 1,
      download_cover INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS download_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      queue_id INTEGER,
      song_id TEXT NOT NULL,
      song_name TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      cover_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      progress INTEGER DEFAULT 0,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      download_audio INTEGER DEFAULT 1,
      download_lyrics INTEGER DEFAULT 1,
      download_cover INTEGER DEFAULT 1,
      audio_path TEXT,
      lyrics_path TEXT,
      cover_path TEXT,
      bitrate INTEGER DEFAULT 320000,
      file_size INTEGER,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (queue_id) REFERENCES download_queues(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_download_tasks_playlist ON download_tasks(playlist_id);
    CREATE INDEX IF NOT EXISTS idx_download_tasks_status ON download_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_download_queues_status ON download_queues(status);
  `);

  migrateDownloadTasks(database);
}

function getDb() {
  if (db) return db;
  ensureDataDir();
  db = new Database(dbPath);
  initSchema(db);
  return db;
}

module.exports = { getDb, dbPath, dataDir };
