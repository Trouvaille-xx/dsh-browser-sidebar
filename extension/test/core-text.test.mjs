/**
 * 文本清洗 / 截断 / 哈希 的单元测试
 * 覆盖：规格里的超长截断（正文 60000）、噪音行过滤、空白规范化。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core } from './helpers.mjs';

const {
  LIMITS,
  normalizeText,
  truncateText,
  stripNoiseLines,
  dedupeConsecutiveLines,
  countChars,
  hashString,
  clampInt,
} = core;

test('normalizeText：统一换行/去零宽、折叠空格、压掉多余空行', () => {
  assert.equal(normalizeText('  a\u00a0b  \r\n\r\n\n c '), 'a b\n\nc');
  assert.equal(normalizeText('a\u200bb'), 'ab');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText('\n\n\n'), '');
  assert.equal(normalizeText('第一段\n\n\n\n第二段'), '第一段\n\n第二段');
});

test('countChars：按 UTF-16 code unit 计数，空值安全', () => {
  assert.equal(countChars('中文abc'), 5);
  assert.equal(countChars(''), 0);
  assert.equal(countChars(null), 0);
  assert.equal(countChars(undefined), 0);
});

test('clampInt：越界夹紧、非法值回落', () => {
  assert.equal(clampInt(5, 0, 10, 3), 5);
  assert.equal(clampInt(-1, 0, 10, 3), 0);
  assert.equal(clampInt(11, 0, 10, 3), 10);
  assert.equal(clampInt('7', 0, 10, 3), 7);
  assert.equal(clampInt('abc', 0, 10, 3), 3);
  assert.equal(clampInt(NaN, 0, 10, 3), 3);
});

test('truncateText：短文本原样返回，不标记截断', () => {
  const out = truncateText('hello world', 100);
  assert.equal(out.text, 'hello world');
  assert.equal(out.truncated, false);
  assert.equal(out.charCount, 11);
  assert.equal(out.originalCharCount, 11);
});

test('truncateText：超过上限时截断并标记，charCount 不超过上限', () => {
  const raw = 'a'.repeat(LIMITS.contentChars + 10000);
  const out = truncateText(raw, LIMITS.contentChars);
  assert.equal(out.truncated, true);
  assert.equal(out.originalCharCount, LIMITS.contentChars + 10000);
  assert.ok(out.charCount <= LIMITS.contentChars, `charCount=${out.charCount}`);
  assert.ok(out.text.length <= LIMITS.contentChars);
});

test('truncateText：优先在换行处断开，避免半句', () => {
  const raw = `${'x'.repeat(59000)}\n${'y'.repeat(2000)}`;
  const out = truncateText(raw, 60000);
  assert.equal(out.truncated, true);
  assert.equal(out.charCount, 59000, '应当在换行处断开');
  assert.ok(!out.text.includes('y'));
});

test('truncateText：maxChars=0 时返回空串但仍标记截断', () => {
  const out = truncateText('abcdef', 0);
  assert.equal(out.text, '');
  assert.equal(out.charCount, 0);
  assert.equal(out.truncated, true);
});

test('stripNoiseLines：丢导航词/纯符号/纯数字/连续重复行', () => {
  const raw = [
    '这是正文第一段，内容足够长。',
    '登录',
    '首页',
    '•••••',
    '123456',
    '这是正文第一段，内容足够长。',
    '这是正文第二段，内容也足够长。',
    '广告',
  ].join('\n');
  const out = stripNoiseLines(raw, { aggressive: true });
  assert.equal(out, '这是正文第一段，内容足够长。\n这是正文第二段，内容也足够长。');
});

test('stripNoiseLines：aggressive 模式额外丢全页重复串与过短碎片', () => {
  const raw = [
    '真的正文内容，需要保留下来。',
    '真的正文内容，需要保留下来。',
    '页脚链接A',
    '页脚链接A',
    'X',
  ].join('\n');
  const out = stripNoiseLines(raw, { aggressive: true });
  assert.equal(out, '真的正文内容，需要保留下来。\n页脚链接A');
});

test('dedupeConsecutiveLines：合并相邻重复行但保留非相邻重复', () => {
  const raw = 'a\na\nb\na';
  assert.equal(dedupeConsecutiveLines(raw), 'a\nb\na');
  assert.equal(dedupeConsecutiveLines(''), '');
});

test('hashString：稳定、定长、对内容敏感', () => {
  const a = hashString('hello world');
  const b = hashString('hello world');
  const c = hashString('hello worle');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.length > 0);
});
