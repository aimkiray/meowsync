// lib/qq.js 搜索系端点钉板（上游全经 globalThis.fetch 桩截断，无网络）：
//   searchSongs     — soso p/totalnum 分页契约 + shc/musicu 三层兜底
//                     （musicu page_num/meta.sum），publishTime 双源归一
//   searchPlaylists — client_music_search_songlist 的 sum/dissid/imgurl/
//                     creator.name/song_count/listennum → PlaylistGrid 卡
//   searchSuggest   — smartbox_new → NetEase search_suggest 归一形态
//   getHotkeys      — gethotkey → search_hot 归一形态（special_key 主推位）
//   normalizeTrack  — publishTime 数值秒/毫秒/ISO/缺席四形态
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpDataDir } from './helpers.mjs';

process.env.DATA_DIR = tmpDataDir('meowsync-qq-search-');
const require = createRequire(import.meta.url);

let qq;
const realFetch = globalThis.fetch;
let fetchImpl = async () => { throw new Error('未桩 fetch'); };
const calls = []; // {url, body}——分页参数/信封断言用
before(() => {
  globalThis.fetch = (u, o) => { calls.push({ url: String(u), body: o?.body }); return fetchImpl(u, o); };
  qq = require('../src/server/lib/qq.js');
});
after(() => {
  globalThis.fetch = realFetch;
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const J = (body) => ({ ok: true, status: 200, json: async () => body });

// soso 旧式命名项（实机钉字段族：songmid/songname/singer[]/albumname/
// albummid/interval/strMediaMid/pay；pubtime 是 unix 秒——青花瓷实测
// 1193932800 = 2007-11-01T00:00:00Z）
const SOSO_SONG = {
  songmid: '002qU5aY3Qu24y', songid: 410316, songname: '青花瓷',
  singer: [{ name: '周杰伦' }], albumname: '我很忙', albummid: '002eF507mX5LlY',
  interval: 211, strMediaMid: 'mm1',
  pay: { pay_play: 0, time_free: 0 },
  pubtime: 1193932800,
};
// musicu 新式命名项（mid/name/singer[]/album{}/file.media_mid；time_public
// 是 ISO 串形态——另一种上游实测回 unix 秒数字，归一两种都要吃）
const MUSICU_SONG = {
  mid: '002NEWsong00X1', id: 9, name: '新曲',
  singer: [{ name: '周某' }], album: { name: '专', mid: 'am01' },
  interval: 200, file: { media_mid: 'mm2' },
  time_public: '2007-11-01T00:00:00+08:00',
};

test('searchSongs：soso 首跳命中——p/n 进 URL、totalnum→total、pubtime→publishTime', async () => {
  calls.length = 0;
  fetchImpl = async (u) => {
    assert.match(String(u), /c\.y\.qq\.com\/soso\/fcgi-bin\/search_for_qq_cp/);
    return J({ code: 0, data: { song: { totalnum: 600, curpage: 2, curnum: 5, list: [SOSO_SONG] } } });
  };
  const r = await qq.searchSongs('青花瓷', { limit: 5, page: 2 });
  assert.equal(calls.length, 1); // 首跳命中——shc/musicu 不再发
  assert.match(calls[0].url, /[?&]n=5&p=2&/);
  assert.equal(r.total, 600);
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].mid, '002qU5aY3Qu24y');
  assert.equal(r.list[0].name, '青花瓷');
  assert.equal(r.list[0].publishTime, 1193932800000); // 秒 ×1000 → epoch ms
});

test('searchSongs：soso+shc 双跳全灭 → musicu 兜底（page_num 透传 + meta.sum→total + time_public ISO→publishTime）', async () => {
  calls.length = 0;
  fetchImpl = async (u) => {
    const s = String(u);
    if (s.includes('search_for_qq_cp')) throw new Error('风控空回'); // c.y/shc 两跳同路径不同宿主
    if (s.includes('musicu.fcg')) {
      return J({ code: 0, req_1: { code: 0, data: { body: { song: { list: [MUSICU_SONG] } }, meta: { sum: 0 } } } });
    }
    throw new Error('unexpected ' + s);
  };
  const r = await qq.searchSongs('x', { limit: 5, page: 3 });
  assert.equal(calls.length, 3); // soso + shc + musicu 三层
  const param = JSON.parse(calls[2].body).req_1.param;
  assert.equal(param.page_num, 3); // 页码直透上游字段
  assert.equal(r.total, 0); // 匿名空桶 sum=0 是合法 0 而非缺省——直透
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].publishTime, Date.parse('2007-11-01T00:00:00+08:00'));
});

