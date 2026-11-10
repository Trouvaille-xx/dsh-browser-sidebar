#!/usr/bin/env node
/**
 * 打包 Chrome 扩展为 zip：dist/dsh-sidebar-<version>.zip
 * ---------------------------------------------------------------------------
 * 不依赖任何第三方包，也不依赖系统 zip/7z/tar：
 *   - ZIP 容器按 PKZIP AppNote 手写（local file header + central directory + EOCD）；
 *   - 压缩用 node:zlib 的 deflateRawSync（method=8），压不动时退回 store（method=0）；
 *   - CRC32 优先用 node:zlib 的 crc32（Node ≥ 22.2），否则用内置查表实现。
 *   - 默认开启自检：重新解析产出的 zip，逐条 inflate 校验 CRC 与长度。
 *
 * 用法：
 *   node scripts/pack-extension.mjs                 # 生成 dist/dsh-sidebar-<ver>.zip
 *   node scripts/pack-extension.mjs --out dist      # 指定输出目录
 *   node scripts/pack-extension.mjs --include-dev   # 连 test/ 与图标生成脚本一起打包（排查用）
 *   node scripts/pack-extension.mjs --no-verify     # 跳过自检
 */

import { deflateRawSync, inflateRawSync, crc32 as zlibCrc32 } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EXTENSION_DIR = join(ROOT, 'extension');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { out: 'dist', includeDev: false, verify: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' || arg === '--out-dir') args.out = argv[++i] || 'dist';
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg === '--include-dev') args.includeDev = true;
    else if (arg === '--no-verify') args.verify = false;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/pack-extension.mjs [--out dist] [--include-dev] [--no-verify]');
      process.exit(0);
    } else {
      console.warn(`[pack] 忽略未知参数: ${arg}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// CRC32 / DOS 时间
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  if (typeof zlibCrc32 === 'function') {
    try { return zlibCrc32(buffer) >>> 0; } catch (_) { /* 老版本 node 回落 */ }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 生成 DOS 格式的 time/date（ZIP 的最小时间粒度是 2 秒） */
function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const dateBits = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date: dateBits };
}

// ---------------------------------------------------------------------------
// ZIP 写入
// ---------------------------------------------------------------------------

/**
 * @param {Array<{name:string, data:Buffer}>} entries name 用 posix 分隔的相对路径
 * @returns {Buffer}
 */
function buildZip(entries, options) {
  const opts = options || {};
  const { time, date } = dosDateTime(opts.date || new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    let method = 0;
    let payload = data;
    if (data.length > 64) {
      const deflated = deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) {
        method = 8;
        payload = deflated;
      }
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);  // local file header signature
    local.writeUInt16LE(20, 4);          // version needed to extract (2.0)
    local.writeUInt16LE(0x0800, 6);      // general purpose bit flag: UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory file header
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk number start
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE(0, 38);         // external attrs
    central.writeUInt32LE(offset, 42);    // local header offset
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);              // disk number
  eocd.writeUInt16LE(0, 6);              // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);             // comment length

  return Buffer.concat([...localParts, centralDir, eocd]);
}

// ---------------------------------------------------------------------------
// ZIP 自检
// ---------------------------------------------------------------------------

function readZipEntries(buffer) {
  // 从尾部找 EOCD（允许末尾有注释，这里我们固定无注释）
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('找不到 EOCD，不是合法 zip');
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let p = centralOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录第 ${i} 项签名错误`);
    const method = buffer.readUInt16LE(p + 10);
    const crc = buffer.readUInt32LE(p + 16);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const uncompressedSize = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    // 读取 local header 里的实际数据偏移
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    const ok = crc32(data) === crc && data.length === uncompressedSize;
    entries.push({ name, method, crc, compressedSize, uncompressedSize, ok });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 文件收集
// ---------------------------------------------------------------------------

const DEV_ONLY_PATTERNS = [
  /^test[\\/]/,
  /^icons[\\/]generate-icons\.mjs$/,
  /\.map$/,
  /\.DS_Store$/,
  /Thumbs\.db$/,
];

function collectFiles(dir, options) {
  const opts = options || {};
  const out = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = relative(EXTENSION_DIR, full).split(sep).join('/');
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (!opts.includeDev && name === 'test') continue;
        walk(full);
        continue;
      }
      if (!stat.isFile()) continue;
      if (!opts.includeDev && DEV_ONLY_PATTERNS.some((re) => re.test(rel))) continue;
      out.push({ name: rel, path: full, size: stat.size });
    }
  };
  walk(dir);
  // 稳定顺序（zip 内容可复现）
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = join(EXTENSION_DIR, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    console.error(`[pack] 读取 manifest.json 失败：${error.message}`);
    process.exit(1);
  }
  const version = manifest.version || '0.0.0';
  const outDir = resolve(ROOT, args.out);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `dsh-sidebar-${version}.zip`);

  // 不带 --include-dev 时 manifest 引用的运行时文件必须齐全
  const files = collectFiles(EXTENSION_DIR, { includeDev: args.includeDev });
  const required = [
    'manifest.json', 'background.js', 'content.js', 'sidepanel.html', 'sidepanel.css', 'sidepanel.js',
    'options.html', 'options.css', 'options.js', 'lib/core.js', 'lib/net.js',
    'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png',
  ];
  const names = new Set(files.map((file) => file.name));
  const missing = required.filter((name) => !names.has(name));
  if (missing.length) {
    console.error(`[pack] 缺少运行时文件：${missing.join(', ')}`);
    process.exit(1);
  }

  const entries = files.map((file) => ({ name: file.name, data: readFileSync(file.path) }));
  const zip = buildZip(entries);
  writeFileSync(outFile, zip);

  console.log(`[pack] 扩展版本 ${version}`);
  console.log(`[pack] 打包 ${entries.length} 个文件 → ${relative(ROOT, outFile)} (${formatBytes(zip.length)})`);
  const rows = entries.map((entry) => {
    const file = files.find((f) => f.name === entry.name);
    return `  ${entry.name.padEnd(34)} ${formatBytes(entry.data.length).padStart(9)}  (${file ? 'raw' : '?'})`;
  });
  console.log(rows.join('\n'));

  if (args.verify) {
    const parsed = readZipEntries(zip);
    const broken = parsed.filter((entry) => !entry.ok);
    if (parsed.length !== entries.length || broken.length) {
      console.error(`[pack] 自检失败：条目 ${parsed.length}/${entries.length}，损坏 ${broken.length}`);
      for (const entry of broken) console.error(`  - ${entry.name}`);
      process.exit(1);
    }
    const total = parsed.reduce((n, entry) => n + entry.uncompressedSize, 0);
    console.log(`[pack] 自检通过：${parsed.length} 个条目均可解压且 CRC 正确（解压后 ${formatBytes(total)}）`);
  }
  console.log(`\n[pack] 完成。加载方式：chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择 ${relative(ROOT, EXTENSION_DIR)}`);
  console.log(`[pack] 或解压 ${relative(ROOT, outFile)} 后加载同一目录。`);
}

// 仅在直接执行时跑 main，便于以后被其它脚本 import
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main();
}

export { buildZip, readZipEntries, crc32, collectFiles };
