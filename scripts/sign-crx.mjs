#!/usr/bin/env node
/**
 * 用本地私钥生成 .crx（可选脚本）
 * ---------------------------------------------------------------------------
 * 两种方式：
 *
 *   1) --method chrome（默认优先尝试）：调用本机 Chrome/Edge 自带的打包器
 *        chrome.exe --pack-extension=<extension 目录> --pack-extension-key=<key.pem>
 *      这是**官方实现**，产出的 .crx 一定符合当前浏览器的校验；缺点是需要本机装了 Chrome/Edge。
 *
 *   2) --method native（实验性，纯 node）：自己按 CRX3 规范写容器
 *         "Cr24" + uint32(3) + uint32(header_size) + CrxFileHeader(protobuf) + zip
 *      签名算法：RSA-SHA256 over
 *         "CRX3 SignedData\0" + uint32le(len(signed_header_data)) + signed_header_data + zip
 *      crx_id = SHA256(SubjectPublicKeyInfo DER) 前 16 字节。
 *      脚本会用公钥把自己的产物重新验一遍（--verify），但**没有在真实 Chrome 里
 *      安装验证过**（见 README「已知限制」）。分发给用户请优先用 zip + 加载已解压。
 *
 * 用法：
 *   node scripts/sign-crx.mjs --gen-key                 # 生成 dist/extension-key.pem（私钥！别提交）
 *   node scripts/sign-crx.mjs                           # auto：有 Chrome 用 chrome，否则 native
 *   node scripts/sign-crx.mjs --method chrome
 *   node scripts/sign-crx.mjs --method native --verify
 *   node scripts/sign-crx.mjs --verify-only dist/dsh-sidebar-1.0.0.crx
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, createHash, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFiles, buildZip, readZipEntries } from './pack-extension.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EXTENSION_DIR = join(ROOT, 'extension');
const DIST_DIR = join(ROOT, 'dist');
const DEFAULT_KEY = join(DIST_DIR, 'extension-key.pem');

const CRX_MAGIC = Buffer.from('Cr24', 'ascii');
const CRX_VERSION = 3;
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\0', 'latin1');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { method: 'auto', key: DEFAULT_KEY, genKey: false, verify: true, verifyOnly: '', crxOut: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--method') args.method = argv[++i] || 'auto';
    else if (arg.startsWith('--method=')) args.method = arg.slice('--method='.length);
    else if (arg === '--key') args.key = argv[++i] || DEFAULT_KEY;
    else if (arg.startsWith('--key=')) args.key = arg.slice('--key='.length);
    else if (arg === '--gen-key') {
      args.genKey = true;
      // 支持 --gen-key <path>，但下一个参数是选项时视为不带路径
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args.key = next; i += 1; }
    } else if (arg === '--verify-only') args.verifyOnly = argv[++i];
    else if (arg.startsWith('--verify-only=')) args.verifyOnly = arg.slice('--verify-only='.length);
    else if (arg === '--no-verify') args.verify = false;
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--crx-out') args.crxOut = argv[++i] || '';
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/sign-crx.mjs [--gen-key [key.pem]] [--method chrome|native|auto] [--key <key.pem>] [--verify-only <crx>] [--crx-out <path>] [--no-verify]');
      process.exit(0);
    } else {
      console.warn(`[crx] 忽略未知参数：${arg}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// 密钥
// ---------------------------------------------------------------------------

function genKey(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    console.log(`[crx] 私钥已存在，复用：${path}`);
    return path;
  }
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(path, privateKey, { mode: 0o600 });
  console.log(`[crx] 已生成 RSA-2048 私钥：${path}`);
  console.log('[crx] ⚠️  这是扩展的身份私钥：不要提交到仓库、不要外传；丢了它就无法给同一扩展签名升级包。');
  return path;
}

function loadPrivateKey(path) {
  const pem = readFileSync(path, 'utf8');
  return createPrivateKey(pem);
}

// ---------------------------------------------------------------------------
// protobuf 最小编码（只覆盖 CRX3 用到的两种结构）
// ---------------------------------------------------------------------------

function varint(value) {
  const bytes = [];
  let v = value;
  while (v > 127) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

function fieldBytes(fieldNumber, value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(buf.length), buf]);
}

/** AsymmetricKeyProof { public_key = 1, signature = 2 } */
function encodeAsymmetricKeyProof(publicKeyDer, signature) {
  return Buffer.concat([fieldBytes(1, publicKeyDer), fieldBytes(2, signature)]);
}

/** CrxFileHeader { sha256_with_rsa = 2, sha256_with_ecdsa = 3, signed_header_data = 10000 } */
function encodeCrxFileHeader(proofs, signedHeaderData) {
  const parts = [];
  for (const proof of proofs) parts.push(fieldBytes(2, proof));
  parts.push(fieldBytes(10000, signedHeaderData));
  return Buffer.concat(parts);
}

/** SignedData { crx_id = 1 } */
function encodeSignedData(crxId) {
  return fieldBytes(1, crxId);
}

