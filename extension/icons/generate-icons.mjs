/*!
 * 图标生成脚本（无第三方依赖，纯 node:zlib 手写 PNG）
 * ---------------------------------------------------------------------------
 * 用法：node extension/icons/generate-icons.mjs
 *
 * Chrome 的 manifest 需要 16/32/48/128 的 PNG；这里用 4x 超采样 + 简单几何形状
 * （圆角方块 + 右侧面板条 + 两条文字线）生成占位图标，风格与 side panel 的靛蓝主色一致。
 * 换正式设计稿时直接替换同名的 4 个 PNG 即可，不需要改这个脚本。
 */

import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

// ---------------------------------------------------------------------------
// PNG 编码
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
    try { return zlibCrc32(buffer) >>> 0; } catch (_) { /* 老版本 node 退回手写实现 */ }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/** RGBA 像素数组（size*size*4）→ PNG buffer */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 几何绘制（归一化坐标 0..1）
// ---------------------------------------------------------------------------

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function blend(target, offset, r, g, b, a) {
  if (a <= 0) return;
  const alpha = target[offset + 3] / 255;
  const outA = a + alpha * (1 - a);
  if (outA <= 0) return;
  target[offset] = Math.round((r * a + target[offset] * alpha * (1 - a)) / outA);
  target[offset + 1] = Math.round((g * a + target[offset + 1] * alpha * (1 - a)) / outA);
  target[offset + 2] = Math.round((b * a + target[offset + 2] * alpha * (1 - a)) / outA);
  target[offset + 3] = Math.round(outA * 255);
}

/** 在归一化坐标 (u,v) 处判断该点颜色；返回 [r,g,b,a] 或 null */
function shade(u, v) {
  // 背景：圆角方块 + 自上而下的靛蓝渐变
  if (!insideRoundRect(u, v, 0.015, 0.015, 0.985, 0.985, 0.21)) return null;
  const t = Math.min(1, Math.max(0, (v - 0.015) / 0.97));
  const bg = [
    Math.round(0x5b + (0x8b - 0x5b) * t),
    Math.round(0x5b + (0x6b - 0x5b) * t),
    Math.round(0xd6 + (0xf0 - 0xd6) * t),
    1,
  ];
  // 右侧「面板条」：白色 0.95
  if (insideRoundRect(u, v, 0.585, 0.235, 0.845, 0.765, 0.055)) {
    return [255, 255, 255, 0.95];
  }
  // 左侧两条「文字线」：白色 0.78 / 0.6
  if (insideRoundRect(u, v, 0.185, 0.325, 0.495, 0.4, 0.035)) return [255, 255, 255, 0.82];
  if (insideRoundRect(u, v, 0.185, 0.5, 0.455, 0.575, 0.035)) return [255, 255, 255, 0.6];
  return bg;
}

function render(size) {
  const hi = size * SUPERSAMPLE;
  const rgba = Buffer.alloc(size * size * 4, 0);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const u = (x * SUPERSAMPLE + sx + 0.5) / hi;
          const v = (y * SUPERSAMPLE + sy + 0.5) / hi;
          const color = shade(u, v);
          if (!color) continue;
          r += color[0] * color[3];
          g += color[1] * color[3];
          b += color[2] * color[3];
          a += color[3];
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (y * size + x) * 4;
      if (a > 0) {
        rgba[offset] = Math.round(r / a);
        rgba[offset + 1] = Math.round(g / a);
        rgba[offset + 2] = Math.round(b / a);
      }
      rgba[offset + 3] = Math.round((a / samples) * 255);
    }
  }
  return rgba;
}

for (const size of SIZES) {
  const png = encodePng(render(size), size);
  const target = join(HERE, `icon${size}.png`);
  writeFileSync(target, png);
  // eslint-disable-next-line no-console
  console.log(`wrote ${target} (${png.length} bytes)`);
}
