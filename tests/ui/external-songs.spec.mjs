// external-songs.js：三 builder 的艺人重合闸 + applyMatchResult 修复器。
// 口径「词源绑定宽松 / 展示身份保守」：neteaseId 恒按结果覆写，matched 的
// 展示身份字段（name、al.id/name/picUrl）只在「匹配艺人 ∩ 上传者」重合时
// 采纳——同名异曲错配（如 cover 曲绑到别家专辑）不该把脏元信息烘进曲对象
import { describe, it, expect, vi } from 'vitest'

// external-songs.js 只在 MEDIA_IMPORT_SPECS 的惰性 resolve 转发表里用到
// musicApi——桩掉防 axios 链进本 spec 的 import 图
vi.mock('../../src/api/music.js', () => ({
  musicApi: { resolveBilibili: vi.fn(), resolveYouTube: vi.fn(), resolveQQ: vi.fn() },
}))

import {
  buildYouTubeSong, buildBilibiliSong, buildQQSong, applyMatchResult,
} from '../../src/lib/external-songs.js'

const ytData = (over = {}) => ({
  videoId: 'abcdefghijk', title: 'EMA - 乐园(粤)', author: 'EMA',
  authorClean: 'EMA', duration: 210,
  cover: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
  songName: '乐园', hasVideo: true, matched: null,
  ...over,
})
const bvData = (over = {}) => ({
  bvid: 'BV1xx411c7mD', title: '【UP主】翻唱 乐园', owner: 'UP主',
  cover: 'http://i0.hdslb.com/bfs/cover.jpg', duration: 200,
  songName: '乐园', page: 1, matched: null,
  ...over,
})

