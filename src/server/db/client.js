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
  // ALTER ADD COLUMN 可以携带 REFERENCES（SQLite ≥3.6.19、缺省值须为 NULL）——
  // 但只对「列尚不存在」的库装得上：queue_id/playlist_id 早年曾以无 REFERENCES
  // 的裸 INTEGER 补过的老库，SQLite 不能改既有列的 FK，ON DELETE CASCADE 在
  // 它们身上永远缺席（重建表才能补，风险太大不做）。因此所有删除路径一律
  // 显式删子行（playlists.deletePlaylist / download-manager 级联），不押
  // schema 史上的级联声明；这里的 REFERENCES 只给新建库与新补列的库兜底
  queue_id: 'INTEGER REFERENCES download_queues(id) ON DELETE CASCADE',
  error_message: 'TEXT',
  retry_count: 'INTEGER DEFAULT 0',
  download_audio: 'INTEGER DEFAULT 1',
  download_lyrics: 'INTEGER DEFAULT 1',
  download_cover: 'INTEGER DEFAULT 1',
  download_video: 'INTEGER DEFAULT 0',
  audio_path: 'TEXT',
  lyrics_path: 'TEXT',
  cover_path: 'TEXT',
  video_path: 'TEXT',
  // 实际到手视频档快照 {h,w,codec,br,source}——选流降档无痕是排障黑洞，
  // 落库让"360p vs 4K"对账可查；JSON 文本与 provider_data 同构
  video_meta: 'TEXT',
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
    download_video: 'INTEGER DEFAULT 0',
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

  // song_match 同款预发布兜底（initSchema 的 CREATE 已先于本函数跑过，表必在）
  addColumnIfMissing(database, 'song_match', 'netease_id', 'TEXT');
  addColumnIfMissing(database, 'song_match', 'matched_by', 'TEXT');
  addColumnIfMissing(database, 'song_match', 'score', 'INTEGER');
  addColumnIfMissing(database, 'song_match', 'model', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(database, 'song_match', 'updated_at', "TEXT NOT NULL DEFAULT ''");
  // 否决簿列后加：老库补 DEFAULT '[]'——旧行否决簿空，行为零漂移
  addColumnIfMissing(database, 'song_match', 'vetoed_json', "TEXT NOT NULL DEFAULT '[]'");

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

// sync_items.seq 补列迁移：老库 ALTER 加列后存量行 seq 全 NULL——按
// 「max(现存seq)+rowid」回填（rowid 天然随落库序递增，回填号段严格
// 单调且不撞任何已发号）；计数器行初始化到 max(seq)。旧时钟域索引
// 顺手退役：pull 已切 seq 域，(user_id,updated_at) 复合索引无消费者
function migrateSyncItems(database) {
  addColumnIfMissing(database, 'sync_items', 'seq', 'INTEGER');
  database.transaction(() => {
    const base = database
      .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sync_items')
      .get().m;
    database.prepare('UPDATE sync_items SET seq = rowid + ? WHERE seq IS NULL').run(base);
    database.exec(`
      INSERT INTO sync_meta (k, v)
      SELECT 'sync_seq', COALESCE((SELECT MAX(seq) FROM sync_items), 0)
      WHERE NOT EXISTS (SELECT 1 FROM sync_meta WHERE k = 'sync_seq')
    `);
    if (hasIndex(database, 'idx_sync_items_user_updated')) {
      database.exec('DROP INDEX idx_sync_items_user_updated');
    }
  })();
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
      download_video INTEGER DEFAULT 0,
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
      download_video INTEGER DEFAULT 0,
      audio_path TEXT,
      lyrics_path TEXT,
      cover_path TEXT,
      video_path TEXT,
      video_meta TEXT,
      provider_data TEXT,
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

    -- 外部源→网易云匹配缓存：track_id 是 bv_/yt_/qq_ 客户端曲目 id。
    -- netease_id NULL=负缓存（读查询判 7d TTL）；model 键控 AI 参与结果
    -- （''=纯启发式永命中，AI 结果只在同模型下复用）。正向行只存 id——
    -- 命中时经 song_detail 回水化出完整投影。
    -- vetoed_json=跨会话否决簿 [{id,m,t}]：判否过的 (源,候选) 对不再经
    -- 任何路径复活（乒乓振荡修复）——m 记写入时匹配模型（''=无 AI 期
    -- 永生效，换模后旧否决不参与过滤），t 供 cap 50 FIFO 挤出
    CREATE TABLE IF NOT EXISTS song_match (
      track_id TEXT PRIMARY KEY,
      netease_id TEXT,
      matched_by TEXT,
      score INTEGER,
      model TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      vetoed_json TEXT NOT NULL DEFAULT '[]'
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

    -- 运行时配置覆盖：值留空（行不存在）= 回落环境变量——「留空读服务端
    -- 配置」语义的落点；密钥类值与歌词/任务数据同库（下载目录权限面一致）
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- 登录体系：users 空表 = 未启用登录（向后兼容局域网部署，authGate 全放行）
    -- schema 支持多用户；产品面 v1 只暴露首个管理员 setup
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- 会话：id 存 sha256(token)——库泄不等于会话泄；滑动空闲 TTL + 绝对上限
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      not_after INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT
    );

    -- 多端同步 KV（通用 LWW 面）：playlist:/doc:/lib: 三前缀共用一张表，
    -- 服务端只校验 key 形状不解释语义。两条时序分层互不兼任：
    --   updated_at 客户端写入时刻——LWW 判优钟，只管「这写赢不赢」
    --   seq        服务端生成的全局单调收写序——pull 交付水位线域，
    --              只管「变了没有、发到哪」（客户端钟慢/漂移不伤交付）
    -- recv_at 服务端收到时刻——纯审计列（平局规则是留旧，不参与比较）。
    -- 删除=墓碑行（deleted=1, value_json='null'）：pull 增量必须含墓碑，
    -- 删除才能跨端传播；同 key 后写 deleted=0 即复活。user_id 第一天就
    -- 分域（'default'=开放部署桶，登录态=users.id）——未来多用户零迁移
    CREATE TABLE IF NOT EXISTS sync_items (
      user_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      recv_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      seq INTEGER,
      PRIMARY KEY (user_id, item_key)
    );

    -- sync 水位线计数器（k='sync_seq' 一行）：applyChanges 事务内
    -- 「会写才取」的条件 UPDATE 发号——被拒行不消耗 seq（跳号=空拉）。
    -- 通用 KV 计数器表形态，后续有序列需求直接复用
    CREATE TABLE IF NOT EXISTS sync_meta (
      k TEXT PRIMARY KEY,
      v INTEGER
    );
  `);

  // 索引必须在列迁移之后创建——老库若缺被索引的列（如 playlist_tracks.song_id），
  // 先建索引会抛 no such column 使 initSchema 中断，migrate 永远跑不到
  migrateDownloadTasks(database);
  migrateLegacyTables(database);
  migrateSyncItems(database);

  const INDEX_COLUMNS = [
    ['idx_playlist_tracks_playlist_id', 'playlist_tracks', 'playlist_id'],
    ['idx_playlist_tracks_song_id', 'playlist_tracks', 'song_id'],
    // findTrackBySongId(playlist_id, song_id) 的两列等值查询：两个单列索引
    // 只能命中其一（按 playlist_id 扫全单曲目，大歌单 O(N)）——复合索引
    // 才是这条热路径的正确形态
    ['idx_playlist_tracks_playlist_song', 'playlist_tracks', ['playlist_id', 'song_id']],
    ['idx_download_tasks_playlist', 'download_tasks', 'playlist_id'],
    // 跨歌单按曲寻址（videoReady 工件查找）走 song_id——(playlist,song)
    // 唯一索引的最左列是 playlist_id 用不上
    ['idx_download_tasks_song', 'download_tasks', 'song_id'],
    ['idx_download_tasks_status', 'download_tasks', 'status'],
    ['idx_download_queues_status', 'download_queues', 'status'],
    // cascade/建队列查重/属主判定都按 playlist_id 过滤——队列表全表扫
    ['idx_download_queues_playlist', 'download_queues', 'playlist_id'],
    ['idx_sessions_expires', 'sessions', 'expires_at'],
    // sync pull 的 since 增量扫走 seq 域（交付水位线），恒按 user 分域
    // 过滤——复合索引最左列必须是 user_id；ORDER BY seq 顺势吃索引序
    ['idx_sync_items_user_seq', 'sync_items', ['user_id', 'seq']]
  ];
  for (const [name, table, column] of INDEX_COLUMNS) {
    // hasColumn 缺列场景不建（索引缺失可继续跑，比启动即崩可恢复）；
    // IF NOT EXISTS 兜底多进程首启竞态（负者不该因 "index exists" 崩退出）
    const columns = Array.isArray(column) ? column : [column];
    if (!hasIndex(database, name)
        && columns.every(col => hasColumn(database, table, col))) {
      database.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns.join(', ')})`);
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
