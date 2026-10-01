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

// 唯一约束检测：存在任一 unique 非 partial 索引且列集恰好匹配——同名但列
// 不同的唯一索引也会让约束落空；sqlite_autoindex_* 必须走 PRAGMA 查
// （sqlite_master.sql 为 NULL）。列序不敏感——UNIQUE(a,b) 与 UNIQUE(b,a) 等价
function hasUniqueIndexOn(database, table, columns) {
  return database.prepare(`PRAGMA index_list('${table}')`).all().some((index) => {
    // partial 索引的唯一性只覆盖 WHERE 子集，全表约束未落实
    if (!index.unique || index.partial) return false;
    // PRAGMA 不支持绑定参数——index.name 来自 sqlite_master 属可信源，
    // 仍按字符串字面量转义兜底
    const cols = new Set(
      database.prepare(
        `PRAGMA index_info('${String(index.name).replace(/'/g, "''")}')`
      ).all().map(col => col.name)
    );
    return cols.size === columns.length && columns.every(c => cols.has(c));
  });
}

// 老库逐列补齐：CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，
// 哪些列是后加的就补哪些（queue_id IS NULL 是独立单曲任务的合法状态，绝不做数据回填/删除）
const DOWNLOAD_TASK_COLUMNS = {
  // 基列也补齐：老库若缺 status/playlist_id 等，迁移/索引/去重 SQL 会引用不到而崩
  playlist_id: 'INTEGER REFERENCES playlists(id) ON DELETE CASCADE',
  song_id: "TEXT NOT NULL DEFAULT ''",
  song_name: "TEXT NOT NULL DEFAULT ''",
  artist: "TEXT NOT NULL DEFAULT ''",
  album: 'TEXT',
  cover_url: 'TEXT',
  status: "TEXT NOT NULL DEFAULT 'pending'",
  progress: 'INTEGER DEFAULT 0',
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
  // 源私有履约数据快照（Music Assistant provider_mappings.details 同思路）：
  // qq 的 mediaMid（vkey filename 键）等——opaque blob，下载协程原样取用
  provider_data: 'TEXT',
  duration_ms: 'INTEGER',
  completed_at: 'TEXT',
  created_at: 'TEXT',
  updated_at: 'TEXT'
};

// 多进程首启竞态：hasColumn 检查与 ALTER 之间对方可能已加列——
// duplicate column 按"列已就绪"对待而不是启动即崩
function addColumnIfMissing(database, table, column, definition) {
  if (hasColumn(database, table, column)) return;
  try {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (!String(error?.message || '').includes('duplicate column')) throw error;
  }
}