describe('builder：导入期艺人重合闸', () => {
  it('yt_ 艺人重合 → al 整组吃 matched，provider 封面仍优先', () => {
    const s = buildYouTubeSong(ytData({
      // 大小写差异不挡重合判定（归一后 'ema' === 'EMA'）
      matched: { id: 100, name: '乐园', ar: [{ name: 'ema' }],
        al: { id: 9, name: '乐园专辑', picUrl: 'http://n/9.jpg' } },
    }))
    expect(s.neteaseId).toBe(100)
    expect(s.name).toBe('乐园')
    expect(s.al.id).toBe(9)
    expect(s.al.name).toBe('乐园专辑')
    // provider 封面恒优先——即使艺人重合也不吃 matched 封面
    expect(s.al.picUrl).toBe('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg')
  })

  it('yt_ 同名异曲错配：词源照绑（宽松），al 回 provider 态（保守）', () => {
    const s = buildYouTubeSong(ytData({
      matched: { id: 390558, name: '乐园', ar: [{ name: 'Random Forest 随机森林' }],
        al: { id: 1, name: '10乐园', picUrl: 'http://n/dirty.jpg' } },
    }))
    expect(s.neteaseId).toBe(390558)          // 词源嫁接照旧
    expect(s.name).toBe('乐园')               // 同名 cover 无害
    expect(s.al.id).toBeNull()                // 专辑身份不吃错配
    expect(s.al.name).toBe('EMA - 乐园(粤)')   // provider 原标题兜底
    expect(s.al.picUrl).toBe('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg')
  })

  it('bv_ owner 与 matched.ar 无交集 → al 回 title/cover 链', () => {
    const s = buildBilibiliSong(bvData({
      matched: { id: 2, name: '乐园', ar: [{ name: '别人' }],
        al: { id: 5, name: '别人专辑', picUrl: 'http://n/x.jpg' } },
    }))
    expect(s.al.name).toBe('【UP主】翻唱 乐园')
    expect(s.al.id).toBeNull()
    expect(s.al.picUrl).toBe('http://i0.hdslb.com/bfs/cover.jpg')
    expect(s.neteaseId).toBe(2)
  })

  it('yt_ 艺人不重合 → name 不吃 matched.name，回提取名 songName', () => {
    // matched.name 与 songName 取不同值以区分口径——借词源不改展示身份
    const s = buildYouTubeSong(ytData({
      matched: { id: 390558, name: '别家同名曲', ar: [{ name: '别人' }] },
    }))
    expect(s.neteaseId).toBe(390558)
    expect(s.name).toBe('乐园')
  })

  it('bv_ 艺人不重合 → name 不吃 matched.name，回提取名 songName', () => {
    const s = buildBilibiliSong(bvData({
      matched: { id: 2, name: '别家同名曲', ar: [{ name: '别人' }] },
    }))
    expect(s.neteaseId).toBe(2)
    expect(s.name).toBe('乐园')
  })

  it('bv_ owner 命中 → al 吃 matched（多艺人条目任一命中即重合）', () => {
    const s = buildBilibiliSong(bvData({
      matched: { id: 2, name: '乐园', ar: [{ name: '无关' }, { name: ' UP主 ' }],
        al: { id: 5, name: '对的专辑', picUrl: 'http://n/x.jpg' } },
    }))
    expect(s.al.name).toBe('对的专辑')
    expect(s.al.id).toBe(5)
  })

  it('qq_ 主链不动（provider 优先），仅 matched 兜底分支受闸', () => {
    const s = buildQQSong({
      mid: 'm1', name: 'QQ歌', artists: ['Q艺人'], album: 'Q专辑',
      cover: 'http://q/c.jpg', duration: 100,
      matched: { id: 8, name: 'x', ar: [{ name: '陌生人' }],
        al: { id: 1, name: '别专', picUrl: 'http://n/x.jpg' } },
    })
    expect(s.al.name).toBe('Q专辑')     // provider 主链不动
    expect(s.al.id).toBeNull()          // matched 身份受闸不放行
    expect(s.al.picUrl).toBe('http://q/c.jpg')
    // artists 缺位时闸恒不过——name/picUrl 兜底都不吃 matched
    const s2 = buildQQSong({
      mid: 'm2', name: 'QQ歌2', artists: [], album: '', cover: '',
      matched: { id: 8, name: 'x', ar: [{ name: '陌生人' }],
        al: { id: 1, name: '别专', picUrl: 'http://n/x.jpg' } },
    })
    expect(s2.al.name).toBe('')
    expect(s2.al.picUrl).toBe('')
    // 重合时兜底分支照旧生效
    const s3 = buildQQSong({
      mid: 'm3', artists: ['Q艺人'], album: '', cover: '',
      matched: { id: 8, name: 'x', ar: [{ name: 'q艺人' }],
        al: { id: 1, name: '匹配专', picUrl: 'http://n/x.jpg' } },
    })
    expect(s3.al.name).toBe('匹配专')
    expect(s3.al.id).toBe(1)
    expect(s3.al.picUrl).toBe('http://n/x.jpg')
  })
})

