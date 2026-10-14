// repositories 层回归网——孤儿表收口后的 SQL 语义固定
// DATA_DIR 指向临时目录，db/client 首次 require 时在该处建库跑迁移
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-test-');
const require = createRequire(import.meta.url);

let songMetaRepo, lyricAiRepo, playlistsRepo, downloadQueuesRepo, downloadTasksRepo, songMatchRepo;
before(() => {
  songMetaRepo = require('../src/server/repositories/songLyricMeta.js');
  lyricAiRepo = require('../src/server/repositories/lyricAi.js');
  playlistsRepo = require('../src/server/repositories/playlists.js');
  downloadQueuesRepo = require('../src/server/repositories/downloadQueues.js');
  downloadTasksRepo = require('../src/server/repositories/downloadTasks.js');
  songMatchRepo = require('../src/server/repositories/songMatch.js');
});

test('songLyricMeta：0/缺省行语义一致、upsert 覆盖、delete 归零', () => {
  assert.equal(songMetaRepo.getOffsetMs('s-none'), 0);      // 无行=未校准
  songMetaRepo.upsertOffsetMs('s1', 120);
  assert.equal(songMetaRepo.getOffsetMs('s1'), 120);
  songMetaRepo.upsertOffsetMs('s1', -40);                  // 覆盖
  assert.equal(songMetaRepo.getOffsetMs('s1'), -40);
  songMetaRepo.deleteOffsetMs('s1');
  assert.equal(songMetaRepo.getOffsetMs('s1'), 0);
});

test('lyricAi 翻译缓存：upsert 命中、skip 哨兵行存在', () => {
  assert.equal(lyricAiRepo.getCachedTranslation('no-such'), undefined); // better-sqlite3 无行回 undefined
  lyricAiRepo.upsertTranslation('song-a', '[00:01.00]译词', 'm-test');
  // AI 译文按模型键控——模型不符不命中（换模型后旧译文不失效是 D6 要修的洞）
  assert.equal(lyricAiRepo.getCachedTranslation('song-a', 'other-model'), undefined);
  const hit = lyricAiRepo.getCachedTranslation('song-a', 'm-test');
  assert.equal(hit.tlyric, '[00:01.00]译词');
  // 官方译文行（netease/qq）永命中——不随模型键漂移
  lyricAiRepo.upsertTranslation('song-o', '[00:01.00]官方', 'netease');
  assert.equal(lyricAiRepo.getCachedTranslation('song-o', 'whatever').tlyric, '[00:01.00]官方');
  // skip 哨兵：tlyric 空串——行在但词空（防重复打上游），TTL 语义在路由层
  lyricAiRepo.markTranslationSkip('song-b', 'already-zh');
  const skip = lyricAiRepo.getCachedTranslation('song-b');
  assert.ok(skip);
  assert.equal(skip.tlyric, '');
});

