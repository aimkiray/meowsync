// NetEase weapi/eapi 加密——node:crypto 自实现，替代 NeteaseCloudMusicApi
// 的 crypto-js + node-forge 组合（语义逐字段对齐 upstream util/crypto.js）。
// weapi：JSON → AES-128-CBC(presetKey) → AES-128-CBC(secretKey)，
//        secretKey 逆序后 RSA_nopadding 加密得 encSecKey（Web 端风控通道）
// eapi： `${uri}-36cd479b6b5-${data}-36cd479b6b5-${md5}` 整体 AES-128-ECB
//        后转大写 hex（app 端通道，11/17 端点在用，含 song_url/cloudsearch）
const crypto = require('crypto');

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const EAPI_KEY = 'e82ckenh8dichen8';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

function aesEncrypt(text, mode, key, iv, format = 'base64') {
  const cipher = mode === 'ecb'
    ? crypto.createCipheriv('aes-128-ecb', key, null)
    : crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(true);
  const out = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return format === 'hex' ? out.toString('hex').toUpperCase() : out.toString('base64');
}

// forge.publicKey.encrypt(str,'NONE') ≡ 教材 RSA：明文当大端整数 m 算 m^e mod n。
// RSA_NO_PADDING 要求输入恰为模长——secretKey(16B) 左侧零填充到 128B 即可
function rsaEncrypt(secretKeyReversed) {
  const buf = Buffer.alloc(128);
  Buffer.from(secretKeyReversed, 'utf8').copy(buf, 128 - secretKeyReversed.length);
  return crypto.publicEncrypt(
    { key: PUBLIC_KEY_PEM, padding: crypto.constants.RSA_NO_PADDING },
    buf,
  ).toString('hex');
}

function randomSecretKey() {
  let key = '';
  for (let i = 0; i < 16; i++) {
    key += BASE62.charAt(Math.floor(Math.random() * 62));
  }
  return key;
}

// secretKey 可注入——测试固定后 params/encSecKey 全确定，可与上游 golden 对拍
function weapiEncrypt(object, secretKey = randomSecretKey()) {
  const text = JSON.stringify(object);
  return {
    params: aesEncrypt(aesEncrypt(text, 'cbc', PRESET_KEY, IV), 'cbc', secretKey, IV),
    encSecKey: rsaEncrypt(secretKey.split('').reverse().join('')),
  };
}

function eapiEncrypt(uri, object) {
  const text = typeof object === 'object' ? JSON.stringify(object) : object;
  const digest = crypto.createHash('md5')
    .update(`nobody${uri}use${text}md5forencrypt`, 'utf8')
    .digest('hex');
  return {
    params: aesEncrypt(`${uri}-36cd479b6b5-${text}-36cd479b6b5-${digest}`, 'ecb', EAPI_KEY, '', 'hex'),
  };
}

module.exports = { weapiEncrypt, eapiEncrypt };