describe('applyMatchResult：重匹配修复器', () => {
  // 残留形态：旧错配把 matched.al 烘进持久化曲对象（provider 块完好——
  // 回退原料在库，修复靠它）
  const dirtyYt = () => ({
    id: 'yt_abcdefghijk', name: '乐园', ar: [{ name: 'EMA' }],
    // pic_str 是上游专辑对象的图链双生字段（local-mirror 读它当封面兜底）——
    // 旧错配把它烘进了持久化行，修复期 {...oldAl, ...rebuilt} 合并时
    // rebuilt 不显式给值就会残留，与 picUrl 同闸洗
    al: { id: 1, name: '10乐园', picUrl: 'http://n/dirty.jpg', pic_str: 'http://n/dirty-str.jpg' },
    dt: 210000, neteaseId: 390558,
    youtube: { videoId: 'abcdefghijk', title: 'EMA - 乐园(粤)', author: 'EMA', authorClean: 'EMA' },
  })

  it('命中+艺人重合：整组重建——改名/吃 matched.al/证据落 provider 块', () => {
    const s = dirtyYt()
    const r = applyMatchResult(s,
      { id: 222, name: '对的歌', ar: [{ name: 'EMA' }],
        al: { id: 9, name: '对的专辑', picUrl: 'http://n/9.jpg', pic_str: 'http://n/9-str.jpg' } },
      { matchedBy: 'q', matchScore: 92 })
    expect(r).toBe(s) // 就地改写返回同一引用
    expect(s.neteaseId).toBe(222)
    expect(s.name).toBe('对的歌')
    expect(s.al.id).toBe(9)
    expect(s.al.name).toBe('对的专辑')
    // provider 封面优先：重合也不吃 matched.picUrl
    expect(s.al.picUrl).toBe('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg')
    // 图链双生字段同闸：重合时采纳 matched 侧 pic_str 而非残留旧值
    expect(s.al.pic_str).toBe('http://n/9-str.jpg')
    expect(s.youtube.matchedBy).toBe('q')
    expect(s.youtube.matchScore).toBe(92)
    expect(s.ar).toEqual([{ name: 'EMA' }]) // 上传者不动
  })

  it('命中但艺人不重合（翻唱借词源）：词源换绑，name/al 回 provider 态', () => {
    const s = dirtyYt()
    applyMatchResult(s,
      { id: 555, name: '乐园', ar: [{ name: 'Random Forest 随机森林' }],
        al: { id: 7, name: '别家专辑', picUrl: 'http://n/o.jpg' } })
    expect(s.neteaseId).toBe(555)            // 词源可借
    // 展示身份不借：夹具 name='乐园' 是旧错配烘进的脏名，经闸自愈回
    // provider 原标题（存量污染 lazy 修复点）
    expect(s.name).toBe('EMA - 乐园(粤)')
    expect(s.al.name).toBe('EMA - 乐园(粤)')
    expect(s.al.id).toBeNull()
    expect(s.al.picUrl).toBe('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg')
    // pic_str 同闸洗白：无重合不采匹配专辑图链任何字段——rebuilt 显式
    // 给 null 压掉 {...oldAl} 烘进的脏值，否则 local-mirror 拿它当封面
    expect(s.al.pic_str).toBeNull()
    // extras 缺省置 null——比残留旧匹配证据诚实
    expect(s.youtube.matchedBy).toBeNull()
    expect(s.youtube.matchScore).toBeNull()
  })

  it('艺人重合但 matched.name 缺席：name 回 provider 提取名/原标题', () => {
    // 构造期：songName 兜底（matched 无名可吃，回提取名而非标题噪声）
    const built = buildYouTubeSong(ytData({
      matched: { id: 9, ar: [{ name: 'EMA' }] },
    }))
    expect(built.name).toBe('乐园')
    expect(built.neteaseId).toBe(9)
    // 修复期：provTitle 兜底；al 是独立字段，重合面照吃 matched.al
    const s = dirtyYt()
    applyMatchResult(s,
      { id: 9, ar: [{ name: 'EMA' }], al: { id: 9, name: '对的专辑', picUrl: 'http://n/9.jpg' } })
    expect(s.name).toBe('EMA - 乐园(粤)')
    expect(s.neteaseId).toBe(9)
    expect(s.al.id).toBe(9)
    expect(s.al.name).toBe('对的专辑')
  })

  it('matched=null 解绑：neteaseId/name/al/证据全回 provider 态', () => {
    const s = dirtyYt()
    s.youtube.matchedBy = 'ai:pick'
    s.youtube.matchScore = 88
    applyMatchResult(s, null)
    expect(s.neteaseId).toBeNull()
    expect(s.name).toBe('EMA - 乐园(粤)')
    expect(s.al).toMatchObject({
      id: null, name: 'EMA - 乐园(粤)',
      picUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
      pic_str: null, // 解绑同洗图链双生字段——脏 pic_str 不残留
    })
    expect(s.youtube.matchedBy).toBeNull()
    expect(s.youtube.matchScore).toBeNull()
    expect(s.ar).toEqual([{ name: 'EMA' }])
  })

  it('qq_ 曲只换词源+证据：name/al 是 QQ 权威元数据不动', () => {
    const s = buildQQSong({
      mid: 'm1', name: 'QQ歌', artists: ['Q艺人'], album: 'Q专辑',
      cover: 'http://q/c.jpg', duration: 100, matched: null,
    })
    applyMatchResult(s,
      { id: 9, name: '匹配名', ar: [{ name: '陌生人' }],
        al: { id: 1, name: '别专', picUrl: 'http://n/x.jpg' } },
      { matchedBy: 'q', matchScore: 80 })
    expect(s.neteaseId).toBe(9)
    expect(s.name).toBe('QQ歌')
    expect(s.al.name).toBe('Q专辑')
    expect(s.al.picUrl).toBe('http://q/c.jpg')
    expect(s.qq.matchedBy).toBe('q')
    expect(s.qq.matchScore).toBe(80)
  })

  it('bv_ provider 封面不被 matched.picUrl 抢；无封面且重合才吃匹配封面', () => {
    const s = {
      id: 'bv_BV1xx411c7mD', name: 'x', neteaseId: 1,
      ar: [{ name: 'UP主' }], al: { id: null, name: 'x', picUrl: 'http://i0.hdslb.com/bfs/cover.jpg' },
      bilibili: { bvid: 'BV1xx411c7mD', title: 'B视频', author: 'UP主', cover: 'http://i0.hdslb.com/bfs/cover.jpg' },
    }
    applyMatchResult(s,
      { id: 2, name: 'n', ar: [{ name: 'UP主' }], al: { id: 3, name: 'm专辑', picUrl: 'http://n/m.jpg' } })
    expect(s.al.picUrl).toBe('http://i0.hdslb.com/bfs/cover.jpg') // provider 优先
    // 无 provider 封面 + 重合 → matched.picUrl 兜底生效
    const noCover = { ...s, al: { name: 'x', picUrl: '' }, bilibili: { ...s.bilibili, cover: '' } }
    applyMatchResult(noCover,
      { id: 2, name: 'n', ar: [{ name: 'UP主' }], al: { picUrl: 'http://n/m.jpg', name: 'm专辑' } })
    expect(noCover.al.picUrl).toBe('http://n/m.jpg')
    // 无 provider 封面 + 不重合 → 脏封面不吃
    const noCoverBad = { ...noCover, al: { name: 'x', picUrl: '' } }
    applyMatchResult(noCoverBad,
      { id: 2, name: 'n', ar: [{ name: '陌生人' }], al: { picUrl: 'http://n/m.jpg', name: 'm专辑' } })
    expect(noCoverBad.al.picUrl).toBe('')
    expect(noCoverBad.al.name).toBe('B视频')
  })

  it('防御：al 非对象/缺字段不炸，重建为对象形态', () => {
    const s = {
      id: 'yt_abcdefghijk', name: 'x', neteaseId: 1,
      al: '旧字符串形态',
      youtube: { videoId: 'abcdefghijk', title: 'T', author: 'A' },
    }
    applyMatchResult(s, null)
    expect(typeof s.al).toBe('object')
    expect(s.al.name).toBe('T')
    expect(s.neteaseId).toBeNull()
  })

  it('custom 位曲目：用户显式编辑过的展示字段不被修复器覆盖', () => {
    const s = dirtyYt()
    s.custom = true
    s.name = '用户改的名'
    s.al = { id: 4, name: '用户改的专辑', picUrl: 'http://u/a.jpg' }
    applyMatchResult(s,
      { id: 1, name: 'n', ar: [{ name: 'EMA' }], al: { id: 2, name: 'a', picUrl: 'http://n/a.jpg' } })
    expect(s.neteaseId).toBe(1)          // 词源仍换
    expect(s.name).toBe('用户改的名')     // 用户意图不动
    expect(s.al.name).toBe('用户改的专辑')
    expect(s.al.picUrl).toBe('http://u/a.jpg')
  })
})
