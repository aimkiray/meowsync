// 密码哈希：argon2id 优先（Node >=24.7 内置 crypto.argon2，零原生依赖），
// 旧运行时尚未到 24.7 回落 scrypt（OWASP 备选基线 N=2^17 r=8 p=1）。
// 存储格式自描述 PHC 风格：algo$m$t$p$<salt b64>$<hash b64> ——
// 参数随行升级，verify 读串内参数，needsRehash 供登录后透明升档。
const { argon2, scrypt, randomBytes, timingSafeEqual } = require('crypto');
const { promisify } = require('util');

// argon2 可用性导出给路由层——a2id 哈希在无 crypto.argon2 的运行时（<24.7）
// 无法验证，login 需要区分「密码错误」与「运行时缺 KDF」给出可操作的 503
const argon2Available = typeof argon2 === 'function';
const argon2p = argon2Available ? promisify(argon2) : null;
const scryptp = promisify(scrypt);

// OWASP：argon2id m=19MiB t=2 p=1
const ARGON2 = { memory: 19 * 1024, passes: 2, parallelism: 1, tagLength: 32 };
// OWASP 备选：scrypt N=2^17 r=8 p=1（~134MiB/次）。
// maxmem 默认只有 32MiB，不显式放大到 2 倍需求会直接抛
// ERR_CRYPTO_INVALID_SCRYPT_PARAMS（Node issue #53291 著名坑）
const SCRYPT = {
  N: 2 ** 17, r: 8, p: 1, keylen: 32,
  maxmem: 128 * 2 ** 17 * 8 * 2
};

function b64(buf) { return buf.toString('base64'); }
function unb64(s) { return Buffer.from(s, 'base64'); }

async function hashPassword(password) {
  const salt = randomBytes(16);
  if (argon2p) {
    const hash = await argon2p('argon2id', {
      ...ARGON2, message: String(password), nonce: salt
    });
    return `a2id$${ARGON2.memory}$${ARGON2.passes}$${ARGON2.parallelism}$${b64(salt)}$${b64(hash)}`;
  }
  const hash = await scryptp(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64(salt)}$${b64(hash)}`;
}

// 校验：解析 PHC 参数 → 同参数派生 → timingSafeEqual。
// 未知算法/畸形串回 false（不抛——存储面受损时按认证失败处理，不暴露内部态）
async function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6) return false;
    const [algo, m, t, p, saltB64, hashB64] = parts;
    const salt = unb64(saltB64);
    const expected = unb64(hashB64);
    if (!salt.length || !expected.length) return false;

    let derived;
    if (algo === 'a2id') {
      // 无 argon2 的运行时（<24.7）验不了 a2id 串——显式告警而非静默"密码错误"
      if (!argon2p) {
        warnOnce('发现 a2id 哈希但当前 Node 无 crypto.argon2（需 >=24.7）——该库在低版本运行时上无法登录');
        return false;
      }
      // 纵深界：串内参数被 DB 写权限者篡改时，无界参数=内存/CPU DoS
      const mem = +m, passes = +t, par = +p;
      if (!(mem > 0) || !(passes > 0) || !(par > 0)
        || mem > 2 ** 20 || passes > 8 || par > 4
        || expected.length < 4 || expected.length > 64) return false;
      derived = await argon2p('argon2id', {
        memory: mem, passes, parallelism: par,
        tagLength: expected.length, message: String(password), nonce: salt
      });
    } else if (algo === 'scrypt') {
      const N = +m, r = +t, pp = +p;
      if (!(N > 0) || !(r > 0) || !(pp > 0) || N > 2 ** 20 || r > 64 || pp > 8) return false;
      // keylen 上界与 a2id 的 tagLength 界同口径——篡改串的超大 dkLen
      // 会让 scrypt 分配/计算失控（需 DB 写权限才能放，纵深对齐）
      if (expected.length < 4 || expected.length > 512) return false;
      // maxmem 是固定上限而非随参数放大——防止篡改串强行要求 GB 级内存
      const need = 128 * N * r * pp * 2;
      if (need > 512 * 1024 * 1024) return false;
      derived = await scryptp(String(password), salt, expected.length, {
        N, r, p: pp, maxmem: Math.max(need, 64 * 1024 * 1024)
      });
    } else {
      return false;
    }
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// 登录成功且参数落后当前基线时重哈希（透明升级，用户无感）
function needsRehash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6) return true;
  const [algo, m, t, p, , hashB64] = parts;
  if (algo === 'a2id') {
    const tagLen = unb64(hashB64).length;
    return !argon2p || +m !== ARGON2.memory || +t !== ARGON2.passes
      || +p !== ARGON2.parallelism || tagLen !== ARGON2.tagLength;
  }
  if (algo === 'scrypt') {
    // argon2 可用的运行时下 scrypt 串视为落后
    return argon2p ? true
      : +m !== SCRYPT.N || +t !== SCRYPT.r || +p !== SCRYPT.p;
  }
  return true;
}

// 一次性告警——verify 里捕获判定要靠它分辨「真错密码」vs「运行时缺 KDF」
let warned = false;
function warnOnce(msg) {
  if (warned) return;
  warned = true;
  console.warn(`[auth] ${msg}`);
}

// 防用户枚举：用户不存在时也跑一次完整 KDF——响应时序与「密码错误」对齐。
// 惰性生成一次（模块级），内容为合法格式的随机 hash；生成失败必须清缓存——
// 否则 rejected promise 永久挂着，之后所有不存在用户的登录都变 500
let dummyHashPromise = null;
function getDummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(randomBytes(16).toString('hex'))
      .catch(e => { dummyHashPromise = null; throw e; });
  }
  return dummyHashPromise;
}

module.exports = { hashPassword, verifyPassword, needsRehash, getDummyHash, argon2Available };