/** 只解析出 CRX3 头部需要的几个字段（用于 --verify） */
function decodeCrxFileHeader(buf) {
  const out = { rsaProofs: [], signedHeaderData: null };
  let offset = 0;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    while (offset < buf.length) {
      const byte = buf[offset++];
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  };
  while (offset < buf.length) {
    const key = readVarint();
    const fieldNumber = Math.floor(key / 8);
    const wireType = key & 7;
    if (wireType === 2) {
      const length = readVarint();
      const value = buf.subarray(offset, offset + length);
      offset += length;
      if (fieldNumber === 2) {
        // AsymmetricKeyProof
        let p = 0;
        const proof = { publicKey: null, signature: null };
        while (p < value.length) {
          let tag = 0;
          let shift = 0;
          while (p < value.length) {
            const byte = value[p++];
            tag += (byte & 0x7f) * 2 ** shift;
            if ((byte & 0x80) === 0) break;
            shift += 7;
          }
          const subField = Math.floor(tag / 8);
          const subWire = tag & 7;
          if (subWire === 2) {
            let len = 0;
            let s = 0;
            while (p < value.length) {
              const byte = value[p++];
              len += (byte & 0x7f) * 2 ** s;
              if ((byte & 0x80) === 0) break;
              s += 7;
            }
            const data = value.subarray(p, p + len);
            p += len;
            if (subField === 1) proof.publicKey = data;
            else if (subField === 2) proof.signature = data;
          } else {
            // 跳过其他 wire type（varint / fixed）
            if (subWire === 0) { while (p < value.length && (value[p++] & 0x80)) { /* skip */ } }
            else if (subWire === 5) p += 4;
            else if (subWire === 1) p += 8;
            else return out; // 不支持
          }
        }
        out.rsaProofs.push(proof);
      } else if (fieldNumber === 10000) {
        out.signedHeaderData = value;
      }
    } else if (wireType === 0) {
      readVarint();
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  return out;
}

function decodeSignedDataCrxId(buf) {
  let offset = 0;
  while (offset < buf.length) {
    const tag = buf[offset++];
    const fieldNumber = tag >> 3;
    const wireType = tag & 7;
    if (wireType === 2) {
      const length = buf[offset++];
      const value = buf.subarray(offset, offset + length);
      offset += length;
      if (fieldNumber === 1) return Buffer.from(value);
      continue;
    }
    if (wireType === 0) { while (offset < buf.length && (buf[offset++] & 0x80)) { /* skip */ } continue; }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// native CRX3
// ---------------------------------------------------------------------------

/**
 * @param {Buffer} zip
 * @param {{privateKey: import('node:crypto').KeyObject}} options
 * @returns {Buffer}
 */
function buildCrx3Native(zip, options) {
  const privateKey = options.privateKey;
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const crxId = createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
  const signedHeaderData = encodeSignedData(crxId);

  const signedPayload = Buffer.concat([
    SIGNATURE_CONTEXT,
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(signedHeaderData.length, 0); return b; })(),
    signedHeaderData,
    zip,
  ]);
  const signature = cryptoSign('sha256', signedPayload, privateKey);
  const header = encodeCrxFileHeader([encodeAsymmetricKeyProof(publicKeyDer, signature)], signedHeaderData);

  const prefix = Buffer.alloc(12);
  CRX_MAGIC.copy(prefix, 0);
  prefix.writeUInt32LE(CRX_VERSION, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zip]);
}

/**
 * 校验 CRX3：头部结构 + crx_id + RSA 签名 + 内嵌 zip 完整性。
 * @returns {{ok:boolean, errors:string[], info:object}}
 */
function verifyCrx3(crx) {
  const errors = [];
  if (crx.length < 12 || crx.subarray(0, 4).toString('ascii') !== 'Cr24') {
    return { ok: false, errors: ['不是 CRX 文件（magic 不是 Cr24）'], info: {} };
  }
  const version = crx.readUInt32LE(4);
  if (version !== 3) {
    return { ok: false, errors: [`仅支持 CRX3，读到 version=${version}`], info: { version } };
  }
  const headerSize = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerSize);
  const zip = crx.subarray(12 + headerSize);
  const parsed = decodeCrxFileHeader(header);
  const info = { version, headerSize, zipSize: zip.length, proofCount: parsed.rsaProofs.length };
  if (!parsed.rsaProofs.length) errors.push('头部没有 sha256_with_rsa 证明');
  if (!parsed.signedHeaderData) errors.push('头部没有 signed_header_data');

  if (parsed.rsaProofs.length && parsed.signedHeaderData) {
    const proof = parsed.rsaProofs[0];
    if (!proof.publicKey) errors.push('缺少 public_key');
    if (!proof.signature) errors.push('缺少 signature');
    if (proof.publicKey && proof.signature) {
      const expectedId = createHash('sha256').update(proof.publicKey).digest().subarray(0, 16);
      const actualId = decodeSignedDataCrxId(parsed.signedHeaderData);
      info.crxId = expectedId.toString('hex');
      if (!actualId || !Buffer.from(actualId).equals(expectedId)) {
        errors.push('signed_header_data 里的 crx_id 与公钥哈希不一致');
      } else {
        info.crxIdMatches = true;
      }
      const signedPayload = Buffer.concat([
        SIGNATURE_CONTEXT,
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(parsed.signedHeaderData.length, 0); return b; })(),
        parsed.signedHeaderData,
        zip,
      ]);
      try {
        const publicKey = createPublicKey({ key: Buffer.from(proof.publicKey), format: 'der', type: 'spki' });
        info.signatureValid = cryptoVerify('sha256', signedPayload, publicKey, proof.signature);
        if (!info.signatureValid) errors.push('RSA-SHA256 签名校验失败');
      } catch (error) {
        errors.push(`公钥解析失败：${error.message}`);
      }
    }
  }

  try {
    const entries = readZipEntries(zip);
    const broken = entries.filter((entry) => !entry.ok);
    info.zipEntries = entries.length;
    if (broken.length) errors.push(`内嵌 zip 有 ${broken.length} 个损坏条目`);
  } catch (error) {
    errors.push(`内嵌 zip 解析失败：${error.message}`);
  }
  return { ok: errors.length === 0, errors, info };
}

