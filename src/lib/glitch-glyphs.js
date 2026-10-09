// 文字腐蚀替身池——按源字符书写系统分池。
// 取形规则：汉字走「形近真字/构件/乱码残片」池（读起来是「渲了一半的字」）；
// 假名走半角片假名系（经典 mojibake 质感）；谚文走 jamo 构件（拆字母=半渲染）；
// 拉丁/数字走逐字同形 leet 映射（保词形=英文腐蚀）；
// 其余（标点/emoji/未登记拉丁）走方块+符号 fallback（redaction 语义）。
// 字体口径：池内字符逐一对过 src/fonts/fonts.css——除 GLYPH_LATIN 中标注
// sysfallback 的希腊字母外全部由自托管字族（Noto Sans SC）覆盖，无 tofu 风险。

export const POOL_HANZI = [
  // 形近/生僻密结构汉字（39）
  '鬱籲鑄饒龜續讐鑾鸞魔靈闇響鷹鶴鵬鱗鱻鬆驫麤魑魍魉鼓鼻齊齋龍龖龘龠龢犇淼焱森晶品',
  // mojibake 残片：UTF8→ShiftJIS 腐蚀遗物（6）
  '縺繝縞繧窓€',
  // Kangxi 部首/构件——「渲了一半的字」（15，仅取 fonts.css 实覆项）
  '⼀⼈⼤⼭⼯⼰⼼⽅⽣⽤⽴⾃⾏⾼⺻',
  // 统一表意构件（10）
  '罒爫彳爻卝亠彡灬忄宀',
  // 叠字符/记号（7）
  '々〆〇〴〵〓〰',
  // 注音构件（2）
  'ㄅㄩ',
  // redaction 方块（4）
  '▓░▒█'
].join('').split('')

export const POOL_KANA = [
  // 半角片假名（40，仅取 fonts.css:354 实覆码点——FF66/6B/6D/6E/79/7E/7F/85/87/88/8F/90/91/93-96/9C 刻意不取）
  'ｧｨｩｪｬｯｰｱｲｳｴｵｶｷｸｺｻｼｽﾀﾁﾂﾃﾄﾆﾉﾊﾋﾌﾍﾎﾒﾗﾘﾙﾚﾛﾝﾞﾟ',
  // 生僻/变体片假名（8）
  'ヰヱヲヴヵヶヽヾ'
].join('').split('')

export const POOL_HANGUL = [...'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅋㅍㅎㅜㅠㅡㅣ'] // 16 jamo 构件

export const POOL_FALLBACK = [...'▓░▒█▄■▪〓╳§¤†№€¥×°±÷'] // 19 符

// leet 同形映射——键=源字符（大小写各自独立），值=替身候选（≥1 项，不含键自身）。
// 未列字母/数字进不来（模板层不会产生其它 ASCII），但函数对未命中键走 fallback 兜底。
export const GLYPH_LATIN = {
  a: [...'4@áα'], A: [...'4ΛÅД'],
  b: [...'8ßв'],  B: [...'8Βß'],
  c: [...'¢©ç'],  C: [...'¢©Ç'],
  d: [...'ðď'],   D: [...'ÐĎΔ'],
  e: [...'3€ë'],  E: [...'3€ËΣ'],
  f: [...'ƒſ'],   F: [...'ƒſ'],
  g: [...'69ğ'],  G: [...'69Ğ'],
  h: [...'#нĥ'],  H: [...'#Ĥн'],
  i: [...'1!íï'], I: [...'1!ÍĪ'],
  j: [...'ĵј'],   J: [...'ĴЈ'],
  k: [...'κķ'],   K: [...'Ķк'],
  l: [...'1|£ł'], L: [...'£Ł'],
  m: [...'мɱ₥'],  M: [...'Ṃм₥'],
  n: [...'ñиń'],  N: [...'ÑŃи'],
  o: [...'0øö'],  O: [...'0ØÖ'],
  p: [...'þρр'],  P: [...'ÞƤр'],
  q: [...'9ǫ'],   Q: [...'9Ǫ'],
  r: [...'®яř'],  R: [...'®ЯŘ'],
  s: [...'5$§š'], S: [...'5$§Š'],
  t: [...'7†ţ'],  T: [...'7†Ţ'],
  u: [...'üµц'],  U: [...'ÜЦŲ'],
  v: [...'ν˅'],   V: [...'˅ν'],
  w: [...'шωẅ'],  W: [...'ШΩẄ'],
  x: [...'×х'],   X: [...'×Жˣ'],
  y: [...'¥ÿу'],  Y: [...'¥Ÿγ'],
  z: [...'2žƶ'],  Z: [...'2ŽƵ'],
  0: [...'oOØ°'], 1: [...'lI|!'],
  2: [...'zZƨ'],  3: [...'EεЗ'],
  4: [...'AΛЧ'],  5: [...'Ss§'],
  6: [...'bGб'],  7: [...'T†Γ'],
  8: [...'Bβ&'],  9: [...'gqϱ'],
}
// sysfallback（系统字族落位，自托管无希腊切片）：αΛΒΔΣΓεβνκργϱωΩ —— 与旧 POOL 希腊系同口径