test('searchSongs：totalnum 缺席/脏 → total=null（深挖键灭灯语义）', async () => {
  fetchImpl = async () => J({ code: 0, data: { song: { list: [SOSO_SONG] } } }); // 无 totalnum
  const r = await qq.searchSongs('x', {});
  assert.equal(r.total, null);
});

test('searchSongs：健康空结果（code=0 + 空 list）不回落下一跳——真空搜索不白打上游', async () => {
  calls.length = 0;
  fetchImpl = async () => J({ code: 0, data: { song: { totalnum: 0, list: [] } } });
  const r = await qq.searchSongs('不存在的词xyz', { limit: 5 });
  assert.equal(calls.length, 1); // soso 空答已是终局——shc/musicu 都不发
  assert.deepEqual(r.list, []);
  assert.equal(r.total, 0);      // totalnum=0 是合法 0 不是缺省
});

test('searchSongs：soso 挂 → shc 兜底成功（H5 口径 {list,total} 同形）', async () => {
  calls.length = 0;
  fetchImpl = async (u) => {
    const s = String(u);
    if (s.includes('musicu.fcg')) throw new Error('musicu 不该被调——shc 已命中');
    if (s.includes('shc.y.qq.com')) {
      return J({ code: 0, data: { song: { totalnum: 7, list: [SOSO_SONG] } } });
    }
    throw new Error('风控空回'); // c.y 桌面首跳
  };
  const r = await qq.searchSongs('x', { limit: 5, page: 2 });
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /shc\.y\.qq\.com/);
  assert.equal(r.list[0].mid, '002qU5aY3Qu24y');
  assert.equal(r.total, 7);
});

test('searchSongs：shc 健康空（code=0 + []）同样不触 musicu', async () => {
  calls.length = 0;
  fetchImpl = async (u) => {
    const s = String(u);
    if (s.includes('musicu.fcg')) throw new Error('musicu 不该被调');
    if (s.includes('shc.y.qq.com')) return J({ code: 0, data: { song: { totalnum: 0, list: [] } } });
    throw new Error('风控空回');
  };
  const r = await qq.searchSongs('x', {});
  assert.equal(calls.length, 2);
  assert.deepEqual(r.list, []);
  assert.equal(r.total, 0);
});

test('searchPlaylists：sum→total + 歌单卡字段归一（协议相对 imgurl 补 https:）', async () => {
  calls.length = 0;
  fetchImpl = async (u) => {
    assert.match(String(u), /client_music_search_songlist/);
    return J({
      code: 0, data: {
        sum: 46689, list: [{
          dissid: '7097197259', dissname: '催专累了',
          imgurl: '//y.gtimg.cn/music/photo/x.jpg', // 协议相对——实测形态
          creator: { name: '念安娜' }, song_count: 108, listennum: 91998486,
        }],
      },
    });
  };
  const r = await qq.searchPlaylists('周杰伦', { page: 2, limit: 3 });
  assert.match(calls[0].url, /[?&]page_no=2&num_per_page=3&/);
  assert.equal(r.total, 46689);
  const c = r.playlists[0];
  assert.equal(c.id, 'local_pl_qq_7097197259'); // 导入壳同源 id——点卡即导入收敛同一库行
  assert.equal(c.disstid, '7097197259');
  assert.equal(c.name, '催专累了');
  assert.equal(c.coverImgUrl, 'https://y.gtimg.cn/music/photo/x.jpg');
  assert.deepEqual(c.creator, { nickname: '念安娜' });
  assert.equal(c.trackCount, 108);
  assert.equal(c.playCount, 91998486);
  assert.equal(c.provider, 'qq');
});

test('searchPlaylists：上游 code≠0 抛错（路由据此 502）', async () => {
  fetchImpl = async () => J({ code: -1 });
  await assert.rejects(() => qq.searchPlaylists('x', {}), /code=-1/);
});