test('lyricAi 盐键扩展：裸模型读点命中 <模型>@<版本> 行；异模/旧盐不命中', () => {
  // 写侧（路由/下载链）按 translationModelKey 落 '<模型>@<版本>' 盐键；
  // file-downloader 单参读点只传裸模型——持久层把裸模型扩成
  // 「裸键逐字 + 当前盐键」双查收口。突变钉：删掉第二个 OR model=? 盐键
  // 子句后首个断言即转红
  const salted = lyricAiRepo.translationModelKey('m');   // 当前 'm@t1'
  lyricAiRepo.upsertTranslation('song-salt', '[00:01.00]盐词', salted);
  // 裸模型读点（下载链口径）→ 扩成当前盐键命中本版行
  assert.equal(lyricAiRepo.getCachedTranslation('song-salt', 'm').tlyric, '[00:01.00]盐词');
  // 盐键直传（路由口径）→ 第一参逐字命中
  assert.equal(lyricAiRepo.getCachedTranslation('song-salt', salted).tlyric, '[00:01.00]盐词');
  // 异模不命中——'m2' 扩成 'm2@t1'，两个键都不是 'm@t1'
  assert.equal(lyricAiRepo.getCachedTranslation('song-salt', 'm2'), undefined);
  // 旧盐版本不命中——'m@t0' 逐字≠'m@t1'，再扩成 'm@t0@t1' 也不中
  assert.equal(lyricAiRepo.getCachedTranslation('song-salt', 'm@t0'), undefined);
  // 盐前存量行（裸 model 落库）对裸模型读点仍命中——双查第一参逐字面
  lyricAiRepo.upsertTranslation('song-legacy', '[00:01.00]旧词', 'm');
  assert.equal(lyricAiRepo.getCachedTranslation('song-legacy', 'm').tlyric, '[00:01.00]旧词');
  // skip:* 哨兵与官方译文行不吃盐——确定性状态/词源事实与 prompt 版本无关
  lyricAiRepo.markTranslationSkip('song-saltskip', 'no-lyric');
  assert.ok(lyricAiRepo.getCachedTranslation('song-saltskip', 'whatever'));
  lyricAiRepo.upsertTranslation('song-saltqq', '[00:01.00]官译', 'qq');
  assert.equal(lyricAiRepo.getCachedTranslation('song-saltqq', 'm@t0').tlyric, '[00:01.00]官译');
});

test('lyricAi 判定缓存：vkey 键隔离、ok/detail 往返', () => {
  assert.equal(lyricAiRepo.getLyricVerdict('v-none'), undefined);
  lyricAiRepo.upsertLyricVerdict('id@m1@sig1', false, '错配示例');
  const v = lyricAiRepo.getLyricVerdict('id@m1@sig1');
  assert.equal(v.ok, 0);            // sqlite 无 bool——0/1 落列，路由层转布尔
  // detail 是写侧诊断列——getLyricVerdict 只 SELECT ok（读面不回诊断文本）
  lyricAiRepo.upsertLyricVerdict('id@m2@sig1', true, null); // 不同模型/来源=不同键
  assert.equal(lyricAiRepo.getLyricVerdict('id@m2@sig1').ok, 1);
});


test('downloadQueues：neteasePlaylistId 透出（?view=downloads&pl= 深链映射承重列）', () => {
  // 深链按"侧栏歌单 id === 队列 neteasePlaylistId"匹配——镜像单存 local_pl_*
  // 原文、远端单存数字串；投影缺失/改名会让整链静默全灭，这里钉住
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_test_x', name: '镜像单' });
  const q = downloadQueuesRepo.createQueue({ playlistId: pl.id, name: 'q', totalTasks: 0 });
  assert.equal(q.neteasePlaylistId, 'local_pl_test_x');
  assert.equal(downloadQueuesRepo.findQueueById(q.id).neteasePlaylistId, 'local_pl_test_x');
  assert.equal(downloadQueuesRepo.listQueues().find(x => x.id === q.id).neteasePlaylistId, 'local_pl_test_x');
  // 数字侧栏 id 与 TEXT 列同形落库（String 归一在消费侧，存储层原样透传）
  const plNum = playlistsRepo.upsertPlaylist({ neteasePlaylistId: '777014', name: '远端单' });
  const qNum = downloadQueuesRepo.createQueue({ playlistId: plNum.id, name: 'qn', totalTasks: 0 });
  assert.equal(String(qNum.neteasePlaylistId), '777014');
});

test('downloadTasks：listStandaloneTasksByPlaylist 只收 queue_id NULL 行', () => {
  // 「未入队单曲」分节的服务端收窄面——收养语义靠这口闸：建队列 UPDATE
  // queue_id 后行掉出 standalone 集，混入即越权展示
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_std_x', name: 'std' });
  const q = downloadQueuesRepo.createQueue({ playlistId: pl.id, name: 'q', totalTasks: 0 });
  const lone = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: null, songId: 's-lone', songName: '独立', artist: 'a'
  });
  const queued = downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: q.id, songId: 's-queued', songName: '入队', artist: 'a'
  });
  const out = downloadTasksRepo.listStandaloneTasksByPlaylist(pl.id);
  assert.deepEqual(out.map(t => t.songId), ['s-lone']);
  // 收养后行掉出集（findAnyTaskByPlaylistAndSongId 的收养写 queueId=新值）
  downloadTasksRepo.updateTask(lone.id, { queueId: q.id });
  assert.equal(downloadTasksRepo.listStandaloneTasksByPlaylist(pl.id).length, 0);
  assert.equal(queued.queueId, q.id);
});

