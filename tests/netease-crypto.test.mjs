// netease/crypto.js 的 golden 测试：固定输入与上游 NeteaseCloudMusicApi@4.27.0
// util/crypto.js 产出的密文逐字节比对（上游依赖已移除——以下为上游实测固化值，
// eapi 全确定、weapi 固定 secretKey='F'×16 即上游 Math.random=0.5 的形态）。
// RSA_NOPAD 左零填充等价 forge 'NONE' 加密是最大风险点。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { weapiEncrypt, eapiEncrypt } = require('../src/server/services/netease/crypto.js');

const OBJ = { s: 'test关键词', type: 1, limit: 30, offset: 0, csrf_token: '' };

// 上游 4.27 eapi('/api/cloudsearch/pc', JSON.stringify(OBJ)) 实测输出
const EAPI_GOLDEN = '2B5D64177AA6460FBAA3DCB1285E28954BBB4F7556E09B0FB25750F12398BB50'
  + 'E107C86C5F79E1D7D41F4925CB105FA7DEEE77ABCA9ACED56E926A1206FB46FCACF9EE15EAB3A65088'
  + 'EF6492FA5F977BAB7DC765AAC1AFCC157568F3EEAC318A6FC9CD0B5B78A0A9B2066BD5A4980007633'
  + 'C94FF595F7AC41A4D80A1AE055B527610C6EB1F2188BEE7D467FFB0F9FF88168FE2DB2E68501F70D8'
  + 'D5A275E47498';

// 上游 4.27 weapi(OBJ) 在 secretKey='FFFFFFFFFFFFFFFF' 下的实测输出
const WEAPI_KEY = 'F'.repeat(16);
const WEAPI_PARAMS_GOLDEN = 'MWsVxWtaZEEf+KjnTSqBfpBZGF08opIZswtko4M9AHYOAZ9eZ6VD/IPeIRlUdmXP'
  + '5FkI1KujeFmi4LiNcDqJjHhKne6x3FJ/pELMGX3VsJdf+eO7rTYFOQyLa+Sgh7jP4QUQetbJCoDe2eGeuuCO4A==';
const WEAPI_SECKEY_GOLDEN = '257348aecb5e556c066de214e531faadd1c55d814f9be95fd06d6bff9f4c7a41f831f6394d5a3fd2e3881736d94a02'
  + 'ca919d952872e7d0a50ebfa1769a7a62d512f5f1ca21aec60bc3819a9c3ffca5eca9a0dba6d6f7249b06f5965ecfff3695b54e1c'
  + '28f3f624750ed39e7de08fc8493242e26dbc4484a01c76f739e135637c';

const fixtures = [
  ['{"ids":"[33894312]","br":320000}', { ids: '["33894312"]', br: 320000 }],
  ['中文歌名+emoji🎵', { s: '中文歌名🎵', type: 1, limit: 30, offset: 0, total: true }],
  ['空对象', {}],
  ['嵌套/数字/布尔', { c: '[{"id":123},{"id":456}]', n: 100000, s: 8, flag: false }],
];

test('eapi 加密与上游 golden 密文逐字节一致', () => {
  assert.equal(eapiEncrypt('/api/cloudsearch/pc', OBJ).params, EAPI_GOLDEN);
});

test('weapi 固定 secretKey 后 params/encSecKey 与上游 golden 一致', () => {
  const ours = weapiEncrypt(OBJ, WEAPI_KEY);
  assert.equal(ours.params, WEAPI_PARAMS_GOLDEN);
  assert.equal(ours.encSecKey, WEAPI_SECKEY_GOLDEN);
});

test('eapi 确定性：多形态输入可重复且同值恒等', () => {
  for (const [label, obj] of fixtures) {
    const a = eapiEncrypt('/api/song/lyric', obj);
    assert.equal(a.params, eapiEncrypt('/api/song/lyric', obj).params, `eapi 应确定: ${label}`);
    assert.match(a.params, /^[0-9A-F]+$/);
  }
});

test('weapi 随机 secretKey 形态合法', () => {
  const a = weapiEncrypt({ a: 1 });
  const b = weapiEncrypt({ a: 1 });
  assert.match(a.encSecKey, /^[0-9a-f]{256}$/);
  assert.notEqual(a.params, b.params, '随机 secretKey 应产生不同 params');
});
