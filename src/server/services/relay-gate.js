// ─────────────────────────────────────────────────────────────────────────
// 词源回链音频校验闸·编排层（CJS，有态）：provider_data.neteaseId 是导入期
// 「词同作品」匹配产物（LYRIC_MATCH_CRITERIA 容翻唱/live 同词不同录音），
// 直接当音频源会把错录音固化成本地工件/播放音源。本层在回链消费前对绑条做
// 「同一录音」判定——判定本体是纯函数住 src/shared/relay-gate.js（艺人/
// 时长/cover 标记三轴），这里只编排证据与账：
//
//   veto 双向快路（song_ai_verdict kind='audio_relay'）
//     vkey = <trackId>@<nid>@<sig>；sig = 'a1' 规则盐 + 归一化期望哈希——
//     规则修订换盐旧判自动失效（TRANSLATE_PROMPT_VERSION 同款）。ok=0→
//     block、ok=1→pass 均零上行；pass 落账让已批绑定不重复烧 detail 跳。
//     音频否决独立 kind——绝不写 song_match.vetoed_json：词源否决会连坐
//     抹掉本身可能正确的歌词绑定（翻唱错录音绑对歌词仍合格）
//   song_detail 证据（10min 正档 / 60s 负档 / nid 键单飞合流）
//     绑条元数据是跨腿共用证据：下载主腿/升级腿/播放端点同一 nid 只付
//     一跳上行。合流 promise 不吃调用方 signal——首调用方断连不该让
//     搭车者陪绑降级（unlockInflight 同口径），各等待方 await 后自查
//   freshId 自救（song_match 现行正绑）
//     provider_data 快照滞后于纠错覆写——快照绑条被拦时库行正绑可能是
//     对的，一次为限重判（allowFreshId=false 不递归）；freshId 照写 veto 账
//
// detail 不可达收敛 verdict:'unknown'——不产 5xx 也不判死：下载腿
// deferred 保 ≤3 重试权（宁缺毋滥，detail 拿不到时放行等于固化未验证
// 文件）；播放腿由端点 fail-open。score 只进 detail 诊断不进判定（分数
// 与录音身份零相关）。
// ─────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const { callNeteaseApi } = require('./netease-api');
const { createTtlCache } = require('../lib/stream-resolve-cache');
const { getDb } = require('../db/client');
const lyricAiRepo = require('../repositories/lyricAi');
const songMatchRepo = require('../repositories/songMatch');
const { aiEnabled, aiModel } = require('../lib/ai');
// 判定本体：judgeRelayCand(expected, cand, score) → {verdict,reasons[]}，
// 另有 normArtist/RULE_VERSION——运行时按名取（域 A 并行落地期签名微调
// 只改这几处取用点）
const sharedGate = require('../../shared/relay-gate.js');
const { foldCjkCompat } = require('../../shared/text-norm.js');
const { NETEASE_ID_BOUNDED_RE } = require('../../shared/predicates.js');

const VERDICT_KIND = 'audio_relay';
// detail 上行兜底超时：共享跳不吃调用方 signal，30s 自净上限防悬挂
const DETAIL_TIMEOUT_MS = 30000;
const detailCache = createTtlCache({ max: 256, ttlMs: 10 * 60 * 1000 }); // 正档 10min
const detailNeg = createTtlCache({ max: 256, ttlMs: 60 * 1000 });        // 负档 60s
const detailInflight = new Map(); // nid -> Promise<cand|null>，settler 删键

// 期望侧归一（sig 成分用）：优先 shared 层 normArtist（§3.1 同一比较面），
// 未落地时回落本地同式实现（NFKC→lower→CJK 折叠→剥非文数字）
const normForSig = (s) => (typeof sharedGate.normArtist === 'function'
  ? sharedGate.normArtist(s)
  : foldCjkCompat(String(s ?? '').normalize('NFKC').toLowerCase())
      .replace(/[^\p{L}\p{N}]+/gu, ''));