test('downloadTasks.countTasksByQueueAndStatus：脏 status 键不污染结果对象', () => {
  // status 列是 TEXT 无 CHECK——脏行（手工改库/历史遗留）可写任意字符串。
  // 结果对象只回填预置四键；'constructor' 这类键不得落成 own 属性混进
  // JSON 透出面（裸赋值会把原型键名写进响应）
  const pl = playlistsRepo.upsertPlaylist({ neteasePlaylistId: 'local_pl_dirtyst', name: 'dirty' });
  const q = downloadQueuesRepo.createQueue({ playlistId: pl.id, name: 'q', totalTasks: 0 });
  downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: q.id, songId: 'd-dirty', songName: 'n', artist: 'a',
    status: 'constructor'
  });
  downloadTasksRepo.createTask({
    playlistId: pl.id, queueId: q.id, songId: 'd-ok', songName: 'n', artist: 'a',
    status: 'completed'
  });
  const counts = downloadTasksRepo.countTasksByQueueAndStatus(q.id);
  assert.deepEqual(counts, { pending: 0, downloading: 0, completed: 1, failed: 0 });
  assert.equal(Object.hasOwn(counts, 'constructor'), false);
  assert.equal(Object.getPrototypeOf(counts), Object.prototype);
});

// ── songMatch 跨会话否决簿（vetoed_json）──────────────────────────
// 「(源,候选) 判否不经任何路径复活」的持久账：条目 [{id,m,t}]、m 键控
// 过滤（'' 永生效）、cap 50 按 t 降序挤出、stub 行不作缓存命中、
// upsert/updated_at 语义不受否决簿污染

test('songMatch 否决簿：merge→getVetoedIds 往返、model 键控过滤、复否不增条目', () => {
  songMatchRepo.mergeVetoed('vm_1', ['100', '200'], 'm1');
  songMatchRepo.mergeVetoed('vm_1', [300], '');            // 数字 id 归一成 String
  // currentModel='m1'：'' 与 m1 条目都生效
  assert.deepEqual([...songMatchRepo.getVetoedIds('vm_1', 'm1')].sort(), ['100', '200', '300']);
  // currentModel=''：仅 '' 条目生效——m1 否决换模后不参与过滤（verdict 同口径）
  assert.deepEqual([...songMatchRepo.getVetoedIds('vm_1', '')], ['300']);
  assert.deepEqual([...songMatchRepo.getVetoedIds('vm_1', 'other')], ['300']);
  // 同 (id,m) 复否只刷 t 不增条目；'' 到来同化同 id 异模影子——簿内
  // 同 id 至多一条生效条目（'' 覆盖全模型；影子凭新 t 会在 cap 截断时
  // 把 '' 永生效条目先挤出，换模后否决整组蒸散）
  songMatchRepo.mergeVetoed('vm_1', ['100'], 'm1');
  songMatchRepo.mergeVetoed('vm_1', ['100'], '');          // '' 吞并 (100,m1)
  const entries = JSON.parse(songMatchRepo.getMatchRow('vm_1').vetoed_json);
  assert.equal(entries.filter(e => e.id === '100').length, 1);
  assert.equal(entries.find(e => e.id === '100').m, '');
  assert.equal(entries.length, 3);   // (100,'') (200,m1) (300,'')
  // 吞并后 '100' 在任何模型键下都生效（'' 语义）
  assert.ok(songMatchRepo.getVetoedIds('vm_1', 'other').has('100'));
});