test('searchSuggest：smartbox → 网易 search_suggest 形态（allMatch 合成 + 三实体组）', async () => {
  calls.length = 0;
  fetchImpl = async (u) => {
    assert.match(String(u), /smartbox_new\.fcg/);
    return J({
      code: 0, data: {
        song: { itemlist: [{ name: '青花瓷', singer: '周杰伦' }], count: 4 },
        singer: { itemlist: [{ name: '马吟吟', singer: '马吟吟' }] },
        album: { itemlist: [{ name: '青花瓷(戏腔版)', singer: '张曦匀' }] },
        mv: { itemlist: [] },
      },
    });
  };
  const r = await qq.searchSuggest('青花瓷');
  assert.match(calls[0].url, /[?&]key=%E9%9D%92%E8%8A%B1%E7%93%B7/);
  // allMatch 由单曲项「名 - 艺人」合成——与 songs[].name 字面不同才有增量
  assert.equal(r.allMatch[0].keyword, '青花瓷 - 周杰伦');
  assert.deepEqual(r.songs[0], { name: '青花瓷', artists: [{ name: '周杰伦' }] });
  assert.deepEqual(r.artists[0], { name: '马吟吟' });
  assert.deepEqual(r.albums[0], { name: '青花瓷(戏腔版)', artist: { name: '张曦匀' } });
});

test('getHotkeys：hotkey.k→hots[].first；special_key 空白修剪不插首、非空插首', async () => {
  fetchImpl = async () => J({
    code: 0, data: {
      hotkey: [{ k: '我们的歌', n: 1 }, { k: '周杰伦', n: 2 }],
      special_key: ' ', // 实测常态是空白格占位
    },
  });
  let r = await qq.getHotkeys();
  assert.deepEqual(r.hots, [{ first: '我们的歌' }, { first: '周杰伦' }]);

  fetchImpl = async () => J({
    code: 0, data: { hotkey: [{ k: 'a' }], special_key: '主推词' },
  });
  r = await qq.getHotkeys();
  assert.deepEqual(r.hots, [{ first: '主推词' }, { first: 'a' }]);
});

test('getHotkeys：special_key 与 hotkey 项重复时去重——不产双份置顶', async () => {
  fetchImpl = async () => J({
    code: 0, data: { hotkey: [{ k: '主推词' }, { k: '周杰伦' }], special_key: ' 主推词 ' },
  });
  const r = await qq.getHotkeys();
  assert.deepEqual(r.hots, [{ first: '主推词' }, { first: '周杰伦' }]);
});

test('normalizeTrack publishTime：秒×1000 / 已是毫秒直吃 / ISO / 缺席与脏值不留键', async () => {
  const base = { songmid: 'x0000000001', songname: 't', singer: [] };
  assert.equal(qq.normalizeTrack({ ...base, pubtime: 1193932800 }).publishTime, 1193932800000);
  assert.equal(qq.normalizeTrack({ ...base, time_public: 1700000000000 }).publishTime, 1700000000000);
  assert.equal(qq.normalizeTrack({ ...base, time_public: '2007-11-01T00:00:00+08:00' }).publishTime,
    Date.parse('2007-11-01T00:00:00+08:00'));
  assert.ok(!('publishTime' in qq.normalizeTrack(base)));
  assert.ok(!('publishTime' in qq.normalizeTrack({ ...base, pubtime: 0 })));
  // 裸年串按数值口径 <1e8 归 null——不下发 1970 假日期
  assert.ok(!('publishTime' in qq.normalizeTrack({ ...base, time_public: '2007' })));
  assert.ok(!('publishTime' in qq.normalizeTrack({ ...base, time_public: 'not-a-date' })));
});

test('normalizeTrack publishTime：pubtime 脏/负不盖 time_public——两源各过一道归一', async () => {
  const base = { songmid: 'x0000000002', songname: 't', singer: [] };
  // pubtime 负/脏串是 truthy——`s.pubtime || s.time_public` 形态下会短路成
  // 唯一归一源把合法的 time_public 拖下水；按源各过一道 pubMsOf 才能救回
  assert.equal(
    qq.normalizeTrack({ ...base, pubtime: -5, time_public: '2007-11-01T00:00:00+08:00' }).publishTime,
    Date.parse('2007-11-01T00:00:00+08:00'));
  assert.equal(
    qq.normalizeTrack({ ...base, pubtime: 'dirty', time_public: 1193932800 }).publishTime,
    1193932800000);
  // 数字串形态的 pubtime 按秒吃；负数与 0 归无键
  assert.equal(qq.normalizeTrack({ ...base, pubtime: '1193932800' }).publishTime, 1193932800000);
  assert.ok(!('publishTime' in qq.normalizeTrack({ ...base, pubtime: -5 })));
  assert.ok(!('publishTime' in qq.normalizeTrack({ ...base, pubtime: '-5' })));
  // 空格分隔日期串（实机另一形态）走 Date.parse 同径
  assert.equal(qq.normalizeTrack({ ...base, time_public: '2007-11-01 08:00:00' }).publishTime,
    Date.parse('2007-11-01 08:00:00'));
});
