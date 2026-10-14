// AI 歌词两张表的持久层：song_lyric_translation（译文/哨兵缓存，按词源 id）
// 与 song_ai_verdict（核验判定缓存，song_id 列存 vkey=<词源id>@<模型>@<源签名>）
const { getDb } = require('../db/client');
const { aiModel } = require('../lib/ai');

// AI 译文缓存键的 prompt 版本盐：AI 产译文按 '<模型>@<版本>' 落库/命中——
// lyric-translate 的 prompt 或负载契约修订时递增本串，旧译文全链自动
// 失效重译（路由读/写与下载链读同口径），不必清库。skip:* 哨兵与
// netease/qq 官方行不参盐逐字存读——确定性判定与词源事实跟 prompt 无关。
// 常量住在持久层而非 lyric-translate：file-downloader 等单参读点只传
// 裸模型，由本层把裸模型扩成「裸键（命中盐前存量行）+ 当前盐键」两查——
// 盐语义单点收口，版本递增后旧盐行对裸模型读点也自动断命中
const TRANSLATE_PROMPT_VERSION = 't1';
const translationModelKey = (model) => (model ? `${model}@${TRANSLATE_PROMPT_VERSION}` : '');

// AI 产译文按模型键控——换模型后旧译文永不命中（不然模型升级后仍发旧译）。
// 但两类行必须永命中：skip:* 哨兵（TTL 内）与官方译文（model='netease'/
// 'qq'，词源事实与 AI 模型无关）。currentModel 缺省取当前配置模型——
// file-downloader 等单参调用点同口径受益。
// model = ? 双查：第一参原样吃调用方给的键（传盐键即精确命中本版行，
// 传裸模型命中盐前存量行），第二参把裸模型扩成当前盐键——两种入参
// 形态都能命中当前版本行
// 例外：currentModel 为空（AI 完全未配置/模型被清空）时放行全部非 skip
// 行——存量 AI 译文好过没有；这与「AI 关闭后已落库译文照常下发」的
// 路由语义自洽（否则清模型关 AI 会让下载链静默丢译文）
function getCachedTranslation(songId, currentModel = aiModel()) {
  const m = currentModel || '';
  return getDb().prepare(
    `SELECT tlyric FROM song_lyric_translation WHERE song_id = ?
     AND (
       (model LIKE 'skip:%' AND updated_at >= datetime('now', '-7 days'))
       OR model IN ('netease', 'qq')
       OR model = ?
       OR model = ?
       OR (? = '' AND model NOT LIKE 'skip:%')
     )`
  ).get(songId, m, translationModelKey(m), m);
}

function upsertTranslation(songId, tlyric, model) {
  getDb().prepare(`INSERT INTO song_lyric_translation (song_id, tlyric, model)
    VALUES (?, ?, ?) ON CONFLICT(song_id) DO UPDATE SET
    tlyric = excluded.tlyric, model = excluded.model, updated_at = CURRENT_TIMESTAMP`
  ).run(songId, tlyric, model);
}

// skip 哨兵写入：只在旧行也是 skip 时刷新续期——AI 产出的真译文不被哨兵覆盖
function markTranslationSkip(songId, reason) {
  getDb().prepare(
    `INSERT INTO song_lyric_translation (song_id, tlyric, model)
     VALUES (?, '', ?) ON CONFLICT(song_id) DO UPDATE SET
     model = excluded.model, updated_at = CURRENT_TIMESTAMP
     WHERE song_lyric_translation.model LIKE 'skip:%'`).run(songId, `skip:${reason}`);
}

// kind 是自由判别列：'lyric'（词归属核验）/ 'unlock'（解锁候选判定）。
// vkey 由各调用域自定——词归属是 <词源id>@<模型>@<源签名>，解锁是
// <曲id>@yt_<videoId>@<模型>；同一 PK 下不同 kind 互不干扰
function getVerdict(vkey, kind) {
  return getDb().prepare(
    'SELECT ok FROM song_ai_verdict WHERE song_id = ? AND kind = ?'
  ).get(vkey, kind);
}

function upsertVerdict(vkey, kind, ok, detail) {
  getDb().prepare(`INSERT INTO song_ai_verdict (song_id, kind, ok, detail)
    VALUES (?, ?, ?, ?) ON CONFLICT(song_id, kind) DO UPDATE SET
    ok = excluded.ok, detail = excluded.detail, updated_at = CURRENT_TIMESTAMP`
  ).run(vkey, kind, ok ? 1 : 0, detail);
}

// 解锁 verdict 按曲前缀整删（hard retry）：vkey = <曲id>@yt_<videoId>@<模型>，
// GLOB 前缀匹配——LIKE 的 '_' 是单字通配（'yt_' 段会宽匹），GLOB 只 '*'
// 通配、前缀逐字相等，且值全量参数绑定不入 SQL 文本
function deleteUnlockVerdicts(songId) {
  return getDb().prepare(
    `DELETE FROM song_ai_verdict WHERE kind = 'unlock' AND song_id GLOB ?`
  ).run(`${String(songId)}@yt_*`).changes;
}

const getLyricVerdict = (vkey) => getVerdict(vkey, 'lyric');
const upsertLyricVerdict = (vkey, ok, detail) => upsertVerdict(vkey, 'lyric', ok, detail);

module.exports = {
  getCachedTranslation, upsertTranslation, markTranslationSkip,
  getVerdict, upsertVerdict, getLyricVerdict, upsertLyricVerdict,
  deleteUnlockVerdicts, TRANSLATE_PROMPT_VERSION, translationModelKey,
};