test('songMatch 否决簿：cap=50 按 t 降序截断——最旧挤出', () => {
  // t 粒度是 epoch 秒：拨 Date.now 保证先后两批否决的时间戳可分辨
  const realNow = Date.now;
  try {
    songMatchRepo.mergeVetoed('vm_cap', ['stale'], '');
    Date.now = () => realNow() + 60_000;
    songMatchRepo.mergeVetoed('vm_cap',
      Array.from({ length: 50 }, (_, i) => `f${i}`), '');
    const ids = songMatchRepo.getVetoedIds('vm_cap', '');
    assert.equal(ids.size, 50);
    assert.ok(ids.has('f0') && ids.has('f49'));
    assert.ok(!ids.has('stale'));   // 最旧被挤出
  } finally { Date.now = realNow; }
});

test('songMatch：stub 行不命中 getMatch、mergeVetoed 不刷 updated_at、空集不落账', () => {
  // 空集落账=纯写放大——连 stub 行都不产
  songMatchRepo.mergeVetoed('vm_empty', [], '');
  assert.equal(songMatchRepo.getMatchRow('vm_empty'), undefined);
  // 无匹配史纯否决账 → stub 行（netease_id NULL + updated_at=''）：
  // '' 不过负行 freshness 闸，任何模型键下 getMatch 都不命中
  songMatchRepo.mergeVetoed('vm_stub', ['9'], '');
  const stub = songMatchRepo.getMatchRow('vm_stub');
  assert.equal(stub.netease_id, null);
  assert.equal(stub.updated_at, '');
  assert.equal(songMatchRepo.getMatch('vm_stub', ''), undefined);
  assert.equal(songMatchRepo.getMatch('vm_stub', 'm1'), undefined);
  // mergeVetoed 只动 vetoed_json——updated_at 绝不刷（负行 TTL 靠它计时）
  const { getDb } = require('../src/server/db/client.js');
  getDb().prepare("UPDATE song_match SET updated_at = '2000-01-01 00:00:00' WHERE track_id = 'vm_stub'").run();
  songMatchRepo.mergeVetoed('vm_stub', ['10'], '');
  assert.equal(songMatchRepo.getMatchRow('vm_stub').updated_at, '2000-01-01 00:00:00');
});

test('songMatch：upsert 正/负行覆写后 vetoed_json 保留；坏 JSON 归空集', () => {
  songMatchRepo.mergeVetoed('vm_keep', ['7'], '');
  songMatchRepo.upsertMatch('vm_keep', '12345', 'q', 80, 'm1');
  assert.ok(songMatchRepo.getVetoedIds('vm_keep', '').has('7'));   // 正行覆写不动簿
  songMatchRepo.upsertMatch('vm_keep', null, 'q2', null, '');
  assert.ok(songMatchRepo.getVetoedIds('vm_keep', '').has('7'));   // 负行覆写同保留
  // 新行 INSERT 走 DEFAULT '[]'
  songMatchRepo.upsertMatch('vm_fresh', '1', 'q', 1, '');
  assert.equal(JSON.parse(songMatchRepo.getMatchRow('vm_fresh').vetoed_json).length, 0);
  // 坏 JSON 归空簿不炸；mergeVetoed 遇脏重开一簿
  const { getDb } = require('../src/server/db/client.js');
  getDb().prepare("UPDATE song_match SET vetoed_json = 'not-json' WHERE track_id = 'vm_fresh'").run();
  assert.equal(songMatchRepo.getVetoedIds('vm_fresh', '').size, 0);
  songMatchRepo.mergeVetoed('vm_fresh', ['2'], '');
  assert.ok(songMatchRepo.getVetoedIds('vm_fresh', '').has('2'));
});