function classOf(char) {
  const cp = char.codePointAt(0)          // 取首码点——emoji ZWJ 簇/组合符簇按首点归类
  if (cp >= 0x3040 && cp <= 0x30FF ||     // 平/片假名
      cp >= 0x31F0 && cp <= 0x31FF ||     // 片假名语音扩展
      cp >= 0xFF66 && cp <= 0xFF9F)       // 半角片假名
    return 'kana'
  if (cp >= 0xAC00 && cp <= 0xD7AF ||     // 谚文音节
      cp >= 0x1100 && cp <= 0x11FF ||     // 谚文 jamo
      cp >= 0x3130 && cp <= 0x318F)       // 谚文兼容 jamo
    return 'hangul'
  if (cp >= 0x2E80 && cp <= 0x2FDF ||     // CJK 部首补充+康熙部首
      cp >= 0x3005 && cp <= 0x303B ||     // 々〆〇等 CJK 记号
      cp >= 0x3100 && cp <= 0x312F ||     // 注音符号
      cp >= 0x31A0 && cp <= 0x31EF ||     // 注音扩展+CJK 笔画
      cp >= 0x3400 && cp <= 0x4DBF ||     // 扩展A
      cp >= 0x4E00 && cp <= 0x9FFF ||     // 基本区
      cp >= 0xF900 && cp <= 0xFAFF ||     // 兼容表意
      cp >= 0x20000 && cp <= 0x2FA1F ||   // 扩展B+（astral）
      cp >= 0x2FF0 && cp <= 0x2FFF)       // 表意描述符（防御——tokenizer 不产出）
    return 'hanzi'
  if (Object.hasOwn(GLYPH_LATIN, char))   // 单字符键命中（大小写各自映射）
    return 'latin'
  return 'fallback'                       // 标点/全角形/emoji/组合符/未登记拉丁
}

const pick = (list, rand, self) => {       // rand()∈[0,1)；越界值钳回池内
  const n = list.length
  const i = ((rand() * n | 0) % n + n) % n   // 钳制：rand()≥1/负值/NaN 不产出越界 undefined
  const g = list[i]
  return g === self ? list[(i + 1) % n] : g  // 自映射禁则：命中自身→顺移一格
}

export function corruptGlyphFor(char, rand = Math.random) {
  switch (classOf(char)) {
    case 'kana':    return pick(POOL_KANA, rand, char)
    case 'hangul':  return pick(POOL_HANGUL, rand, char)
    case 'hanzi':   return pick(POOL_HANZI, rand, char)
    case 'latin':   return pick(GLYPH_LATIN[char], rand, char)
    default:        return pick(POOL_FALLBACK, rand, char)
  }
}
