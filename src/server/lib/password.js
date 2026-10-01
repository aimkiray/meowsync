// 密码哈希：argon2id 优先（Node >=24.7 内置 crypto.argon2，零原生依赖），
// 旧运行时尚未到 24.7 回落 scrypt（OWASP 备选基线 N=2^17 r=8 p=1）。
// 存储格式自描述 PHC 风格：algo$m$t$p$<salt b64>$<hash b64> ——
// 参数随行升级，verify 读串内参数，needsRehash 供登录后透明升档。
const { argon2, scrypt, randomBytes, timingSafeEqual } = require('crypto');
const { promisify } = require('util');

const argon2p = typeof argon2 === 'function' ? promisify(argon2) : null;
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
    if (algo === 'a2id' && argon2p) {
      derived = await argon2p('argon2id', {
        memory: +m, passes: +t, parallelism: +p,
        tagLength: expected.length, message: String(password), nonce: salt
      });
    } else if (algo === 'scrypt') {
      // maxmem 按串内参数放大——攻击者塞入的超大 N 也被 maxmem 上限挡住
      const N = +m, r = +t, pp = +p;
      if (!(N > 0) || !(r > 0) || !(pp > 0) || N > 2 ** 20) return false;
      derived = await scryptp(String(password), salt, expected.length, {
        N, r, p: pp, maxmem: Math.max(128 * N * r * pp * 2, 64 * 1024 * 1024)
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
  const [algo, m, t] = parts;
  if (algo === 'a2id') {
    return !argon2p || +m < ARGON2.memory || +t < ARGON2.passes;
  }
  if (algo === 'scrypt') {
    // argon2 可用的运行时下 scrypt 串视为落后
    return argon2p ? true : +m < SCRYPT.N;
  }
  return true;
}

// 防用户枚举：用户不存在时也跑一次完整 KDF——响应时序与「密码错误」对齐。
// 惰性生成一次（模块级），内容为合法格式的随机 hash
let dummyHashPromise = null;
function getDummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(randomBytes(16).toString('hex'));
  return dummyHashPromise;
}

module.exports = { hashPassword, verifyPassword, needsRehash, getDummyHash };