test('songMatch 否决簿：空模条目吞并异模影子——同 id 至多一条生效条目（双向序）', () => {
  // 病灶原形：(id,'') 在簿再落 (id,'m1') 会 push 冗余影子（带新 t），
  // cap 按 t 降序截断时 '' 永生效条目反被先挤出——换模后该否决蒸散
  const realNow = Date.now;
  try {
    // 序一：(id,'') 在簿再落 (id,'m1')——被吸收为 '' 复否刷 t，影子不增生
    songMatchRepo.mergeVetoed('vm_sh1', ['A'], '');
    Date.now = () => realNow() + 60_000;
    songMatchRepo.mergeVetoed('vm_sh1', ['A'], 'm1');
    const e1 = JSON.parse(songMatchRepo.getMatchRow('vm_sh1').vetoed_json);
    assert.deepEqual(e1.map(x => [x.id, x.m]), [['A', '']]);
    // 吸收的复否语义不落——'' 条目的 t 刷到本次否决时点
    assert.equal(e1[0].t, Math.floor((realNow() + 60_000) / 1000));
    // 序二：先 (id,'m1') 后 (id,'')——'' 到来同化掉同 id 的 m≠'' 条目
    songMatchRepo.mergeVetoed('vm_sh2', ['B'], 'm1');
    songMatchRepo.mergeVetoed('vm_sh2', ['B'], '');
    const e2 = JSON.parse(songMatchRepo.getMatchRow('vm_sh2').vetoed_json);
    assert.deepEqual(e2.map(x => [x.id, x.m]), [['B', '']]);
    // '' 生效面不挑模型键——被吸收方不留残渣
    assert.ok(songMatchRepo.getVetoedIds('vm_sh1', 'whatever').has('A'));
    assert.ok(songMatchRepo.getVetoedIds('vm_sh2', 'whatever').has('B'));
  } finally { Date.now = realNow; }
});

test('songMatch 否决簿：mergeVetoed 读侧回滤畸形条目——缺 id/t 的脏条不占 cap 位', () => {
  // 成形 JSON 但条目畸形（缺 id/缺 t/非对象）：读侧回滤与 getVetoedIds
  // 「缺 id 不生效」同口径——脏条不进合并集、不占 cap 位，重写即清出簿
  const { getDb } = require('../src/server/db/client.js');
  songMatchRepo.mergeVetoed('vm_dirty', ['1'], '');
  getDb().prepare("UPDATE song_match SET vetoed_json = ? WHERE track_id = 'vm_dirty'").run(JSON.stringify([
    { id: '1', m: '', t: 1 },        // 健全条目保留
    { m: '', t: 2 },                 // 缺 id
    { id: '2', m: '' },              // 缺 t
    'junk',                          // 非对象
    { id: '3', m: '', t: 5 },        // 健全条目保留
  ]));
  songMatchRepo.mergeVetoed('vm_dirty', ['9'], '');
  const entries = JSON.parse(songMatchRepo.getMatchRow('vm_dirty').vetoed_json);
  assert.deepEqual(entries.map(x => x.id).sort(), ['1', '3', '9']);
});

test('songMatch：mergeVetoed 落在既有正行上——netease_id/matched_by/score/model/updated_at 全不动', () => {
  // 否决落账只动 vetoed_json：正行身份列与负行 TTL 计时列都不该被
  // merge 触碰（updated_at 刷了会搅浑负行 freshness 语义）
  const { getDb } = require('../src/server/db/client.js');
  songMatchRepo.upsertMatch('vm_pos', '777', 'q-src', 88, 'm1');
  const q = getDb().prepare('SELECT * FROM song_match WHERE track_id = ?');
  const before = q.get('vm_pos');
  songMatchRepo.mergeVetoed('vm_pos', ['9'], 'm1');
  const after = q.get('vm_pos');
  for (const k of ['netease_id', 'matched_by', 'score', 'model', 'updated_at']) {
    assert.equal(after[k], before[k], `${k} 不该被否决落账触碰`);
  }
  assert.ok(songMatchRepo.getVetoedIds('vm_pos', 'm1').has('9'));   // 簿照落
});