function migrateDownloadTasks(database) {
  for (const [column, type] of Object.entries(DOWNLOAD_TASK_COLUMNS)) {
    addColumnIfMissing(database, 'download_tasks', column, type);
  }
  if (!hasIndex(database, 'idx_download_tasks_queue')) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_download_tasks_queue ON download_tasks(queue_id)
    `);
  }
  // (playlist_id, song_id) 唯一约束：新库由 CREATE TABLE 的 UNIQUE(...) 生成
  // sqlite_autoindex_*；老库可能只有非唯一旧索引或完全没有——约束缺失才跑
  // 去重+补索引
  const hasCorrectUniqueIndex = hasUniqueIndexOn(
    database, 'download_tasks', ['playlist_id', 'song_id']
  );
  if (!hasCorrectUniqueIndex) {
    // 约束缺失才跑去重（约束已在时数学上不可能有重复，全表 DELETE 是纯浪费）。
    // 去重保留优先级：completed 行带文件路径，删了它文件会变孤儿；同级保留最小 id。
    // NULL 行跳过：UNIQUE 索引里 NULL 互不冲突，折叠会误删合法多行。
    // DROP+CREATE 放同一事务：中间崩溃留无索引状态，下次启动自愈重建
    database.transaction(() => {
      if (hasIndex(database, 'idx_download_tasks_playlist_song')) {
        database.exec('DROP INDEX idx_download_tasks_playlist_song');
      }
      database.exec(`
        DELETE FROM download_tasks
        WHERE playlist_id IS NOT NULL AND song_id IS NOT NULL
          AND id NOT IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (
                PARTITION BY playlist_id, song_id
                ORDER BY CASE status WHEN 'completed' THEN 0 ELSE 1 END, id
              ) AS rn FROM download_tasks
              WHERE playlist_id IS NOT NULL AND song_id IS NOT NULL
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

// 其余三张表同款的逐列补齐：ALTER ADD COLUMN 不允许 NOT NULL 无默认值、
// 也不允许 CURRENT_TIMESTAMP 作默认值——时间戳列一律可空，写入方负责赋值
const LEGACY_TABLE_COLUMNS = {
  playlists: {
    netease_playlist_id: 'TEXT',
    name: "TEXT NOT NULL DEFAULT ''",
    cover_img_url: 'TEXT',
    creator_nickname: 'TEXT',
    track_count: 'INTEGER NOT NULL DEFAULT 0',
    source: "TEXT NOT NULL DEFAULT 'netease'",
    is_default: 'INTEGER NOT NULL DEFAULT 0',
    created_at: 'TEXT',
    updated_at: 'TEXT',
    last_synced_at: 'TEXT'
  },
  playlist_tracks: {
    // REFERENCES 列必须可空（ADD COLUMN 带 REFERENCES 时默认须为 NULL）
    playlist_id: 'INTEGER REFERENCES playlists(id) ON DELETE CASCADE',
    song_id: "TEXT NOT NULL DEFAULT ''",
    name: "TEXT NOT NULL DEFAULT ''",
    artist_json: 'TEXT',
    album_json: 'TEXT',
    duration_ms: 'INTEGER NOT NULL DEFAULT 0',
    position: 'INTEGER NOT NULL DEFAULT 0',
    raw_json: 'TEXT',
    created_at: 'TEXT'
  },
  download_queues: {
    playlist_id: 'INTEGER REFERENCES playlists(id) ON DELETE CASCADE',
    name: "TEXT NOT NULL DEFAULT ''",
    status: "TEXT NOT NULL DEFAULT 'pending'",
    total_tasks: 'INTEGER DEFAULT 0',
    completed_tasks: 'INTEGER DEFAULT 0',
    failed_tasks: 'INTEGER DEFAULT 0',
    concurrent_limit: 'INTEGER DEFAULT 3',
    bitrate: 'INTEGER DEFAULT 320000',
    download_audio: 'INTEGER DEFAULT 1',
    download_lyrics: 'INTEGER DEFAULT 1',
    download_cover: 'INTEGER DEFAULT 1',
    created_at: 'TEXT',
    updated_at: 'TEXT',
    completed_at: 'TEXT'
  }
};

function migrateLegacyTables(database) {
  for (const [table, columns] of Object.entries(LEGACY_TABLE_COLUMNS)) {
    for (const [column, type] of Object.entries(columns)) {
      addColumnIfMissing(database, table, column, type);
    }
  }

  // 同名异构预发布库的兜底：表存在但缺列时 CREATE IF NOT EXISTS 会跳过，
  // PUT 永久 no such column 500——复用列回填自愈
  addColumnIfMissing(database, 'song_lyric_meta', 'offset_ms', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(database, 'song_lyric_meta', 'updated_at', "TEXT NOT NULL DEFAULT ''");

  // upsertPlaylist 依赖 ON CONFLICT(netease_playlist_id)——老库若没有该唯一
  // 约束，导入/刷新会永久报 "ON CONFLICT clause does not match"。约束缺失时
  // 先去重再补索引（保留最小 id，脏行引用由后续逻辑兜底）
  if (!hasUniqueIndexOn(database, 'playlists', ['netease_playlist_id'])) {
    database.transaction(() => {
      if (hasIndex(database, 'idx_playlists_netease_id')) {
        database.exec('DROP INDEX idx_playlists_netease_id');
      }
      // FK ON 下删有子行的重复歌单会违例崩启动——老库子表 REFERENCES 可能
      // 没声明 ON DELETE CASCADE；显式按"弃留行集"清掉子表再删父行。
      // 弃留集用子查询内联而非 IN (?,...) 参数列表——病态库的超量重复行
      // 会撞 SQLITE_MAX_VARIABLE_NUMBER 崩启动
      const doomedIds = `
        SELECT id FROM playlists
        WHERE netease_playlist_id IS NOT NULL
          AND id NOT IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (
                PARTITION BY netease_playlist_id ORDER BY id
              ) AS rn FROM playlists
              WHERE netease_playlist_id IS NOT NULL
            ) WHERE rn = 1
          )
      `;
      // download_tasks 同时引用 queues——必须先删孙行再删子行
      database.exec(`DELETE FROM download_tasks WHERE playlist_id IN (${doomedIds})`);
      database.exec(
        `DELETE FROM download_tasks WHERE queue_id IN
           (SELECT id FROM download_queues WHERE playlist_id IN (${doomedIds}))`
      );
      database.exec(`DELETE FROM download_queues WHERE playlist_id IN (${doomedIds})`);
      database.exec(`DELETE FROM playlist_tracks WHERE playlist_id IN (${doomedIds})`);
      database.exec(`DELETE FROM playlists WHERE id IN (${doomedIds})`);
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_netease_id
        ON playlists(netease_playlist_id)
      `);
    })();
  }

  // is_default 全局唯一：老库可能并存多个默认歌单（历史上 upsert 只加不清），
  // 保留最近更新的那个，其余清零
  database.exec(`
    UPDATE playlists SET is_default = 0
    WHERE is_default = 1
      AND id NOT IN (
        SELECT id FROM playlists
        WHERE is_default = 1
        ORDER BY datetime(updated_at) DESC, id DESC
        LIMIT 1
      )
  `);

  // track_count 展示计数与实际行数可能漂移（历史截断导入/崩溃窗口）——
  // 启动时收敛为真实行数，前端"已下载 x/y"分母才可信
  database.exec(`
    UPDATE playlists SET track_count = (
      SELECT COUNT(*) FROM playlist_tracks WHERE playlist_tracks.playlist_id = playlists.id
    )
  `);
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

    -- 歌曲级歌词校准：按歌词源 id（neteaseId 优先）存用户调校的时间偏移。
    -- offset_ms 沿用 LRC [offset:] 约定——正值=歌词整体提前显示。
    -- 与播放进度无关，是「这首歌词源本身偏了」的修正，故永久行而非会话态
    CREATE TABLE IF NOT EXISTS song_lyric_meta (
      song_id TEXT PRIMARY KEY,
      offset_ms INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- AI 歌词翻译缓存：同一词源 id 翻一次永久复用（上游歌词修订罕见——
    -- 即便修订也是旧译文变旧而非变错，可接受不版本化）
    CREATE TABLE IF NOT EXISTS song_lyric_translation (
      song_id TEXT PRIMARY KEY,
      tlyric TEXT NOT NULL,
      model TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- AI 判定结果缓存（歌词归属核验等）：ok=0/1，kind 区分判定类型。
    -- 记住「不符」尤其重要——同一错配不该每首歌都重复问一遍模型
    CREATE TABLE IF NOT EXISTS song_ai_verdict (
      song_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ok INTEGER NOT NULL,
      detail TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (song_id, kind)
    );

    -- /healthz 用写探测表：SELECT 1 是纯内存查询测不出磁盘满
    CREATE TABLE IF NOT EXISTS _healthz (ts INTEGER);
  `);

  // 索引必须在列迁移之后创建——老库若缺被索引的列（如 playlist_tracks.song_id），
  // 先建索引会抛 no such column 使 initSchema 中断，migrate 永远跑不到
  migrateDownloadTasks(database);
  migrateLegacyTables(database);

  const INDEX_COLUMNS = [
    ['idx_playlist_tracks_playlist_id', 'playlist_tracks', 'playlist_id'],
    ['idx_playlist_tracks_song_id', 'playlist_tracks', 'song_id'],
    ['idx_download_tasks_playlist', 'download_tasks', 'playlist_id'],
    ['idx_download_tasks_status', 'download_tasks', 'status'],
    ['idx_download_queues_status', 'download_queues', 'status'],
    // cascade/建队列查重/属主判定都按 playlist_id 过滤——队列表全表扫
    ['idx_download_queues_playlist', 'download_queues', 'playlist_id']
  ];
  for (const [name, table, column] of INDEX_COLUMNS) {
    // hasColumn 缺列场景不建（索引缺失可继续跑，比启动即崩可恢复）；
    // IF NOT EXISTS 兜底多进程首启竞态（负者不该因 "index exists" 崩退出）
    if (!hasIndex(database, name) && hasColumn(database, table, column)) {
      database.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${column})`);
    }
  }
}

function getDb() {
  if (db) return db;
  ensureDataDir();
  db = new Database(dbPath);
  initSchema(db);
  return db;
}

module.exports = { getDb, dbPath, dataDir };
