import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeNavParams, readNavParams, resolveNavView, NAV_VIEWS } from '../src/lib/navUrl.js'

// useSearchNav 的寻址规则核——深链/预选/历史回放链路上两轮修复的承重面。
// 这里钉死：view/pl 分账（songs=歌单态、downloads=预选意图，本地 id 规则
// 两域不同）、其余参数保留、读侧词表闸与兜底阶梯

const params = (qs = '') => new URLSearchParams(qs)

test('writeNavParams：view 总写、其余参数原样保留、旧 view/pl 被重写不重复', () => {
  const p = params('view=songs&pl=old&mode=host&mix=abc')
  writeNavParams(p, { view: 'watch' })
  assert.equal(p.get('view'), 'watch')
  assert.equal(p.get('pl'), null)          // 非 songs/downloads 视图清掉残留 pl
  assert.equal(p.get('mode'), 'host')      // 无关参数保留（?mode=host 远程态）
  assert.equal(p.get('mix'), 'abc')
  assert.equal([...p.keys()].filter(k => k === 'view').length, 1)
})

test('writeNavParams：songs 视图 pl 分账——数字可寻址、本地态 id 不落 URL', () => {
  const p1 = params()
  writeNavParams(p1, { view: 'songs', songsPl: 777014 })
  assert.equal(p1.get('pl'), '777014')
  // 本地内存态三类 id（single_song_/saved_queue_/local_pl_*）刷新不可恢复——不写
  for (const localId of ['single_song_x', 'saved_queue_y', 'local_pl_z']) {
    const p = params()
    writeNavParams(p, { view: 'songs', songsPl: localId })
    assert.equal(p.get('pl'), null, `${localId} 不应进 URL`)
  }
  // 数字串 id 同样可寻址（String 归一）
  const p2 = params()
  writeNavParams(p2, { view: 'songs', songsPl: '42' })
  assert.equal(p2.get('pl'), '42')
})

test('writeNavParams：downloads 视图 pl 是预选意图——本地 id 也写（镜像可命中）', () => {
  // 与 songs 域的关键不对称：local_pl_* 在服务端 netease_playlist_id 有镜像行，
  // 深链刷新可重命中——downloads 域不禁本地 id
  const p = params()
  writeNavParams(p, { view: 'downloads', downloadsPl: 'local_pl_abc' })
  assert.equal(p.toString(), 'view=downloads&pl=local_pl_abc')
  // downloadsPl 为空不落 pl；同调携带的 songsPl 不串域
  const p2 = params()
  writeNavParams(p2, { view: 'downloads', songsPl: 777, downloadsPl: null })
  assert.equal(p2.get('pl'), null)
  // downloads 域用 downloadsPl 而非 songsPl——songsPl 在场也不该抢占 pl 位
  const p3 = params()
  writeNavParams(p3, { view: 'downloads', songsPl: 777, downloadsPl: '9' })
  assert.equal(p3.get('pl'), '9')
})

test('writeNavParams：songs/downloads 之外视图两域都不写 pl', () => {
  for (const view of ['home', 'search', 'watch']) {
    const p = params('pl=777')
    writeNavParams(p, { view, songsPl: 777, downloadsPl: 'x' })
    assert.equal(p.get('pl'), null, `${view} 视图不应带 pl`)
  }
})

test('readNavParams：view 过词表闸、pl 原样透传', () => {
  assert.deepEqual(readNavParams(params('view=songs&pl=7')), { view: 'songs', pl: '7' })
  assert.deepEqual(readNavParams(params('view=downloads')), { view: 'downloads', pl: null })
  // 非法/缺省 view 归 null——兜底阶梯接走
  assert.deepEqual(readNavParams(params('view=bogus')), { view: null, pl: null })
  assert.deepEqual(readNavParams(params('')), { view: null, pl: null })
  // pl 不做形态校验（songs/downloads 两域各自解释：数字回选/预览 vs 意图匹配）
  assert.equal(readNavParams(params('view=downloads&pl=local_pl_x')).pl, 'local_pl_x')
})

test('resolveNavView：兜底阶梯——search 空结果/watch 无曲/非法视图', () => {
  assert.equal(resolveNavView({ view: null }), 'home')
  assert.equal(resolveNavView({ view: 'home' }), 'home')
  // search：有结果或在途搜索不弹回；空载回 home
  assert.equal(resolveNavView({ view: 'search', hasSearchResults: true }), 'search')
  assert.equal(resolveNavView({ view: 'search', searching: true }), 'search')
  assert.equal(resolveNavView({ view: 'search' }), 'home')
  // watch：有曲留住；无曲回 songs（有选中单）否则 home
  assert.equal(resolveNavView({ view: 'watch', hasSong: true }), 'watch')
  assert.equal(resolveNavView({ view: 'watch', hasSelectedPlaylist: true }), 'songs')
  assert.equal(resolveNavView({ view: 'watch' }), 'home')
  // songs/downloads 直通（各自的选中/预选副作用在 composable 层）
  assert.equal(resolveNavView({ view: 'songs' }), 'songs')
  assert.equal(resolveNavView({ view: 'downloads' }), 'downloads')
})

test('NAV_VIEWS 词表：五视图锁定（增删视图先改这里）', () => {
  assert.deepEqual([...NAV_VIEWS].sort(), ['downloads', 'home', 'search', 'songs', 'watch'])
})
