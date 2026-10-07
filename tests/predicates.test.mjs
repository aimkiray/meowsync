// shared/predicates.js 回归网——前后端谓词口径漂移历史 bug 的固定网
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SONGMID_RE, isSongmidLike, isNeteasePlaylist, NETEASE_ID_RE,
  BVID_RE, BVID_IN_TEXT_RE, isBilibiliInput,
  SINGLE_SONG_PREFIX, SAVED_QUEUE_PREFIX, MIRROR_PLAYLIST_ID_RE,
  isLocalPlaylistId, isEphemeralPlaylistId, isSingleSongShellId,
  parseNumericId, extractYouTubeId, isYouTubeInput,
  isQQInput, pickQqFromUrl, extractQQPlaylistId, extractNeteaseSongId,
  extractBiliFavlistId, extractYouTubePlaylistId, isLikelyChineseLyric
} from '../src/shared/predicates.js';

test('songmid：QQ songmid 形态', () => {
  assert.ok(SONGMID_RE.test('0031sbUK1c0Oav'));
  assert.ok(isSongmidLike('004Z8Ihr0JIu5s'));
  assert.ok(!isSongmidLike('abc'));         // 太短
  assert.ok(!isSongmidLike('186016'));      // 纯数字是网易云 id
});

test('BV：12 位全形态；11 位是非法', () => {
  assert.ok(BVID_RE.test('BV1GJ411x7h7'));
  assert.ok(!BVID_RE.test('BV1G411x7h7'));  // 11 位——曾把前端测试值写错的形态
  // qq 域/qqmusic scheme/qq: 前缀内的 BV 形 songmid 不得被 B 站抢走
  assert.ok(isBilibiliInput('BV1GJ411x7h7'));
  assert.ok(!isBilibiliInput('https://y.qq.com/n/ryqq/songDetail/BV1GJ411x7h7'));
  assert.ok(!isBilibiliInput('qq:BV1GJ411x7h7'));
});

test('B 站收藏夹链识别：favlist?fid= / medialist mlN / 裸 mlN', () => {
  assert.equal(extractBiliFavlistId('https://space.bilibili.com/2/favlist?fid=1052622027'), '1052622027');
  assert.equal(extractBiliFavlistId('https://space.bilibili.com/2/favlist?fid=1&type=create'), '1');
  assert.equal(extractBiliFavlistId('https://www.bilibili.com/medialist/detail/ml1052622027'), '1052622027');
  assert.equal(extractBiliFavlistId('https://www.bilibili.com/medialist/play/ml1052622027?business=space'), '1052622027');
  // /list/mlN 连播页（canonical）+ medialist 播放页带 bvid 参数（复制地址栏常态形态）
  assert.equal(extractBiliFavlistId('https://www.bilibili.com/list/ml1052622027'), '1052622027');
  assert.equal(extractBiliFavlistId('https://www.bilibili.com/medialist/play/ml1052622027?bvid=BV1GJ411x7h7'), '1052622027');
  assert.equal(extractBiliFavlistId('ml1052622027'), '1052622027');
  // 裸 mlN 收 6+ 位——短形态更像搜索词不抢
  assert.equal(extractBiliFavlistId('ml12345'), null);
  // 通用 fid 参数不带 favlist 语境不抢；非 B 站域的 favlist 同不抢
  assert.equal(extractBiliFavlistId('https://weibo.com/u/page?fid=12345'), null);
  assert.equal(extractBiliFavlistId('https://example.com/favlist?fid=12345'), null);
  // 视频链不判成收藏夹；句中混进的 ml 字样不算
  assert.equal(extractBiliFavlistId('https://www.bilibili.com/video/BV1GJ411x7h7'), null);
  assert.equal(extractBiliFavlistId('看看这个 ml123 的视频'), null);
});

