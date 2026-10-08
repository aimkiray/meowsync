// 候选打分器（纯函数，零 IO）：把「这首网易云候选是不是源视频/源曲」拆成
// title(0-50)/artist(0-30)/duration(0-20)/flags 修正四维证据，替代旧的
// 「首个 shareName 命中即收」。reject=硬闸否决（源有时长且差>45s、源无伴奏
// 标记而候选带伴奏标记，rejectKind 区分 dur/marker）；title 证据过弱（<15）
// 时总分封顶在 GRAY 下沿——纯时长/纯艺人命中永远进不了确定性收线，
// 与「错歌词比没歌词更糟」同哲学。中立艺人分（源/候选任一缺艺人信息）配
// 非精确 title（<50）同样压到灰区下——同名异曲在艺人缺位时无反证。
//
// src = { titles:[str], artists:[str], durationSec }
//   titles：本请求已知标题面（查询串 ∪ 候选串 ∪ 源标题）——任一配对命中即给分
//   artists：源艺人参照（源 author ∪ artists[]），空=无艺人信息→中立分 15
//   durationSec：源秒数；0/缺失=无时长证据（不加分也不硬闸）

// ── CJK 繁→简逐字折叠表（仅比较面）─────────────────────────────────
// 同一作品的歌名在两岸三地+日文圈流转常带异体字皮（yt_ 源「懐中道標」vs
// 网易条目「懐中道标」）——不折叠则 pairTitleScore 全灭、title<15 把总分
// 封顶在灰区下，逐项灰区复核根本轮不到它。curated 覆盖歌名高频异体，
// 繁体正字与日文新字体（說/髪/竜/気/変类）一并归并到简体比较键——
// 只收常见字形，条数不作硬承诺（防表头随补表漂移）。
// 多对一归并是刻意的评分面近似：後（之后）/后（皇后）单字同归「后」——
// 「王後」折成「王后」这类误合是已签收的比较面碰撞。折叠只抬高评分面
// 召回（同题异体即同题），身份级最终判定归下游 AI 复核层。只挂
// normToken 一处：打分比对/艺人比对/strictTitleHit
// （lyric-external.js 身份闸）/变体 dedupe 键全链受益；键不回流持久化
// 与展示串，别处不另起平行折叠实现
const CJK_FOLD = new Map(Object.entries({
  // 言文/抽象高频
  語: '语', 話: '话', 読: '读', 書: '书', 詩: '诗', 記: '记', 証: '证',
  聞: '闻', 問: '问', 説: '说', 談: '谈', 謎: '谜', 謝: '谢', 誤: '误',
  誘: '诱', 論: '论', 譲: '让', 讓: '让', 護: '护', 讃: '赞', 賛: '赞',
  說: '说', 讀: '读', 認: '认', 識: '识', 議: '议', 該: '该', 試: '试',
  課: '课', 調: '调', 請: '请', 譯: '译', 諸: '诸', 誰: '谁', 謳: '讴',
  詠: '咏',
  // 情感/意象
  愛: '爱', 戀: '恋', 夢: '梦', 淚: '泪', 憶: '忆', 懐: '怀', 願: '愿',
  悪: '恶', 惡: '恶', 恥: '耻', 偽: '伪', 優: '优', 傷: '伤', 僕: '仆',
  響: '响', 鳴: '鸣', 聲: '声', 樂: '乐', 楽: '乐', 標: '标', 強: '强',
  懷: '怀', 憂: '忧', 慾: '欲', 嚴: '严', 慶: '庆', 聖: '圣', 靈: '灵',
  純: '纯', 細: '细', 蒼: '苍', 輝: '辉', 榮: '荣', 爍: '烁', 燦: '灿',
  爛: '烂', 殞: '殒', 墮: '堕', 淪: '沦', 絕: '绝', 絶: '绝', 祕: '秘',
  麗: '丽', 颯: '飒', 凜: '凛', 朧: '胧', 曖: '暧',
  // 时空/方位
  時: '时', 間: '间', 場: '场', 処: '处', 後: '后',
  開: '开', 關: '关', 閉: '闭', 門: '门', 見: '见', 覚: '觉', 観: '观',
  親: '亲', 學: '学', 會: '会', 對: '对', 來: '来', 還: '还', 這: '这',
  們: '们', 個: '个', 無: '无', 與: '与', 為: '为', 於: '于', 雖: '虽',
  當: '当', 臺: '台', 裡: '里', 裏: '里', 麼: '么',
  點: '点', 線: '线', 變: '变', 変: '变', 終: '终', 結: '结', 続: '续',
  斷: '断', 別: '别', 長: '长', 遠: '远', 邊: '边',
  辺: '边', 週: '周', 進: '进', 連: '连', 選: '选', 遊: '游', 運: '运',
  過: '过', 達: '达', 遅: '迟',
  處: '处', 觀: '观', 歸: '归', 晝: '昼', 歲: '岁', 颱: '台', 綫: '线',
  爲: '为', 卻: '却', 纔: '才', 剛: '刚', 從: '从', 將: '将', 給: '给',
  餘: '余', 離: '离', 續: '续', 經: '经', 約: '约', 數: '数', 據: '据',
  擇: '择', 獲: '获', 敗: '败', 亂: '乱', 壓: '压', 應: '应', 復: '复',
  複: '复', 幹: '干', 乾: '干', 發: '发', 廣: '广', 舊: '旧', 寫: '写',
  // 自然/物名
  風: '风', 雲: '云', 霧: '雾', 氣: '气', 気: '气', 陽: '阳', 陰: '阴',
  桜: '樱', 紅: '红', 緑: '绿', 藍: '蓝', 蓮: '莲', 華: '华', 葉: '叶',
  蘭: '兰', 萬: '万', 龍: '龙', 竜: '龙', 飛: '飞',
  鳥: '鸟', 魚: '鱼', 蟻: '蚁', 鴉: '鸦', 鶴: '鹤', 鷹: '鹰', 駒: '驹',
  騎: '骑', 驚: '惊', 馬: '马', 電: '电', 車: '车', 島: '岛', 沖: '冲',
  縄: '绳', 渋: '涩', 浜: '滨', 滝: '泷', 瀧: '泷', 沢: '泽', 稲: '稻',
  檸: '柠', 苺: '莓', 麺: '面', 麵: '面', 豊: '丰', 黒: '黑', 髙: '高',
  櫻: '樱', 綠: '绿', 燈: '灯', 鐵: '铁', 銀: '银', 嶋: '岛', 濱: '滨',
  灘: '滩', 淵: '渊', 瀨: '濑', 渦: '涡', 燐: '磷', 煙: '烟', 嵐: '岚',
  楓: '枫', 樺: '桦', 菫: '堇', 薔: '蔷', 螢: '萤', 雞: '鸡', 曉: '晓',
  澤: '泽',
  // 身体/人事
  髪: '发', 頭: '头', 顔: '颜', 額: '额', 顎: '颚', 歯: '齿', 脳: '脑',
  腸: '肠', 臓: '脏', 髄: '髓', 聴: '听', 姫: '姬', 歳: '岁', 児: '儿',
  聽: '听', 兒: '儿', 顏: '颜', 齒: '齿', 腦: '脑', 體: '体', 臉: '脸',
  髮: '发', 藥: '药', 醫: '医', 癒: '愈',
  // 动作用字
  織: '织', 繋: '系', 絆: '绊', 綴: '缀', 綻: '绽', 縫: '缝', 縮: '缩',
  繰: '缲', 絵: '绘', 経: '经', 総: '总', 緒: '绪', 羅: '罗', 義: '义',
  剣: '剑', 劇: '剧', 勝: '胜', 勵: '励', 區: '区', 単: '单', 巻: '卷',
  収: '收', 売: '卖', 伝: '传', 価: '价', 歩: '步', 毎: '每', 嘆: '叹',
  囲: '围', 國: '国', 壊: '坏', 墜: '坠', 奮: '奋', 駅: '驿', 罰: '罚',
  辭: '辞', 鋼: '钢', 鍵: '键', 鎖: '锁', 鐘: '钟', 鏡: '镜', 靜: '静',
  鬱: '郁', 艶: '艳', 艷: '艳', 竈: '灶', 禰: '祢', 號: '号', 暁: '晓',
  晩: '晚', 蛍: '萤', 鶏: '鸡', 渓: '溪', 隠: '隐', 険: '险', 陣: '阵',
  隱: '隐', 險: '险', 單: '单', 傳: '传', 賣: '卖', 價: '价', 圍: '围',
  壞: '坏', 劍: '剑', 總: '总', 繪: '绘', 繫: '系', 編: '编', 戰: '战',
  闘: '斗', 鬥: '斗', 團: '团', 園: '园', 殺: '杀', 滅: '灭', 襲: '袭',
  擊: '击', 韌: '韧', 鋭: '锐', 銳: '锐', 鎮: '镇', 錄: '录', 鏈: '链',
  鑰: '钥', 鑽: '钻', 鋪: '铺', 牆: '墙', 塵: '尘', 墳: '坟', 轍: '辙',
  跡: '迹', 蹟: '迹', 縷: '缕', 纏: '缠', 繞: '绕', 絡: '络', 紡: '纺',
  綺: '绮', 亜: '亚', 亞: '亚', 両: '两', 兩: '两', 闇: '暗',
}));

