/**
 * 快照构建 / 校验 / 设置规范化 的单元测试
 * 重点：最终 JSON 形状必须与规格 §2「上下文模型」逐字段一致，且截断上限不可被绕过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core } from './helpers.mjs';

const {
  LIMITS,
  DEFAULT_SETTINGS,
  DEFAULT_BRIDGE_URL,
  buildSnapshot,
  validateSnapshot,
  snapshotSignature,
  snapshotSummary,
  normalizeSettings,
  patchSettings,
  settingsToLimits,
  uuid,
} = core;

const EXPECTED_TOP_KEYS = [
  'active', 'capturedAt', 'content', 'id', 'meta', 'selection',
  'siteName', 'tabId', 'title', 'url', 'video', 'windowId',
].sort();

function makeDraft(overrides) {
  return Object.assign({
    tabId: 42,
    windowId: 1,
    active: true,
    url: 'https://example.com/post/1',
    title: '示例文章',
    siteName: 'example.com',
    selection: '选中的一段话',
    meta: {
      description: '摘要',
      ogImage: 'https://example.com/cover.png',
      author: '作者A',
      publishedAt: '2026-01-02T03:04:05Z',
      lang: 'zh',
    },
    content: { text: '正文内容。'.repeat(100) },
    video: {
      kind: 'none',
      title: '',
      author: '',
      durationSec: 0,
      currentTimeSec: 0,
      transcriptSource: 'none',
      cues: [],
    },
  }, overrides || {});
}

test('buildSnapshot：字段集合与规格完全一致', () => {
  const snapshot = buildSnapshot(makeDraft());
  assert.deepEqual(Object.keys(snapshot).sort(), EXPECTED_TOP_KEYS);
  assert.deepEqual(Object.keys(snapshot.meta).sort(), ['author', 'description', 'lang', 'ogImage', 'publishedAt']);
  assert.deepEqual(Object.keys(snapshot.content).sort(), ['charCount', 'text', 'truncated']);
  assert.deepEqual(
    Object.keys(snapshot.video).sort(),
    ['author', 'currentTimeSec', 'durationSec', 'kind', 'title', 'transcript', 'transcriptSource'],
  );
  assert.equal(validateSnapshot(snapshot).ok, true);
});

test('buildSnapshot：id 是 uuid、capturedAt 是 ISO、tabId/windowId 为整数', () => {
  const snapshot = buildSnapshot(makeDraft());
  assert.match(snapshot.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(new Date(snapshot.capturedAt).toISOString(), snapshot.capturedAt);
  assert.equal(Number.isInteger(snapshot.tabId), true);
  assert.equal(Number.isInteger(snapshot.windowId), true);
});

test('buildSnapshot：capturedAt 非法时回落到当前时间', () => {
  const snapshot = buildSnapshot(makeDraft({ capturedAt: 'not-a-date' }));
  assert.equal(Number.isNaN(Date.parse(snapshot.capturedAt)), false);
});

test('buildSnapshot：正文超限截断到 60000 并标记 truncated', () => {
  const snapshot = buildSnapshot(makeDraft({ content: { text: 'a'.repeat(70000) } }));
  assert.equal(snapshot.content.truncated, true);
  assert.equal(snapshot.content.charCount, LIMITS.contentChars);
  assert.equal(snapshot.content.text.length, LIMITS.contentChars);
  assert.equal(validateSnapshot(snapshot).ok, true);
});

test('buildSnapshot：设置里的较小上限生效（但不超过规格上限）', () => {
  const snapshot = buildSnapshot(makeDraft({
    content: { text: 'b'.repeat(5000) },
    limits: { contentChars: 1000, transcriptItems: 10, transcriptChars: 1000 },
  }));
  assert.equal(snapshot.content.charCount, 1000);
  assert.equal(snapshot.content.truncated, true);

  const overLimit = buildSnapshot(makeDraft({ limits: { contentChars: 999999, transcriptItems: 999999, transcriptChars: 9999999 } }));
  assert.ok(overLimit.content.charCount <= LIMITS.contentChars);
});

test('buildSnapshot：字幕 ≤5000 条 / ≤80000 字符，且标记 truncated 由条数驱动', () => {
  const cues = Array.from({ length: 6000 }, (_, i) => ({ start: i, end: i + 1, text: `第${i}条字幕` }));
  const snapshot = buildSnapshot(makeDraft({
    video: {
      kind: 'youtube',
      title: '视频标题',
      author: '频道',
      durationSec: 600,
      currentTimeSec: 12,
      transcriptSource: 'youtube-captions',
      cues,
    },
  }));
  assert.equal(snapshot.video.transcript.length, LIMITS.transcriptItems);
  assert.equal(snapshot.video.transcriptSource, 'youtube-captions');
  assert.equal(snapshot.video.kind, 'youtube');
  // 条数被截断 → 内容确实少了（charCount 无法直接暴露，检查最后一条不是第 5999 条）
  assert.notEqual(snapshot.video.transcript[snapshot.video.transcript.length - 1].text, '第5999条字幕');
  assert.equal(validateSnapshot(snapshot).ok, true);
});

test('buildSnapshot：video.kind=none 时 transcriptSource 强制 none', () => {
  const snapshot = buildSnapshot(makeDraft({
    video: { kind: 'none', transcriptSource: 'youtube-captions', cues: [{ start: 0, end: 1, text: 'x' }] },
  }));
  assert.equal(snapshot.video.kind, 'none');
  assert.equal(snapshot.video.transcriptSource, 'none');
  assert.equal(snapshot.video.transcript.length, 1);
});

test('buildSnapshot：声明 track 但无字幕时回落 page-text', () => {
  const snapshot = buildSnapshot(makeDraft({
    video: { kind: 'html5', transcriptSource: 'track', cues: [] },
  }));
  assert.equal(snapshot.video.transcriptSource, 'page-text');
});

test('buildSnapshot：selection 超长截断，字符串字段类型稳定', () => {
  const snapshot = buildSnapshot(makeDraft({ selection: 's'.repeat(LIMITS.selectionChars + 100) }));
  assert.equal(snapshot.selection.length, LIMITS.selectionChars);
  assert.equal(typeof snapshot.title, 'string');
  assert.equal(typeof snapshot.siteName, 'string');
  assert.equal(typeof snapshot.meta.author, 'string');
});

test('buildSnapshot：缺字段/空输入也能产出合法结构（防御性）', () => {
  const snapshot = buildSnapshot({});
  assert.equal(validateSnapshot(snapshot).ok, true);
  assert.equal(snapshot.content.text, '');
  assert.equal(snapshot.content.charCount, 0);
  assert.equal(snapshot.video.kind, 'none');
  assert.equal(snapshot.video.transcriptSource, 'none');
  assert.equal(snapshot.tabId, -1);
});

test('validateSnapshot：能指出结构问题', () => {
  assert.equal(validateSnapshot(null).ok, false);
  assert.equal(validateSnapshot([]).ok, false);

  const missing = buildSnapshot(makeDraft());
  delete missing.content;
  const missingResult = validateSnapshot(missing);
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.errors.some((e) => e.includes('content')));

  const wrongType = buildSnapshot(makeDraft());
  wrongType.tabId = '42';
  assert.equal(validateSnapshot(wrongType).ok, false);

  const overLimit = buildSnapshot(makeDraft());
  overLimit.content.text = 'a'.repeat(LIMITS.contentChars + 1);
  overLimit.content.charCount = overLimit.content.text.length;
  const overResult = validateSnapshot(overLimit);
  assert.equal(overResult.ok, false);
  assert.ok(overResult.errors.some((e) => e.includes('60000')));

  const badKind = buildSnapshot(makeDraft());
  badKind.video.kind = 'mp4';
  assert.equal(validateSnapshot(badKind).ok, false);

  const badSource = buildSnapshot(makeDraft());
  badSource.video.transcriptSource = 'ocr';
  assert.equal(validateSnapshot(badSource).ok, false);

  const badTranscript = buildSnapshot(makeDraft());
  badTranscript.video.transcript = [{ start: '0', end: 1, text: 'x' }];
  assert.equal(validateSnapshot(badTranscript).ok, false);

  const mismatch = buildSnapshot(makeDraft());
  mismatch.content.charCount = 1;
  assert.equal(validateSnapshot(mismatch).ok, false);
});

test('validateSnapshot：字幕条数/字符超限也能识别', () => {
  const snapshot = buildSnapshot(makeDraft());
  snapshot.video.transcript = Array.from({ length: LIMITS.transcriptItems + 1 }, (_, i) => ({
    start: i, end: i + 1, text: 'x',
  }));
  const result = validateSnapshot(snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('5000')));
});

test('snapshotSignature：内容不变签名稳定，正文/选中/字幕变化签名改变', () => {
  const a = buildSnapshot(makeDraft());
  const b = buildSnapshot(makeDraft());
  assert.equal(snapshotSignature(a), snapshotSignature(b));

  const changedContent = buildSnapshot(makeDraft({ content: { text: '完全不同的内容'.repeat(200) } }));
  assert.notEqual(snapshotSignature(a), snapshotSignature(changedContent));

  const changedSelection = buildSnapshot(makeDraft({ selection: '另一段选中文本' }));
  assert.notEqual(snapshotSignature(a), snapshotSignature(changedSelection));

  const withVideo = buildSnapshot(makeDraft({
    video: { kind: 'html5', transcriptSource: 'track', cues: [{ start: 0, end: 1, text: 'cue' }] },
  }));
  assert.notEqual(snapshotSignature(a), snapshotSignature(withVideo));
});

test('snapshotSummary：给工具条用的摘要', () => {
  const plain = snapshotSummary(buildSnapshot(makeDraft()));
  assert.equal(plain.ok, true);
  assert.ok(plain.label.includes('正文'));
  assert.equal(plain.hasVideo, false);
  assert.equal(plain.hasSelection, true);

  const withVideo = snapshotSummary(buildSnapshot(makeDraft({
    video: { kind: 'youtube', transcriptSource: 'youtube-captions', cues: [{ start: 0, end: 1, text: 'a' }] },
  })));
  assert.equal(withVideo.hasVideo, true);
  assert.ok(withVideo.label.includes('YouTube'));
  assert.ok(withVideo.label.includes('字幕'));
  assert.equal(withVideo.transcriptCount, 1);

  assert.equal(snapshotSummary(null).ok, false);
});

test('normalizeSettings：默认值与规格上限一致', () => {
  const settings = normalizeSettings({});
  assert.equal(settings.bridgeUrl, DEFAULT_BRIDGE_URL);
  assert.equal(settings.autoSync, true);
  assert.equal(settings.throttleMs, 1500);
  assert.equal(settings.maxContentChars, 60000);
  assert.equal(settings.maxTranscriptItems, 5000);
  assert.equal(settings.maxTranscriptChars, 80000);
  assert.equal(settings.requestTimeoutMs, 3000);
  assert.deepEqual(settingsToLimits(settings), {
    contentChars: 60000,
    transcriptItems: 5000,
    transcriptChars: 80000,
  });
});

test('normalizeSettings：越界值夹紧，规格上限不可被放大', () => {
  const settings = normalizeSettings({
    bridgeUrl: '127.0.0.1:41789',
    autoSync: 'yes',
    throttleMs: 10,
    maxContentChars: 999999,
    maxTranscriptItems: 999999,
    maxTranscriptChars: 9999999,
    requestTimeoutMs: 1,
  });
  assert.equal(settings.bridgeUrl, 'http://127.0.0.1:41789');
  assert.equal(settings.autoSync, true);
  assert.equal(settings.throttleMs, 300);
  assert.equal(settings.maxContentChars, LIMITS.contentChars);
  assert.equal(settings.maxTranscriptItems, LIMITS.transcriptItems);
  assert.equal(settings.maxTranscriptChars, LIMITS.transcriptChars);
  assert.equal(settings.requestTimeoutMs, 500);
});

test('patchSettings：局部更新且结果总是被规范化', () => {
  const base = normalizeSettings({});
  const next = patchSettings(base, { autoSync: false, bridgeUrl: 'localhost:41800' });
  assert.equal(next.autoSync, false);
  assert.equal(next.bridgeUrl, 'http://localhost:41800');
  assert.equal(next.maxContentChars, base.maxContentChars);
  assert.equal(base.autoSync, true, '原对象不应被修改');
});

test('uuid：格式合法且不重复', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i += 1) ids.add(uuid());
  assert.equal(ids.size, 50);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  }
});
