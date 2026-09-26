const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// DATA_DIR 可能是相对路径（docker-compose bind mount、命令行 export）——先归一化为绝对，
// 否则 DB 与 downloads/ 的实际落盘位置取决于启动 cwd，跨启动方式会静默分叉
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../../data'));
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

// 老库逐列补齐：CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，
// 哪些列是后加的就补哪些（queue_id IS NULL 是独立单曲任务的合法状态，绝不做数据回填/删除）
const DOWNLOAD_TASK_COLUMNS = {
  // ALTER ADD COLUMN 支持 REFERENCES（SQLite ≥3.6.19），不加则删队列时任务行不级联
  queue_id: 'INTEGER REFERENCES download_queues(id) ON DELETE CASCADE',
  error_message: 'TEXT',
  retry_count: 'INTEGER DEFAULT 0',
  download_audio: 'INTEGER DEFAULT 1',
  download_lyrics: 'INTEGER DEFAULT 1',
  download_cover: 'INTEGER DEFAULT 1',
  audio_path: 'TEXT',
  lyrics_path: 'TEXT',
  cover_path: 'TEXT',
  bitrate: 'INTEGER DEFAULT 320000',
  file_size: 'INTEGER',
  duration_ms: 'INTEGER',
  completed_at: 'TEXT'
};

function migrateDownloadTasks(database) {
  for (const [column, type] of Object.entries(DOWNLOAD_TASK_COLUMNS)) {
    if (!hasColumn(database, 'download_tasks', column)) {
      database.exec(`ALTER TABLE download_tasks ADD COLUMN ${column} ${type}`);
    }
  }
  if (!hasIndex(database, 'idx_download_tasks_queue')) {
    database.exec(`
      CREATE INDEX idx_download_tasks_queue ON download_tasks(queue_id)
    `);
  }
  // (playlist_id, song_id) 唯一约束：新库由 CREATE TABLE 的 UNIQUE(...) 生成
  // sqlite_autoindex_*（sqlite_master.sql 为 NULL，必须走 PRAGMA 查）；老库可能
  // 只有非唯一旧索引或完全没有——约束缺失才跑去重+补索引。
  // 判定条件：存在任一 unique 索引且列恰好是 (playlist_id, song_id)——同名但列
  // 不同的唯一索引（如只在 song_id 上）也会让约束落空
  const hasCorrectUniqueIndex = database.prepare(
    `PRAGMA index_list('download_tasks')`
  ).all().some((index) => {
    // partial 索引的唯一性只覆盖 WHERE 子集，全表约束未落实；列序不敏感——
    // UNIQUE(a,b) 与 UNIQUE(b,a) 语义等价，sqlite_autoindex 列序可能与手写不同
    if (!index.unique || index.partial) return false;
    // PRAGMA 不支持绑定参数——index.name 来自 sqlite_master 属可信源，
    // 仍按字符串字面量转义兜底
    const cols = new Set(
      database.prepare(
        `PRAGMA index_info('${String(index.name).replace(/'/g, "''")}')`
      ).all().map(col => col.name)
    );
    return cols.size === 2 && cols.has('playlist_id') && cols.has('song_id');
  });
  if (!hasCorrectUniqueIndex) {
    // 约束缺失才跑去重（约束已在时数学上不可能有重复，全表 DELETE 是纯浪费）。
    // 去重保留优先级：completed 行带文件路径，删了它文件会变孤儿；同级保留最小 id。
    // DROP+CREATE 放同一事务：中间崩溃留无索引状态，下次启动自愈重建
    database.transaction(() => {
      if (hasIndex(database, 'idx_download_tasks_playlist_song')) {
        database.exec('DROP INDEX idx_download_tasks_playlist_song');
      }
      database.exec(`
        DELETE FROM download_tasks
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY playlist_id, song_id
              ORDER BY CASE status WHEN 'completed' THEN 0 ELSE 1 END, id
            ) AS rn FROM download_tasks
          ) WHERE rn = 1
        )
      `);
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_download_tasks_playlist_song
        ON download_tasks(playlist_id, song_id)
      `);
    })();
  }
}

function initSchema(database) {
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
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
      FOREIGN KEY (queue_id) REFERENCES download_queues(id) ON DELETE CASCADE,
      -- 同一歌单的同一首歌只允许一条任务行（standalone 与队列任务共享此唯一域；
      -- 建队列时收养而非重复插入，依赖该约束存在）
      UNIQUE (playlist_id, song_id)
    );

    CREATE INDEX IF NOT EXISTS idx_download_tasks_playlist ON download_tasks(playlist_id);
    CREATE INDEX IF NOT EXISTS idx_download_tasks_status ON download_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_download_queues_status ON download_queues(status);

    -- /healthz 用写探测表：SELECT 1 是纯内存查询测不出磁盘满
    CREATE TABLE IF NOT EXISTS _healthz (ts INTEGER);
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
