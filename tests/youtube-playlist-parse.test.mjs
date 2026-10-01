// fetchYtPlaylistPage 解析层回归网——Innertube 响应形态漂移防御。
// 路由测试 stub 了整个 lib，这里 stub globalThis.fetch 喂真实形态的
// 响应体，钉死新旧两套 renderer（playlistVideoRenderer / lockupViewModel）、
// 两套 continuation 节点、两套 header 的字段映射
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fetchYtPlaylistPage } = require('../src/server/lib/youtube.js');

const realFetch = globalThis.fetch;
const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });
const stubFetch = (handler) => { globalThis.fetch = handler; };
const restore = () => { globalThis.fetch = realFetch; };

// ---- 夹具：真实响应形态（2025 现行 lockupViewModel / 旧 playlistVideoRenderer）----
const lockupItem = (id, title, owner, dur) => ({
  lockupViewModel: {
    contentId: id, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: { thumbnailViewModel: { image: {}, overlays: [
      { thumbnailBottomOverlayViewModel: { badges: [
        { thumbnailBadgeViewModel: { text: dur } }] } }] } },
    metadata: { lockupMetadataViewModel: {
      title: { content: title },
      metadata: { contentMetadataViewModel: { metadataRows: [
        { metadataParts: [{ text: { content: owner } }] },
        { metadataParts: [{ text: { content: '100万次观看' } }] }] } } } },
  },
});
const legacyItem = (id, title, owner, dur, over = {}) => ({
  playlistVideoRenderer: {
    videoId: id, isPlayable: true,
    title: { runs: [{ text: title }] },
    shortBylineText: { runs: [{ text: owner }] },
    lengthText: { simpleText: dur }, ...over },
});
const newCont = (token) => ({ continuationItemViewModel: {
  continuationCommand: { innertubeCommand: { continuationCommand: { token } } } } });
const oldCont = (token) => ({ continuationItemRenderer: {
  continuationEndpoint: { continuationCommand: { token } } } });
const wrapContents = (nodes) => ({ contents: { twoColumnBrowseResultsRenderer: {
  tabs: [{ tabRenderer: { content: { sectionListRenderer: {
    contents: [{ itemSectionRenderer: { contents: nodes } }] } } } }] } } });
const NEW_HEADER = {
  pageHeaderRenderer: {
    pageTitle: 'Select Lectures',
    content: { pageHeaderViewModel: {
      title: { dynamicTextViewModel: { text: { content: 'Select Lectures' } } },
      metadata: { contentMetadataViewModel: { metadataRows: [
        { metadataParts: [{ avatarStack: { avatarStackViewModel: { text: {
          content: 'by Lex Fridman',
          commandRuns: [{ onTap: { innertubeCommand: { browseEndpoint: { browseId: 'UCSHZKyawb77ix' } } } }],
        } } } }] },
        { metadataParts: [{ text: { content: '2 个视频' } }] },
      ] } },
    } },
  },
};
const OLD_HEADER = { playlistHeaderRenderer: {
  title: { simpleText: '旧歌单' },
  ownerText: { runs: [{ text: '旧单主' }] },
  numVideosText: { simpleText: '3 个视频' } } };

test('lockupViewModel 形态：条目/header/续页 token 全量解析', async () => {
  stubFetch(async () => jsonRes({
    header: NEW_HEADER,
    ...wrapContents([
      lockupItem('0VH1Lim8gL8', 'Deep Learning State of the Art', 'Lex Fridman', '1:27:41'),
      lockupItem('O5xeyoRL95U', 'Basics', 'Lex Fridman', '1:08:06'),
      // 频道卡/合集卡——非 VIDEO contentType 不算失效、不进曲目
      { lockupViewModel: { contentId: 'UCSHZKyawb77ix', contentType: 'LOCKUP_CONTENT_TYPE_CHANNEL' } },
      newCont('tokX'),
    ]),
  }));
  try {
    const r = await fetchYtPlaylistPage({ listId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf' });
    assert.equal(r.title, 'Select Lectures');
    assert.equal(r.owner, 'Lex Fridman');
    assert.equal(r.mediaCount, 2);
    assert.equal(r.continuation, 'tokX');
    assert.equal(r.items.length, 2);
    assert.equal(r.skipped, 0);
    const t = r.items[0];
    assert.equal(t.videoId, '0VH1Lim8gL8');
    assert.equal(t.title, 'Deep Learning State of the Art');
    assert.equal(t.owner, 'Lex Fridman');
    assert.equal(t.durationSec, 1 * 3600 + 27 * 60 + 41);
    assert.match(r.cover, /ytimg\.com\/vi\/0VH1Lim8gL8/);
  } finally { restore(); }
});

test('lockupViewModel 失效形态：sentinel 标题/无 videoId 计 skipped', async () => {
  stubFetch(async () => jsonRes(wrapContents([
    lockupItem('dQw4w9WgXcQ', '[Deleted video]', '', ''),
    { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: {} } },
    lockupItem('kJQP7kiw5Fk', '正常曲目', '频道', '3:32'),
  ])));
  try {
    const r = await fetchYtPlaylistPage({ listId: 'PLabcdefghijklmnop' });
    assert.equal(r.items.length, 1);
    assert.equal(r.skipped, 2);
  } finally { restore(); }
});

test('playlistVideoRenderer 旧形态：items/header/旧式 continuation 兼容', async () => {
  stubFetch(async () => jsonRes({
    header: OLD_HEADER,
    ...wrapContents([
      legacyItem('kJQP7kiw5Fk', '旧条目', '旧频道', '3:32'),
      legacyItem('9bZkp7q19f0', '失效项', '频道', '0:00', { isPlayable: false }),
      oldCont('tokY'),
    ]),
  }));
  try {
    const r = await fetchYtPlaylistPage({ listId: 'PLabcdefghijklmnop' });
    assert.equal(r.title, '旧歌单');
    assert.equal(r.owner, '旧单主');
    assert.equal(r.mediaCount, 3);
    assert.equal(r.continuation, 'tokY');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].durationSec, 212);
    assert.equal(r.skipped, 1);
  } finally { restore(); }
});

test('续页根 onResponseReceivedActions 兜底 + alert ERROR 抛 upstreamCode', async () => {
  stubFetch(async () => jsonRes({ onResponseReceivedActions: [
    { appendContinuationItemsAction: { continuationItems: [
      legacyItem('abc123def45', '续页条目', '频道', '1:00')] } }] }));
  try {
    const r = await fetchYtPlaylistPage({ listId: 'PLx', continuation: 'tok1' });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].title, '续页条目');
  } finally { restore(); }

  stubFetch(async () => jsonRes({ alerts: [{ alertRenderer: {
    type: 'ERROR', text: { simpleText: 'The playlist does not exist.' } } }] }));
  try {
    await assert.rejects(
      () => fetchYtPlaylistPage({ listId: 'PLmissingxxx' }),
      (e) => e.upstreamCode === 'ALERT_ERROR');
  } finally { restore(); }
});
