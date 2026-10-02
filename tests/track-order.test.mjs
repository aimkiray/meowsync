// 曲序覆盖层归并 + 歌手聚类的纯函数契约：
// - applyTrackOrder：登记成员按登记序、未登记成员保相对序落尾、陈旧 id 不命中、
//   重复 id 首登记位胜出、空 order 原样返回
// - groupTracksByArtist：同主唱名曲目连续、组间 collator 序（中文拼音/拉丁字母/
//   数字值）、组内稳定保序、无名艺人沉尾
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTrackOrder, groupTracksByArtist, trackArtistGroupKey } from '../src/lib/track-order.js';

const t = (id, artist) => ({ id, name: `s${id}`, ar: [{ name: artist }] });
const ids = (list) => list.map(x => String(x.id));

test('applyTrackOrder 登记成员按覆盖层序排前', () => {
  const list = [t('a'), t('b'), t('c'), t('d')];
  const out = applyTrackOrder(list, ['c', 'a']);
  assert.deepEqual(ids(out), ['c', 'a', 'b', 'd']);
});

test('applyTrackOrder 未登记成员保持原相对序落尾', () => {
  const list = [t('a'), t('b'), t('c'), t('d')];
  const out = applyTrackOrder(list, ['d', 'b']);
  assert.deepEqual(ids(out), ['d', 'b', 'a', 'c']);
});

test('applyTrackOrder 陈旧 id 不命中且不产生洞', () => {
  const list = [t('a'), t('b'), t('c')];
  const out = applyTrackOrder(list, ['gone', 'c', 'a']);
  assert.deepEqual(ids(out), ['c', 'a', 'b']);
});

test('applyTrackOrder 数字/字符串 id 混用归一 + 重复 id 首登记位胜出', () => {
  const list = [t(100), t(200), t(300)];
  const out = applyTrackOrder(list, [300, '100', '300']);
  assert.deepEqual(ids(out), ['300', '100', '200']);
});

test('applyTrackOrder 空/非法 order 原样返回（同引用）', () => {
  const list = [t('a'), t('b')];
  assert.equal(applyTrackOrder(list, []), list);
  assert.equal(applyTrackOrder(list, null), list);
  assert.equal(applyTrackOrder(list, undefined), list);
  assert.equal(applyTrackOrder(null, ['a']), null);
});

test('groupTracksByArtist 同主唱曲目聚成连续块', () => {
  const list = [
    t('1', '周杰伦'), t('2', '薛之谦'), t('3', '周杰伦'), t('4', 'Aimer'), t('5', '薛之谦'),
  ];
  const out = groupTracksByArtist(list);
  // 拉丁组先行（Aimer）；汉字组拼音序 薛之谦(x) 在 周杰伦(z) 前；组内保原序
  assert.deepEqual(ids(out), ['4', '2', '5', '1', '3']);
});

test('groupTracksByArtist 组内稳定：已手调的组内顺序不被打散', () => {
  const list = [
    t('a1', 'A'), t('b1', 'B'), t('a2', 'A'), t('b2', 'B'), t('a3', 'A'),
  ];
  const out = groupTracksByArtist(list);
  assert.deepEqual(ids(out), ['a1', 'a2', 'a3', 'b1', 'b2']);
});

test('groupTracksByArtist artists 数组兜底 + 无名艺人沉尾', () => {
  const list = [
    { id: 'x', name: 'x', artists: [{ name: 'Bob' }] },
    { id: 'y', name: 'y' },                       // 无 ar/artists
    { id: 'z', name: 'z', ar: [{ name: 'Alice' }] },
    { id: 'w', name: 'w', ar: [] },               // 空数组同无名
  ];
  const out = groupTracksByArtist(list);
  assert.deepEqual(ids(out), ['z', 'x', 'y', 'w']);
});

test('groupTracksByArtist 大小写不敏感邻位 + 数字序', () => {
  const list = [t('1', 'b2'), t('2', 'B10'), t('3', 'a1')];
  const out = groupTracksByArtist(list);
  // sensitivity:base → b2<B10（numeric 数值序），a1 最前
  assert.deepEqual(ids(out), ['3', '1', '2']);
});

test('trackArtistGroupKey 各形态', () => {
  assert.equal(trackArtistGroupKey(t('1', '米津玄師')), '米津玄師');
  assert.equal(trackArtistGroupKey({ ar: [{ name: '  trim  ' }] }), 'trim');
  assert.equal(trackArtistGroupKey({ artists: [{ name: 'X' }] }), 'X');
  assert.equal(trackArtistGroupKey({}), '');
  assert.equal(trackArtistGroupKey(null), '');
});

test('groupTracksByArtist 不改原数组（返回新数组）', () => {
  const list = [t('1', 'B'), t('2', 'A')];
  const out = groupTracksByArtist(list);
  assert.deepEqual(ids(list), ['1', '2']);
  assert.deepEqual(ids(out), ['2', '1']);
});