// sig = 规则盐 + 归一化期望元数据哈希：同一期望面命中同键，镜像行元数据
// 变了 sig 自然换键重判；规则修订换 RULE_VERSION 盐整簿失效
const RULE_VERSION = typeof sharedGate.RULE_VERSION === 'string'
  ? sharedGate.RULE_VERSION : 'a1';
function relaySigOf(expected) {
  const e = expected || {};
  const durMs = Number.isFinite(e.durationMs) ? e.durationMs
    : (Number.isFinite(e.durMs) ? e.durMs : 0);
  const artists = (Array.isArray(e.artists) ? e.artists : [])
    .map(normForSig).filter(Boolean).sort();
  const normTitle = normForSig(e.title);
  return crypto.createHash('sha256')
    .update(`${RULE_VERSION}|${normTitle}|${artists.join(',')}|${durMs}`)
    .digest('hex').slice(0, 16);
}

// song_detail 绑条 → 判定/回包/落账共用的 cand 投影：ar（含 tns/alias——
// 上游真字段，跨文字桥证据）原样保留给判定面，artists 抽成 str[] 回应包
// 契约，dtMs 是 dt 的别名补键
function projectCand(s) {
  const ar = Array.isArray(s.ar) ? s.ar
    : (Array.isArray(s.artists) ? s.artists : []);
  return {
    ...s,
    id: s.id,
    name: s.name,
    ar,
    artists: ar.map(a => (typeof a === 'string' ? a : a?.name)).filter(Boolean),
    dtMs: Number.isFinite(s.dt) ? s.dt : (Number.isFinite(s.dtMs) ? s.dtMs : null),
  };
}

const abortError = () => Object.assign(new Error('已取消'), { aborted: true });
const waitAbort = (signal) => {
  const wa = { p: null, bail: null };
  wa.p = new Promise((_, rej) => {
    if (!signal) return;
    wa.bail = () => rej(abortError());
    if (signal.aborted) return wa.bail();
    signal.addEventListener('abort', wa.bail, { once: true });
  });
  return wa;
};

// nid → cand|null：正档命中直返、负档命中 null、单飞合流一跳。
// 共享跳用内部超时 signal（调用方断连不取消共享上行）；各等待方 await
// 后自查 signal——abort 穿透不落负档（取消是调用方事件不是上游事实）
async function fetchRelayDetail(nid, signal) {
  const key = String(nid);
  const pos = detailCache.get(key);
  if (pos !== undefined) return pos;
  if (detailNeg.get(key) !== undefined) return null;
  let p = detailInflight.get(key);
  if (!p) {
    p = (async () => {
      try {
        const res = await callNeteaseApi('song_detail', { ids: key },
          { signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS) });
        const s = res?.body?.songs?.[0];
        if (s && typeof s === 'object') {
          const cand = projectCand(s);
          detailCache.set(key, cand);
          return cand;
        }
        detailNeg.set(key, true); // 上行回了但无条目——负档
        return null;
      } catch {
        detailNeg.set(key, true); // 传输/超时失败——负档，60s 内不重打
        return null;
      } finally {
        detailInflight.delete(key);
      }
    })();
    detailInflight.set(key, p);
  }
  // race 而非裸 await：调用方断连即时醒，不陪跑到共享跳结束
  const wa = waitAbort(signal);
  try {
    const cand = await Promise.race([p, wa.p]);
    if (signal?.aborted) throw abortError();
    return cand;
  } finally {
    // race 落定即摘 bail——共享跳赢而 signal 未 abort 时监听本会空挂到
    // signal 生命周期（once:true 只在已触发时自摘）
    if (wa.bail) signal.removeEventListener('abort', wa.bail);
  }
}

