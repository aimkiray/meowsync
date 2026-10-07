// sync_items：通用 KV 同步持久层。这是「多端同步」的唯一事实源——
// item_key 分三个命名空间前缀，服务端只校验形状不解释语义：
//   playlist:<id>  歌单粒度 LWW 单元（value 是 slimTrack 后的歌单对象）
//   doc:<lsKey>    整文档 LWW（播放状态/历史/偏好等 localStorage 键）
//   lib:index      歌单库级元数据（歌单顺序 + removedDefaultPlaylists 删除名单）
// user_id 是多用户预留：开放部署统一落 'default' 桶，登录态按 users.id
// 分域——表结构第一天就按 user 分域，未来多用户零迁移。
// 两条时序分层互不兼任（写死在这，别再混用）：
//   updated_at 客户端写入时刻——LWW 判优钟，只管「这写赢不赢」：
//              大者赢进 applied；平局（==）与过期（<）服务端留旧进
//              conflicts 回包现值，由客户端采纳对齐
//   seq        服务端生成的全局单调收写序——交付水位线域，只管「变了
//              没有、发到哪」：每条 applied 写（含覆盖写/墓碑覆写）都拿
//              新号，pull 按 seq>since 严格大于下发。客户端钟慢/漂移
//              伤的只是判优，不伤交付
// 删除=墓碑行（deleted=1, value_json='null'），pull 增量必须含墓碑删除
// 才能传播；同 key 后写 deleted=0 即复活。recv_at 纯审计列。
const { getDb } = require('../db/client');

// key 形状白名单（形状闸在路由层用，此处同源导出防两处正则漂移）：
// 三前缀 + 受限字符集（点号/冒号/连字符放行——命名空间内部层级自用）
const ITEM_KEY_RE = /^(playlist|doc|lib):[\w.:-]{1,120}$/;

// 落库串形唯一规则：墓碑行恒 'null'（墓碑不携带载荷——载荷在墓碑里是
// 死数据还会漏隐私）；undefined 归一为 null——JSON.stringify(undefined)
// 返回 undefined 不是串，裸绑会出 NULL/类型错
function valueJsonOf(ch) {
  return ch.deleted ? 'null' : JSON.stringify(ch.value === undefined ? null : ch.value);
}

// 防御性解析：value_json 是服务端自写列本不该脏，但手工改库/迁移事故
// 的脏行不该把整页 pull 炸成 500——降级为 null（调用方按空值合并）
function parseValueJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

// 行 → 线格式：value 回包时已解析成 JSON 值（不是双重编码字符串）；
// seq 随每条 item 下发——客户端的续拉游标就是回包末行 seq 喂回 since
function toItem(row) {
  return {
    key: row.item_key,
    value: parseValueJson(row.value_json),
    updatedAt: row.updated_at,
    deleted: Boolean(row.deleted),
    seq: row.seq
  };
}

function getItem(userId, key) {
  const row = getDb().prepare(
    'SELECT item_key, value_json, updated_at, deleted, seq FROM sync_items WHERE user_id = ? AND item_key = ?'
  ).get(String(userId), String(key));
  return row ? toItem(row) : undefined;
}

// since 增量/全量：since 是交付水位线（服务端 seq 域，非时钟域）——
// seq > since 严格大于；seq 全局单调天然 keyset，续拉游标=末行 seq，
// 无独立 cursor 概念（同戳多行漏/重发问题在 seq 域不存在）。
// 多查一行探测 hasMore。
//
// 水位线越顶自愈：存量 SINCE_KEY 可能是旧契约的 ms 时钟域大数
// （~1.7e12），或服务端重建后 seq 计数重启留下的超顶水位——seq>since
// 永空会让该端同步静默停摆不报错。since > max(seq) 一律按 since=0
// 全量重发：item 级 LWW 合并幂等（重放收敛同态），客户端消化完把末行
// seq 落盘即回正常增量轨。reset 标记回传给路由层作诊断字段（前端
// 日志可观测这次矫正）。
// max(seq) 必须限本 user 行——全表 max 会被其他桶的 seq 污染（seq 计数
// 器全局共享，B 桶发号把表级 max 推高后，A 桶的合法超顶会被误判成
// 正常增量而永空）；本桶空表 COALESCE→0，任何 since>0 都走全量
// （空集），语义自洽。
//
// maxBytes：单页字节预算（路由侧 8MB——2000 条×256KB 单值的最坏页
// ~512MB 不能只按条数放）。iterate 逐行取而非 all() 物化——累计字节
// 触预算即截页置 hasMore，不把超限余量读成内存里的巨型字符串数组。
// 续拉游标仍是页末行 seq（keyset 语义不变：截断处之后的行下次
// seq>since 照常发到，不重不漏）。页首行豁免字节闸：存量巨型单行
// （迁移前写入/手工改库超 256KB）也得发得出，否则该端永远卡在这一页。
function listChanges(userId, { since = 0, limit = 2000, maxBytes = Infinity } = {}) {
  const db = getDb();
  const uid = String(userId);
  // MAX(seq) 按 user 分域——(user_id, seq) 索引最右端一次定位，无全扫
  const maxSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS m FROM sync_items WHERE user_id = ?'
  ).get(uid).m;
  const reset = since > maxSeq;
  const stmt = db.prepare(`
    SELECT item_key, value_json, updated_at, deleted, seq FROM sync_items
    WHERE user_id = ? AND seq > ?
    ORDER BY seq LIMIT ?
  `);
  const page = [];
  let pageBytes = 0;
  let hasMore = false;
  for (const row of stmt.iterate(uid, reset ? 0 : since, limit + 1)) {
    const rowBytes = Buffer.byteLength(row.value_json, 'utf8');
    if (page.length >= limit || (page.length > 0 && pageBytes + rowBytes > maxBytes)) {
      hasMore = true; // 本行起留下页——游标=当前页末行 seq
      break;
    }
    page.push(row);
    pageBytes += rowBytes;
  }
  return { items: page.map(toItem), hasMore, reset };
}