const foldCjkCompat = (s) => String(s || '')
  .replace(/[㐀-鿿豈-﫿]/g, (c) => CJK_FOLD.get(c) ?? c);

// 归一化原语本属 netease-match——打分器与复核判定共用同一口径，上提到本文件
// 避免环依赖（netease-match require 本文件，反向 require 会成环）。
// 尾挂 foldCjkCompat：lowercase+剥标点后做繁→简多对一归一——比较面近似
// （见上表头注），非身份等价；最终判定归下游 AI 复核层
const normToken = (s) => foldCjkCompat(String(s || '')
  .toLowerCase().replace(/[\s《》【】（）()\-—–_~～·]/g, ''));

// 修饰/噪声词表：艺人参照成员过滤与查询 token 判定共用（子串碰撞面注释
// 保留原考据——'ep'⊂'deeppurple'、'olive'吞'live' 这类假交集教训）
const QUERY_NOISE = new Set([
  'cover', 'covers', 'covered', 'coverver', '커버', '翻唱', '翻弹', '演奏',
  'live', 'official', 'mv', 'audio', 'video', 'lyric', 'lyrics',
  'hd', '4k', '8k', 'remix', 'full', '完整版', '完整',
  'feat', 'ft', 'by', 'ver', 'version', 'ep', 'op', 'ed', 'ost',
  'mix', 'edit', 'demo', 'pv', 'inst', 'instrumental', 'acoustic',
  'karaoke', '8d', 'slowed', 'sped', 'remaster', 'remastered',
  'single', 'album', 'topic',
  '现场', '伴奏', '演唱会', '单曲', '专辑', '中字', '字幕', '合集',
  '试听', '自制', '搬运', '转载',
]);
const noiseKey = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// 歌名第二变体：全括号群剥除——「乐园(粤)」「Title (Live)」「歌名【翻唱】」
// 的括内修饰参与比对只会稀释相似度；配对时使用剥除变体命中×0.9 降权
// （剥了才长得像≠原串真相等）
const BRACKET_GROUP_RE = /[[(（【][^[\]()（）【】]{0,60}?[\])）】]/g;
const stripBrackets = (s) => String(s || '').replace(BRACKET_GROUP_RE, ' ');