// veto 快路读：ok 列走 lyricAiRepo 通用读口；命中时补读 detail 列还原
// 当时判因/绑条投影（getVerdict 只投 ok——同表 SELECT detail 是只读
// 旁路，fail-soft 拿不到也放行判定语义）
function readVeto(vkey) {
  let row;
  try { row = lyricAiRepo.getVerdict(vkey, VERDICT_KIND); } catch { return null; }
  if (!row || (row.ok !== 0 && row.ok !== 1)) return null;
  let detail = null;
  try {
    const d = getDb().prepare(
      'SELECT detail FROM song_ai_verdict WHERE song_id = ? AND kind = ?'
    ).get(vkey, VERDICT_KIND)?.detail;
    if (d) detail = JSON.parse(d);
  } catch { /* 脏 detail/库不可读——verdict 语义不依赖它 */ }
  return { ok: row.ok, detail };
}

// song_match 现行正绑自救：provider_data 快照滞后于纠错覆写——正绑 id ≠
// 快照 nid 且不在否决簿才候选（模型键控与 /match/state 读侧同口径）
function freshRelayId(trackId, nid) {
  try {
    const model = aiEnabled() ? (aiModel() || '') : '';
    const row = songMatchRepo.getMatch(trackId, model);
    const fresh = String(row?.netease_id ?? '');
    // 有界纯数字严形（同路由 nid 口径）——song_match 行是词源层产物，
    // 畸形 id 不候选自救（下载腿自身的 NETEASE_ID_RE 宽判据既有不动）
    if (!NETEASE_ID_BOUNDED_RE.test(fresh) || fresh === String(nid)) return null;
    if (songMatchRepo.getVetoedIds(trackId, model).has(fresh)) return null;
    return fresh;
  } catch { return null; } // 自救是增强不是门禁——库不可读按无候选
}

// providerData 快照 → 期望曲元数据：title/author（' ' join 艺人串——
// splitMembers 本就为这形态设计）+ 任务时长。只读组装（冻结对象安全）；
// 缺参归空——判据逐轴跳过不降级。实现委托 shared 单份（判定同层同
// 口径），缺席时本地同式兜底
function relayExpectedOf(providerData, expectedMs) {
  if (typeof sharedGate.relayExpectedOf === 'function') {
    return sharedGate.relayExpectedOf(providerData, expectedMs);
  }
  const pd = providerData && typeof providerData === 'object' ? providerData : {};
  const title = typeof pd.title === 'string' ? pd.title : '';
  const author = typeof pd.author === 'string' ? pd.author : '';
  const durMs = Number.isFinite(expectedMs) && expectedMs > 0 ? expectedMs : 0;
  return { title, artists: author ? [author] : [], durationMs: durMs };
}