test('YouTube 歌单链识别：playlist?list= / watch?v=&list= / 裸前缀 id', () => {
  assert.equal(extractYouTubePlaylistId('https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'), 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
  assert.equal(extractYouTubePlaylistId('https://music.youtube.com/playlist?list=OLAK5uy_kmHwGkLQNnKBKjAYRHYd-LFNpKPnMxpo'), 'OLAK5uy_kmHwGkLQNnKBKjAYRHYd-LFNpKPnMxpo');
  // 复合链的歌单语境优先（与 favlist 同口径）
  assert.equal(extractYouTubePlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ'), 'RDdQw4w9WgXcQ');
  assert.equal(extractYouTubePlaylistId('https://youtu.be/dQw4w9WgXcQ?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'), 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
  // 裸前缀 id（≥11 位后缀）
  assert.equal(extractYouTubePlaylistId('PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'), 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
  // 非 YouTube 域的 list= 不抢；短裸 id 更像搜索词不抢
  assert.equal(extractYouTubePlaylistId('https://example.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf'), null);
  assert.equal(extractYouTubePlaylistId('PL123'), null);
  // 纯视频链不判成歌单；11 位裸视频 id 不撞前缀形态
  assert.equal(extractYouTubePlaylistId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(extractYouTubePlaylistId('dQw4w9WgXcQ'), null);
  // 裸形态不大小写容忍——'tldr-weekly-01'/'fluffy-kitten' 型搜索词不劫
  assert.equal(extractYouTubePlaylistId('plrAXtmErZgOeiKm4sgNOknGvNjby9efdf'), null);
  assert.equal(extractYouTubePlaylistId('tldr-weekly-01'), null);
  assert.equal(extractYouTubePlaylistId('fluffy-kitten'), null);
});

test('播放列表 id 三族：网易云数字 / local_pl_ / saved_queue_', () => {
  // isNeteasePlaylist 收歌单对象（.id 是纯数字才算网易云远端单）
  assert.ok(isNeteasePlaylist({ id: '7014347621' }));
  assert.ok(isNeteasePlaylist({ id: 12345 }));
  assert.ok(!isNeteasePlaylist({ id: 'local_pl_x' }));
  assert.ok(!isNeteasePlaylist('7014347621')); // 裸 id 传进来是误用
  assert.ok(MIRROR_PLAYLIST_ID_RE.test('local_pl_abc'));
  assert.ok(MIRROR_PLAYLIST_ID_RE.test('saved_queue_xyz'));
  assert.ok(!MIRROR_PLAYLIST_ID_RE.test('7014347621'));
  assert.ok(isLocalPlaylistId('local_pl_abc'));
  assert.ok(isEphemeralPlaylistId('single_song_123'));
  assert.ok(isSingleSongShellId(`${SINGLE_SONG_PREFIX}qq_0031sbUK1c0Oav`));
  assert.ok(!isSingleSongShellId(`${SAVED_QUEUE_PREFIX}x`));
});

test('parseNumericId：只收纯十进制', () => {
  assert.equal(parseNumericId('186016'), 186016);
  assert.equal(parseNumericId('1e5'), null);
  assert.equal(parseNumericId(' 3'), null);
  assert.equal(parseNumericId('12abc'), null);
  assert.equal(parseNumericId(''), null);
});

test('BVID_IN_TEXT_RE：内嵌提取', () => {
  const m = '看 https://www.bilibili.com/video/BV1GJ411x7h7?t=3'.match(BVID_IN_TEXT_RE);
  assert.equal(m?.[0], 'BV1GJ411x7h7');
  assert.ok(NETEASE_ID_RE.test('186016'));
});

test('parseNumericId 边界：0/前导零/超大/空', () => {
  assert.equal(parseNumericId('0'), null);       // id 须 >0
  assert.equal(parseNumericId('007'), 7);        // 前导零归一（与路由导入一致口径）
  assert.equal(parseNumericId('9'.repeat(30)), null); // 超 safeInteger
  assert.equal(parseNumericId(null), null);
});

test('extractYouTubeId：URL 形态表 + 裸 id 歧义守卫', () => {
  assert.equal(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x'), 'dQw4w9WgXcQ');
  assert.equal(extractYouTubeId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');       // 裸 id 含字母→收
  assert.equal(extractYouTubeId('12345678901'), null);               // 纯数字 11 位与网易云 id 撞型→拒
  assert.equal(extractYouTubeId('lofi beats'), null);
  // isYouTubeInput 只认 URL 形态——裸 id 必须拼 youtu.be（搜索词不误伤）
  assert.ok(isYouTubeInput('https://youtu.be/dQw4w9WgXcQ'));
  assert.ok(!isYouTubeInput('dQw4w9WgXcQ'));
});

test('isQQInput / pickQqFromUrl / extractQQPlaylistId', () => {
  assert.ok(isQQInput('https://y.qq.com/n/ryqq/songDetail/004Z8Ihr0JIu5s'));
  assert.ok(isQQInput('qqmusic://qq.com/song?p=x'));
  assert.ok(!isQQInput('qq:billieeilish'));          // qq: 是搜索前缀不是链接
  assert.ok(!isQQInput('https://y.qq.com/n/ryqq/playlist/7014347621')); // 歌单走歌单分支
  assert.deepEqual(pickQqFromUrl('https://y.qq.com/n/ryqq/songDetail/004Z8Ihr0JIu5s'), { mid: '004Z8Ihr0JIu5s' });
  // 歌单优先于内嵌 songmid（playlist?id=N&p={"songmid":...} 形态）
  assert.deepEqual(pickQqFromUrl('https://i.y.qq.com/v8/playsong.html?playlistId=0&p=%7B%22disstid%22%3A%227014%22%7D'), { disstid: '7014' });
  assert.equal(extractQQPlaylistId('https://y.qq.com/n/ryqq/playlist/7014347621'), '7014347621');
  assert.equal(extractQQPlaylistId('https://i.y.qq.com/n2/m/share/details/taoge.html?id=99'), '99');
  assert.equal(extractQQPlaylistId('not a link'), null);
});

test('extractNeteaseSongId：URL/裸数字；?song= 是单曲不是歌单', () => {
  assert.equal(extractNeteaseSongId('https://music.163.com/song?id=186016'), '186016');
  assert.equal(extractNeteaseSongId('https://music.163.com/#/song/186016'), '186016');
  assert.equal(extractNeteaseSongId('?song=186016&view=watch'), '186016');
  assert.equal(extractNeteaseSongId('186016'), '186016');
  assert.equal(extractNeteaseSongId('晴天'), null);
});

// ── isLikelyChineseLyric：汉字占比≥阈 且 假名/谚文占比<阈 双闸 ──
// 少女レイ 实案病灶：日文词汉字密度 30-50% 是常态，单看汉字占比会把
// 假名混排的日文词误判「已是中文」跳过翻译——假名/谚文是「需要翻译」硬证据

test('isLikelyChineseLyric：日文汉字+假名混排判非中文（少女レイ 回归钉）', () => {
  // 实案双行形态：cjk 15/39≈0.385——旧 cjkRatio 口径已越过 0.3 skip 线
  // 被判「已是中文」跳过翻译；假名闸（foreign 0.615 ≫ 0.05）必须拦下
  assert.equal(isLikelyChineseLyric(
    '本能が狂い始める 追い詰められたハツカネズミ\n'
    + '今 絶望の淵に立って 踏切へと飛び出した'), false);
  // 单行同款混排（cjk≈0.29）——阈值上下都判非中文，不只压线才拦
  assert.equal(isLikelyChineseLyric('本能が狂い始める 追い詰められたハツカネズミ'), false);
  // cjk 越线的短混排（3/9≈0.33）同样拦下
  assert.equal(isLikelyChineseLyric('言葉にできない想い'), false);
  // 全假名日文词
  assert.equal(isLikelyChineseLyric('ありがとう さようなら'), false);
});

test('isLikelyChineseLyric：纯中文/中文夹英文 hook 判中文', () => {
  assert.equal(isLikelyChineseLyric('我看过沙漠下暴雨 看过大海亲吻鲨鱼'), true);
  // 拉丁不构成豁免——中文为主体夹英文 hook 仍是中文语境（不送翻译）
  assert.equal(isLikelyChineseLyric('你是我的唯一 stay with me 永远不分离'), true);
});

test('isLikelyChineseLyric：韩文/日文罗马音/纯英文判非中文', () => {
  assert.equal(isLikelyChineseLyric('사랑해요 그대를 영원히'), false);        // 谚文
  assert.equal(isLikelyChineseLyric('honnou ga kurui hajimeru'), false);      // 罗马音
  assert.equal(isLikelyChineseLyric('hello world goodbye sky'), false);       // 纯英文
});

test('isLikelyChineseLyric：半角片假名混排判非中文（kana 含 U+FF66-FF9F 块）', () => {
  // 汉字+半角片假名——半角形态是日语硬证据零中文歧义（EUC-JP 时代/旧
  // 携帯系歌词库实存形态）；半角浊点 ﾞﾟ 一并计 kana
  assert.equal(isLikelyChineseLyric('本能ｶﾞ狂ｲ始ﾒﾙ 追ｲ詰ﾒﾗﾚﾀ'), false);
  assert.equal(isLikelyChineseLyric('漢字ｶﾀｶﾅ混排'), false);
  // ﾊﾟﾋﾟﾌﾟ 系（假名+半角浊点两字符）同计不漏
  assert.equal(isLikelyChineseLyric('漢漢漢ﾊﾟﾋﾟﾌﾟﾍﾟﾎﾟ'), false);
  // 半角句读/中点（｡･，FF66 之前）是标点不入计数——单放不顶 foreign 闸
  assert.equal(isLikelyChineseLyric('漢字｡漢字･漢字'), true);
});

test('isLikelyChineseLyric：阈值边界与全角/数字混排', () => {
  // cjk 恰在阈值 → 判中文；低一分不判
  assert.equal(isLikelyChineseLyric('汉汉汉abcdefg'), true);    // 3/10 = 0.3
  assert.equal(isLikelyChineseLyric('汉汉abcdefgh'), false);    // 2/10 = 0.2
  // foreign 恰在阈值 → 判非中文（严格 <）——装饰性「の」也是硬证据
  assert.equal(isLikelyChineseLyric('汉'.repeat(19) + 'の'), false);  // 1/20 = 0.05
  assert.equal(isLikelyChineseLyric('汉'.repeat(20) + 'の'), true);   // 1/21 < 0.05
  // 数字/全角字母/标点不入四类分母——不稀释判定
  assert.equal(isLikelyChineseLyric('第１２３章 我们的故事！！！'), true);
  assert.equal(isLikelyChineseLyric('私の心は１２３ｆｕｌｌ'), false);
  // 空串/纯符号无判定材料 → 非中文（交上游/无词分支处理）
  assert.equal(isLikelyChineseLyric(''), false);
  assert.equal(isLikelyChineseLyric('12345 ！！！'), false);
  // 可调阈值：cjkMin 收紧后同文判非中文；foreignMax 放宽同文判中文
  assert.equal(isLikelyChineseLyric('汉汉汉abc', { cjkMin: 0.6 }), false);   // 0.5 < 0.6
  assert.equal(isLikelyChineseLyric('言葉にできない想い', { foreignMax: 0.7 }), true);
});