const ACCEPT_SCORE = 75;  // ≥75 确定性收（matchedBy=查询串）
const GRAY_SCORE = 50;    // 50-74 灰区：有 AI 复核、无 AI 宽松收；<50 丢
const DUR_HARD_GATE_SEC = 45; // 沿用旧 MATCH_DUR_TOLERANCE_SEC 的硬闸值

// 归一化串两两比对：精确=50；互包含=35+15×短长比（短串全嵌长串是强信号，
// 但长串里掺了多少修饰要折损）；<2 字符无比对价值
const pairTitleScore = (na, nb) => {
  if (na.length < 2 || nb.length < 2) return 0;
  if (na === nb) return 50;
  if (na.includes(nb) || nb.includes(na)) {
    return 35 + 15 * (Math.min(na.length, nb.length) / Math.max(na.length, nb.length));
  }
  return 0;
};

// token Jaccard：跨语/噪声标题下互包含会失效，词袋重合是兜底证据。
// token 过滤噪声词（'cover'/'live' 满天飞，会让两个无关串假性重合）
const titleTokensOf = (s) => new Set(
  String(s || '').split(/[^\p{L}\p{N}]+/u)
    .map(noiseKey)
    .filter(t => t.length >= 2 && !QUERY_NOISE.has(t)));