// 编排总控：veto 快路 → detail 证据 → judge → 落账 →（block 时）freshId
// 自救一跳。abort 穿透；detail 不可达归 'unknown'
async function adjudicateRelayAudio({ nid, trackId, expected, signal, allowFreshId = true }) {
  if (signal?.aborted) throw abortError();
  const normNid = String(nid ?? '');
  const exp = expected || {};
  const track = typeof trackId === 'string' && trackId ? trackId : '';
  const sig = relaySigOf(exp);
  const vkey = track ? `${track}@${normNid}@${sig}` : '';

  // ① veto 双向快路：同 sig 下重判恒同果——block/pass 都零上行
  if (vkey) {
    const hit = readVeto(vkey);
    if (hit) {
      const old = hit.detail && Array.isArray(hit.detail.reasons) ? hit.detail.reasons : [];
      const cand = hit.detail?.cand && typeof hit.detail.cand === 'object'
        ? { id: Number(normNid) || normNid, ...hit.detail.cand } : null;
      if (hit.ok === 0) {
        // veto 钉的是快照 nid——/match/retry 换绑只写 song_match 不改
        // provider_data 快照也不碰本簿，「判否落账→重匹配→重试」会被旧
        // veto 永拦（§4.3 逃逸通道的死锁面）。先查库行现行正绑自救——
        // 纯本地 DB 读零上行；有候选照常重判一跳（allowFreshId:false
        // 不递归，fresh 自身 vkey 命中 ok=1 也零上行）。自救未过/无
        // 候选照旧落死 block——veto 对快照 nid 仍是已证证据不赦免。
        // allowFreshId=false 的尽力腿（升级腿）不引二次候选同 §4.4
        const fresh = allowFreshId ? freshRelayId(track, normNid) : null;
        if (fresh) {
          const r = await adjudicateRelayAudio({
            nid: fresh, trackId: track, expected: exp, signal, allowFreshId: false,
          });
          if (r.verdict === 'pass') return { ...r, effectiveId: fresh };
        }
        return { verdict: 'block', reasons: ['vetoed', ...old], cand };
      }
      return { verdict: 'pass', reasons: ['vetoed_pass', ...old], cand };
    }
  }

  // ② detail 证据（正/负档+单飞）；不可达 → unknown（调用方按腿取向）
  const cand = await fetchRelayDetail(normNid, signal);
  if (!cand) {
    return { verdict: 'unknown', reasons: ['detail_unavailable'], cand: null };
  }

  // ③ score 只进诊断不进判定——库/行缺席按 null 照样判
  let score = null;
  if (track) {
    try { score = songMatchRepo.getMatchRow(track)?.score ?? null; } catch { /* 诊断缺省 */ }
  }

  const judged = sharedGate.judgeRelayCand(exp, cand, score);
  // 判定面契约只产 pass|block——畸形返回是 bug 要响着失败：静默归 pass
  // 会暗里开闸（错录音固化）；抛出由各调用方按口径降级（端点 unknown/
  // 下载腿 deferred 非 fatal）
  if (judged?.verdict !== 'pass' && judged?.verdict !== 'block') {
    throw new Error(`relay-gate 判定面非法返回: ${JSON.stringify(judged)}`);
  }
  const verdict = judged.verdict;
  const reasons = Array.isArray(judged.reasons) ? judged.reasons : [];
  const evidence = Array.isArray(judged.evidence) ? judged.evidence : [];

  // ④ veto 落账：pass/block 都写（审计痕+双向快路原料）；fail-soft 不挡判定
  if (vkey) {
    try {
      lyricAiRepo.upsertVerdict(vkey, VERDICT_KIND, verdict === 'pass',
        JSON.stringify({
          reasons, evidence, sig, score,
          cand: { id: cand.id, name: cand.name, artists: cand.artists, dtMs: cand.dtMs },
          at: Date.now(),
        }));
    } catch (e) {
      console.warn(`[relay-gate] veto 落账失败: ${e?.message || e}`);
    }
  }

  // ⑤ freshId 自救：快照绑条被拦且库行正绑不同——对正绑重判一跳
  if (verdict === 'block' && allowFreshId && track) {
    const fresh = freshRelayId(track, normNid);
    if (fresh) {
      const r = await adjudicateRelayAudio({
        nid: fresh, trackId: track, expected: exp, signal, allowFreshId: false,
      });
      // freshId 过闸 → effectiveId 换绑续腿；未过（block/unknown）落回原判
      if (r.verdict === 'pass') return { ...r, effectiveId: fresh };
    }
  }

  return {
    verdict,
    reasons,
    cand: { id: cand.id, name: cand.name, artists: cand.artists, dtMs: cand.dtMs },
  };
}

// 测试钩子：进程内正/负档缓存与单飞表清台——模块级 TTL 态跨测试驻留会
// 让同 nid 用例命中陈旧绑条（_setRetryDelays 同款先例，只影响测试节奏
// 不动生产语义）
const _resetRelayCaches = () => {
  for (const k of [...detailCache.keys()]) detailCache.delete(k);
  for (const k of [...detailNeg.keys()]) detailNeg.delete(k);
  detailInflight.clear();
};

module.exports = { adjudicateRelayAudio, relayExpectedOf, _resetRelayCaches };