// ---------------------------------------------------------------------------
// Chrome / Edge 打包器
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChromium() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch (_) { /* ignore */ }
  }
  return '';
}

function buildCrx3WithChrome(chromePath, keyPath, outFile) {
  const targetDir = EXTENSION_DIR;
  execFileSync(chromePath, [
    `--pack-extension=${targetDir}`,
    `--pack-extension-key=${keyPath}`,
    '--no-message-box',
  ], { stdio: 'ignore' });
  // Chrome 输出到 <dir>.crx（与 extension 目录同级）
  const chromeOut = `${targetDir}.crx`;
  if (!existsSync(chromeOut)) {
    throw new Error(`Chrome 打包器没有产出 ${chromeOut}（Chrome 是否在运行/是否有写权限？）`);
  }
  copyFileSync(chromeOut, outFile);
  try { unlinkSync(chromeOut); } catch (_) { /* 留一份也无妨，删不掉就不删 */ }
  return outFile;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(DIST_DIR, { recursive: true });

  if (args.genKey) {
    genKey(resolve(ROOT, args.key));
    return;
  }

  if (args.verifyOnly) {
    const file = resolve(ROOT, args.verifyOnly);
    const result = verifyCrx3(readFileSync(file));
    console.log(`[crx] 校验 ${basename(file)}: ${result.ok ? 'OK' : 'FAILED'}`);
    console.log(`[crx] info: ${JSON.stringify(result.info)}`);
    for (const error of result.errors) console.error(`  ✖ ${error}`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const keyPath = resolve(ROOT, args.key);
  if (!existsSync(keyPath)) {
    console.log('[crx] 没有找到私钥，先生成一把：');
    genKey(keyPath);
  }
  const privateKey = loadPrivateKey(keyPath);

  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  const version = manifest.version || '0.0.0';
  const outFile = args.crxOut
    ? resolve(ROOT, args.crxOut)
    : join(DIST_DIR, `dsh-sidebar-${version}.crx`);

  let method = args.method;
  if (method === 'auto') method = findChromium() ? 'chrome' : 'native';

  if (method === 'chrome') {
    const chromePath = findChromium();
    if (!chromePath) {
      console.error('[crx] 未找到 Chrome/Edge 可执行文件；请用 --method native 或设置 CHROME_PATH。');
      process.exitCode = 1;
      return;
    }
    console.log(`[crx] 使用 Chrome 自带打包器：${chromePath}`);
    buildCrx3WithChrome(chromePath, keyPath, outFile);
    console.log(`[crx] 已生成：${outFile}`);
  } else if (method === 'native') {
    const files = collectFiles(EXTENSION_DIR, { includeDev: false });
    const zip = buildZip(files.map((file) => ({ name: file.name, data: readFileSync(file.path) })));
    console.log(`[crx] 已在内置打包 ${files.length} 个文件（zip ${zip.length} bytes）`);
    const crx = buildCrx3Native(zip, { privateKey });
    writeFileSync(outFile, crx);
    console.log(`[crx] 已生成（native CRX3，实验性）：${outFile} (${crx.length} bytes)`);
    if (args.verify) {
      const result = verifyCrx3(crx);
      console.log(`[crx] 产物自检：${result.ok ? 'OK' : 'FAILED'} ${JSON.stringify(result.info)}`);
      for (const error of result.errors) console.error(`  ✖ ${error}`);
      if (!result.ok) process.exitCode = 1;
    }
  } else {
    console.error(`[crx] 未知 method：${method}`);
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('[crx] 说明：');
  console.log('  · Chrome 从 2023 起不再支持双击安装本地 .crx（商店外面只允许企业策略分发）。');
  console.log('  · 常规分发请用 scripts/pack-extension.mjs 的 zip + “加载已解压的扩展程序”。');
  console.log('  · 用同一把 key 重新打包，扩展 ID 保持不变（便于固定 chrome-extension:// Origin 的 CORS 白名单）。');
  console.log('  · 保留 dist/extension-key.pem 私钥；扩展 ID = crx_id 的映射（a-p 字母表），丢了私钥就换了身份。');
}

main();