const jaccardTitleScore = (a, b) => {
  const ta = titleTokensOf(a);
  const tb = titleTokensOf(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const j = inter / (ta.size + tb.size - inter);
  return j >= 0.6 ? 20 + 15 * (j - 0.6) / 0.4 : 0;
};

// 艺人拆分：'A feat. B'、'A/B'、'A、B'、'A,B'、'A×B'、'A&B' 与裸空格多写
// （QQ 侧 author 就是 join(' ') 产物）。成员过噪声闸——'feat'/'ft' 碎片、
// 'DJ X' 拆出的 'dj' 这类不掺和比对
const ARTIST_SPLIT_RE = /\s*(?:\bfeat\.?\b|\bft\.?\b|[、×&，,／/]|\s+)/iu;
const artistMembers = (s) => String(s || '').split(ARTIST_SPLIT_RE)
  .map(normToken).filter(t => t.length >= 2 && !QUERY_NOISE.has(noiseKey(t)));

// 候选艺人名数组（云搜 ar/artists[].name；元素偶发裸字符串也收）
const candArtistNames = (song) => {
  const arr = Array.isArray(song?.ar || song?.artists) ? (song.ar || song.artists) : [];
  return arr.map(a => (typeof a === 'object' ? a?.name : a)).filter(Boolean);
};

// 艺人分：整串精确=30；整串互包含（短边≥2，'王菲' 类短名艺人合法）=25；
// 成员级（exact/包含，短边≥3——'DJ Snake' vs 'DJ Okawari' 的 'dj' 碰撞
// 不收）=25；源或候选任一缺失艺人信息=中立 15（无信息不奖不罚，feats
// 立 artistNeutral 标——该分不得参与确定性收，见 scoreCandidate 尾部）；
// 有参照却零交集=0（不给负分——翻唱/异唱合法，靠其他维与 AI 兜）
function artistScore(srcArtists, candNames, feats) {
  const refWholes = new Set();
  const refMembers = new Set();
  for (const a of (Array.isArray(srcArtists) ? srcArtists : [])) {
    const w = normToken(a);
    if (w.length >= 2 && !QUERY_NOISE.has(noiseKey(a))) refWholes.add(w);
    for (const m of artistMembers(a)) refMembers.add(m);
  }
  const candWholes = new Set();
  const candMembers = new Set();
  for (const a of candNames) {
    const w = normToken(a);
    if (w.length >= 2 && !QUERY_NOISE.has(noiseKey(a))) candWholes.add(w);
    for (const m of artistMembers(a)) candMembers.add(m);
  }
  if (!refWholes.size && !refMembers.size) { feats.artistNeutral = true; return 15; }
  if (!candWholes.size && !candMembers.size) { feats.artistNeutral = true; return 15; }
  let best = 0;
  for (const r of refWholes) {
    for (const cw of candWholes) {
      if (r === cw) return 30;
      if (r.includes(cw) || cw.includes(r)) best = 25;
    }
  }
  for (const r of refMembers) {
    for (const m of candMembers) {
      if (r === m ? Math.min(r.length, m.length) >= 3
        : (r.includes(m) && m.length >= 3) || (m.includes(r) && r.length >= 3)) {
        best = Math.max(best, 25);
      }
    }
  }
  return best;
}

// 候选名变体标记：inst/伴奏/カラオケ 类在源无同标时是另一类内容（硬拒）；
// Live/remix/ver. 类在源无同标时是版本错位（−10 降权不判死）
const CAND_INST_RE = /\b(?:inst(?:rumental)?s?|off[\s-]?vocal|karaoke)\b|伴奏|カラオケ/i;
const CAND_LIVE_RE = /\blive\b|\bremix\b|\bver\.?\d*\b|\bversion\b|现场|演唱会/i;

// song: cloudsearch 原始条目 {id,name,ar|artists,al|album,dt|duration}
// 返回 {score, feats:{title,artist,dur,penalty,durDiff,artistNeutral},
//       reject, rejectKind:'dur'|'marker'}
function scoreCandidate(song, src) {
  const feats = { title: 0, artist: 0, dur: 0, penalty: 0, durDiff: null, artistNeutral: false };
  const candName = String(song?.name || '');
  const candNorm = normToken(candName);
  const candStrip = normToken(stripBrackets(candName));
  const titles = (Array.isArray(src?.titles) ? src.titles : [])
    .map(t => String(t || '')).filter(t => t.trim());
  for (const t of titles) {
    const tNorm = normToken(t);
    const tStrip = normToken(stripBrackets(t));
    let best = pairTitleScore(candNorm, tNorm);
    // 任一侧剥除变体参与的配对按 0.9 降权（剥了才像的相似度打折）
    if (candStrip !== candNorm || tStrip !== tNorm) {
      best = Math.max(best, pairTitleScore(candStrip, tStrip) * 0.9);
    }
    best = Math.max(best, jaccardTitleScore(candName, t));
    if (best > feats.title) feats.title = best;
  }
  feats.artist = artistScore(src?.artists, candArtistNames(song), feats);

  const srcDur = Number.isFinite(src?.durationSec) ? src.durationSec : 0;
  const candSec = (Number(song?.dt) || Number(song?.duration) || 0) / 1000;
  if (srcDur > 0 && candSec > 0) {
    feats.durDiff = Math.abs(candSec - srcDur);
    // rejectKind='dur'：时长类硬拒留在 AI 兜底池（长片头视频靠 pick 120s
    // 粗闸救济是设计意图）；'marker' 才整池开除
    if (feats.durDiff > DUR_HARD_GATE_SEC) return { score: 0, feats, reject: true, rejectKind: 'dur' };
    feats.dur = feats.durDiff <= 2 ? 20 : feats.durDiff <= 5 ? 16
      : feats.durDiff <= 15 ? 10 : feats.durDiff <= 30 ? 5 : 2;
  }

  const srcText = titles.join(' ');
  if (CAND_INST_RE.test(candName) && !CAND_INST_RE.test(srcText)) {
    return { score: 0, feats, reject: true, rejectKind: 'marker' };
  }
  if (CAND_LIVE_RE.test(candName) && !CAND_LIVE_RE.test(srcText)) feats.penalty = 10;

  let score = feats.title + feats.artist + feats.dur - feats.penalty;
  // title 证据 <15 = 名几乎不沾边——时长/艺人再合也不能过灰区下沿
  if (feats.title < 15) score = Math.min(score, GRAY_SCORE - 1);
  // 中立艺人分配非精确 title：同名异曲在艺人信息缺位时没有反证，互含
  // title 45 + 中立 15 + 时长近 16 = 76 能越过确定性线——压到灰区下；
  // 候选仍在已见集里，AI 兜底挑回的路留着
  if (feats.artistNeutral && feats.title < 50) score = Math.min(score, GRAY_SCORE - 1);
  return { score: Math.max(0, Math.round(score)), feats, reject: false };
}

module.exports = {
  scoreCandidate, normToken, noiseKey, stripBrackets, foldCjkCompat, QUERY_NOISE,
  ACCEPT_SCORE, GRAY_SCORE, DUR_HARD_GATE_SEC,
};
