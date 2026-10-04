// AI 歌词两张表的持久层：song_lyric_translation（译文/哨兵缓存，按词源 id）
// 与 song_ai_verdict（核验判定缓存，song_id 列存 vkey=<词源id>@<模型>@<源签名>）
const { getDb } = require('../db/client');
const { aiModel } = require('../lib/ai');

// AI 产译文按模型键控——换模型后旧译文永不命中（不然模型升级后仍发旧译）。
// 但两类行必须永命中：skip:* 哨兵（TTL 内）与官方译文（model='netease'/
// 'qq'，词源事实与 AI 模型无关）。currentModel 缺省取当前配置模型——
// file-downloader 等单参调用点同口径受益。
// 例外：currentModel 为空（AI 完全未配置/模型被清空）时放行全部非 skip
// 行——存量 AI 译文好过没有；这与「AI 关闭后已落库译文照常下发」的
// 路由语义自洽（否则清模型关 AI 会让下载链静默丢译文）
function getCachedTranslation(songId, currentModel = aiModel()) {
  return getDb().prepare(
    `SELECT tlyric FROM song_lyric_translation WHERE song_id = ?
     AND (
       (model LIKE 'skip:%' AND updated_at >= datetime('now', '-7 days'))
       OR model IN ('netease', 'qq')
       OR model = ?
       OR (? = '' AND model NOT LIKE 'skip:%')
     )`
  ).get(songId, currentModel || '', currentModel || '');
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

const getLyricVerdict = (vkey) => getVerdict(vkey, 'lyric');
const upsertLyricVerdict = (vkey, ok, detail) => upsertVerdict(vkey, 'lyric', ok, detail);

module.exports = {
  getCachedTranslation, upsertTranslation, markTranslationSkip,
  getVerdict, upsertVerdict, getLyricVerdict, upsertLyricVerdict,
};