// 批量 LWW 写（单事务——半批落库的混合态比整批失败更难排查）。
// changes 元素 {key, value, updatedAt, deleted}（路由层已做形状校验）；
// 返回 {applied:[keys], conflicts:[{key,item:{key,value,updatedAt,
// deleted,seq}}]}——conflicts 回传服务端现值让客户端采纳（item 内冗余
// key/seq 让客户端零拼接消费）
//
// 取号即写判定，同一闸门：takeSeq 的条件 UPDATE 只在「该条会赢」时把
// 计数器 v+1 发号（无行=新写赢；有行比 updated_at 判优）——被拒行
// 不消耗 seq（水位线跳号会造成客户端空拉），LWW 比较与发号在单条
// UPDATE 里原子完成（读改写无缝隙）。拿到号后无条件覆写：事务写锁已持
// （better-sqlite3 单连接串行），不会再有更晚的写插队；墓碑覆写同路
// 拿新 seq——覆盖写不拿新号会让旧 seq 位的增量拉永远看不到新态
function applyChanges(userId, changes) {
  const db = getDb();
  // 计数器行自愈兜底：迁移已建，手工删行不该让整面变只读（单 SELECT
  // 成本的 no-op）
  const ensureSeq = db.prepare(`
    INSERT INTO sync_meta (k, v)
    SELECT 'sync_seq', COALESCE((SELECT MAX(seq) FROM sync_items), 0)
    WHERE NOT EXISTS (SELECT 1 FROM sync_meta WHERE k = 'sync_seq')
  `);
  const takeSeq = db.prepare(`
    UPDATE sync_meta SET v = v + 1
    WHERE k = 'sync_seq'
      AND (NOT EXISTS (SELECT 1 FROM sync_items WHERE user_id = ? AND item_key = ?)
           OR (SELECT updated_at FROM sync_items WHERE user_id = ? AND item_key = ?) < ?)
    RETURNING v
  `);
  const upsert = db.prepare(`
    INSERT INTO sync_items (user_id, item_key, value_json, updated_at, recv_at, deleted, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, item_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at,
      recv_at = excluded.recv_at,
      deleted = excluded.deleted,
      seq = excluded.seq
  `);
  const sel = db.prepare(
    'SELECT value_json, updated_at, deleted, seq FROM sync_items WHERE user_id = ? AND item_key = ?'
  );
  const applied = [];
  const conflicts = [];
  const recvAt = Date.now();
  const uid = String(userId);
  db.transaction(() => {
    ensureSeq.run();
    for (const ch of changes) {
      const ticket = takeSeq.get(uid, ch.key, uid, ch.key, ch.updatedAt);
      if (ticket) {
        upsert.run(uid, ch.key, valueJsonOf(ch), ch.updatedAt, recvAt, ch.deleted ? 1 : 0, ticket.v);
        applied.push(ch.key);
      } else {
        // 未发号=行在且 updated_at >= 本写（平局或过期）——现值入
        // conflicts 回包；同一事务内行必在，不存在「判负却查无行」
        const existing = sel.get(uid, ch.key);
        conflicts.push({
          key: ch.key,
          item: {
            key: ch.key,
            value: parseValueJson(existing.value_json),
            updatedAt: existing.updated_at,
            deleted: Boolean(existing.deleted),
            seq: existing.seq
          }
        });
      }
    }
  })();
  return { applied, conflicts };
}

module.exports = { ITEM_KEY_RE, valueJsonOf, getItem, listChanges, applyChanges };
