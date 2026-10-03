// dist 静态档预压缩：为可压 MIME 产物生成 .br/.gz 伴生档——serveStatic 的
// precompressed:true 投送 br（Accept-Encoding 带 br 的客户端），不带 br 的
// 走 .gz 或运行时 gzip 兜底。零依赖（node:zlib）；woff2/png 等已压类型跳过。
// 幂等：重跑覆盖同档（构建产物同名同内容，hash 名变更自然带新档）。
import { readdirSync, statSync, lstatSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';

// fileURLToPath：裸 .pathname 遇空格/非 ASCII 路径会带 %20 编码、Windows
// 会带前导斜杠——裸跑 postbuild 直接 ENOENT
const DIST = fileURLToPath(new URL('../dist', import.meta.url));
if (!existsSync(DIST)) {
  // 裸跑 postbuild（未先 build）不算错误——无产物可压
  console.log('[compress-dist] dist 不存在，跳过');
  process.exit(0);
}
// 可压收益类型：文本系构建产物。小文件（<1KB）压缩无意义还白占目录
const COMPRESS_EXT = new Set(['.js', '.css', '.html', '.svg', '.json', '.map']);
const MIN_BYTES = 1024;

const walk = function* (dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p); // lstat 防 symlink 环无限递归
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) yield* walk(p);
    else yield [p, st];
  }
};

let done = 0, saved = 0;
for (const [p, st] of walk(DIST)) {
  const ext = p.slice(p.lastIndexOf('.'));
  if (!COMPRESS_EXT.has(ext) || st.size < MIN_BYTES) continue;
  const buf = readFileSync(p);
  writeFileSync(`${p}.br`, brotliCompressSync(buf, {
    params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
  }));
  writeFileSync(`${p}.gz`, gzipSync(buf, { level: constants.Z_BEST_COMPRESSION }));
  done++;
  saved += st.size - statSync(`${p}.br`).size;
}
console.log(`[compress-dist] ${done} 个产物已生成 .br/.gz 伴生档，br 侧共省 ${(saved / 1024).toFixed(0)}KB`);
