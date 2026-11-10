/**
 * Bridge 契约测试：用 test/mock-bridge.mjs 起一个真实 HTTP 服务，
 * 验证扩展推送的 JSON 结构、CORS 行为、错误处理与超时语义。
 *
 * 这是「扩展侧 ⇄ bridge 侧」唯一可自动化的契约层，等真实 dsh-browser-sidecar 就绪后
 * 可以把这个 mock 换成真 bridge 再跑同一批断言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core, net, h, p, meta, makeDocument, makeArticleDocument } from './helpers.mjs';
import { createMockBridge } from './mock-bridge.mjs';

const { buildSnapshot, validateSnapshot, LIMITS } = core;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sampleSnapshot(overrides) {
  return buildSnapshot(Object.assign({
    tabId: 7,
    windowId: 2,
    active: true,
    url: 'https://example.com/article',
    title: '契约测试文章',
    siteName: 'example.com',
    selection: '选中文本',
    meta: { description: '摘要', ogImage: '', author: '作者', publishedAt: '', lang: 'zh' },
    content: { text: '正文内容，用于契约测试。'.repeat(20) },
    video: {
      kind: 'youtube',
      title: '视频',
      author: '频道',
      durationSec: 120,
      currentTimeSec: 30,
      transcriptSource: 'youtube-captions',
      cues: [{ start: 0, end: 2.5, text: '第一句字幕' }, { start: 2.5, end: 5, text: '第二句字幕' }],
    },
  }, overrides || {}));
}

test('GET /__bridge/health：返回规格形状 {ok, version, upstream, context}', async (t) => {
  const bridge = await createMockBridge({ port: 0 });
  t.after(() => bridge.close());

  const result = await net.getJson(`${bridge.url}/__bridge/health`, { timeoutMs: 3000 });
  assert.equal(result.ok, true);
  assert.equal(result.data.ok, true);
  assert.equal(typeof result.data.version, 'string');
  assert.equal(result.data.upstream.ok, true);
  assert.equal(typeof result.data.upstream.port, 'number');
  assert.equal(typeof result.data.context.tabs, 'number');
});

test('POST /__bridge/context → GET latest：快照结构完整往返', async (t) => {
  const bridge = await createMockBridge({ port: 0 });
  t.after(() => bridge.close());

  const snapshot = sampleSnapshot();
  const post = await net.postJson(`${bridge.url}/__bridge/context`, snapshot, { timeoutMs: 3000 });
  assert.equal(post.ok, true, post.error);
  assert.equal(post.data.ok, true);
  assert.equal(post.data.id, snapshot.id);
  assert.equal(Number.isNaN(Date.parse(post.data.updatedAt)), false);

  const latest = await net.getJson(`${bridge.url}/__bridge/context/latest?tabId=7`, { timeoutMs: 3000 });
  assert.equal(latest.ok, true, latest.error);
  const received = latest.data;
  assert.deepEqual(received, snapshot, 'bridge 应原样保存快照');
  assert.equal(validateSnapshot(received).ok, true);
  // 规格关键字段抽查
  assert.equal(received.tabId, 7);
  assert.equal(received.windowId, 2);
  assert.equal(received.active, true);
  assert.equal(received.video.kind, 'youtube');
  assert.equal(received.video.transcriptSource, 'youtube-captions');
  assert.equal(received.video.transcript.length, 2);
  assert.equal(typeof received.content.charCount, 'number');
});

test('GET latest：无快照返回 404 且带可读错误', async (t) => {
  const bridge = await createMockBridge({ port: 0 });
  t.after(() => bridge.close());

  const result = await net.getJson(`${bridge.url}/__bridge/context/latest`, { timeoutMs: 3000 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.ok(result.error.includes('404'));
});

test('GET list：返回各标签摘要（含 video.kind）', async (t) => {
  const bridge = await createMockBridge({ port: 0 });
  t.after(() => bridge.close());

  await net.postJson(`${bridge.url}/__bridge/context`, sampleSnapshot({ tabId: 1 }), { timeoutMs: 3000 });
  await net.postJson(`${bridge.url}/__bridge/context`, sampleSnapshot({
    tabId: 2,
    url: 'https://example.com/plain',
    video: { kind: 'none', transcriptSource: 'none', cues: [] },
  }), { timeoutMs: 3000 });

  const list = await net.getJson(`${bridge.url}/__bridge/context/list`, { timeoutMs: 3000 });
  assert.equal(list.ok, true);
  assert.equal(list.data.ok, true);
  assert.equal(list.data.tabs.length, 2);
  const first = list.data.tabs.find((entry) => entry.tabId === 1);
  const second = list.data.tabs.find((entry) => entry.tabId === 2);
  assert.equal(first.video.kind, 'youtube');
  assert.equal(second.video.kind, 'none');
  assert.equal(typeof first.updatedAt, 'string');
});

test('POST /__bridge/context：结构不合规的快照被 400 拒绝（bridge 侧防线）', async (t) => {
  const bridge = await createMockBridge({ port: 0 });
  t.after(() => bridge.close());

  const bad = await net.postJson(`${bridge.url}/__bridge/context`, { id: 'x', content: { text: 'y' } }, { timeoutMs: 3000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal(bridge.state.posts.length, 0);

  // 超规格正文同样应被拒
  const oversized = sampleSnapshot();
  oversized.content.text = 'a'.repeat(LIMITS.contentChars + 10);
  oversized.content.charCount = oversized.content.text.length;
  const rejected = await net.postJson(`${bridge.url}/__bridge/context`, oversized, { timeoutMs: 3000 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 400);
});

test('POST /__bridge/context：非 JSON 请求体被 400 拒绝且不崩服务', async (t) => {
  const bridge = await createMockBridge({ port: 0 });
  t.after(() => bridge.close());

  const response = await fetch(`${bridge.url}/__bridge/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json at all',
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.ok, false);

  const health = await net.getJson(`${bridge.url}/__bridge/health`, { timeoutMs: 3000 });
  assert.equal(health.ok, true);
});

test('CORS：chrome-extension:// 的 Origin 被回显（含 OPTIONS 预检）', async (t) => {
  const bridge = await createMockBridge({ port: 0 });
  t.after(() => bridge.close());

  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const preflight = await fetch(`${bridge.url}/__bridge/context`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.ok(preflight.headers.get('access-control-allow-methods').includes('POST'));
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type');
  assert.equal(preflight.headers.get('access-control-max-age'), '600');

  const health = await fetch(`${bridge.url}/__bridge/health`, { headers: { Origin: origin } });
  assert.equal(health.headers.get('access-control-allow-origin'), origin);
});

test('未知路由返回 404 JSON', async (t) => {
  const bridge = await createMockBridge({ port: 0 });
  t.after(() => bridge.close());

  const result = await net.getJson(`${bridge.url}/__bridge/nope`, { timeoutMs: 3000 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('网络层：3s 超时语义（超时返回 ok=false 且不抛异常）', async (t) => {
  const bridge = await createMockBridge({ port: 0 });
  t.after(() => bridge.close());

  const started = Date.now();
  const result = await net.getJson(`${bridge.url}/__slow?ms=900`, { timeoutMs: 150 });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('超时'), result.error);
  assert.ok(elapsed < 700, `应当提前放弃，实际 ${elapsed}ms`);
});

test('网络层：连接失败（端口未监听）返回 ok=false', async () => {
  // 取一个几乎肯定没人监听的端口
  const result = await net.getJson('http://127.0.0.1:1/__bridge/health', { timeoutMs: 800 });
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === 'string' && result.error.length > 0);
});

test('网络层：withRetry 失败重试 1 次（最多 2 次尝试）', async () => {
  let attempts = 0;
  const result = await net.withRetry(async () => {
    attempts += 1;
    return attempts === 1 ? { ok: false, error: '第一次失败' } : { ok: true, data: { attempt: attempts } };
  }, { retries: 1, delayMs: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.data.attempt, 2);

  let alwaysFailCalls = 0;
  const failed = await net.withRetry(async () => {
    alwaysFailCalls += 1;
    return { ok: false, error: 'boom' };
  }, { retries: 1, delayMs: 10 });
  assert.equal(failed.ok, false);
  assert.equal(alwaysFailCalls, 2);
  assert.equal(failed.attempts, 2);
});

test('端到端：真实抽取 → buildSnapshot → POST → latest 全链路（文章页）', async (t) => {
  const bridge = await createMockBridge({ port: 0 });
  t.after(() => bridge.close());

  // 1) 用 DOM stub 模拟 content script 的抽取
  const doc = makeArticleDocument({ title: '端到端文章', author: '李四' });
  const main = core.extractMainContent(doc, { maxChars: LIMITS.contentChars });
  const metaOut = core.extractMeta(doc, 'https://example.com/post/1');
  const selection = core.extractSelection({ getSelection: () => ({ toString: () => '用户选中的文字' }) });
  const info = core.extractVideoInfo(doc, 'https://example.com/post/1');

  // 2) SW 侧组装快照（与 background.js 相同路径）
  const snapshot = buildSnapshot({
    tabId: 11,
    windowId: 3,
    active: true,
    url: 'https://example.com/post/1',
    title: core.extractTitle(doc),
    siteName: core.siteNameFromUrl('https://example.com/post/1'),
    selection,
    meta: metaOut,
    content: main,
    video: info,
    limits: core.settingsToLimits(core.normalizeSettings({})),
  });

  // 3) 推送 + 回读
  const post = await net.postJson(`${bridge.url}/__bridge/context`, snapshot, { timeoutMs: 3000 });
  assert.equal(post.ok, true, post.error);
  const latest = await net.getJson(`${bridge.url}/__bridge/context/latest?tabId=11`, { timeoutMs: 3000 });
  assert.equal(latest.ok, true);

  const received = latest.data;
  assert.equal(received.id, snapshot.id);
  assert.equal(received.tabId, 11);
  assert.ok(received.content.text.includes('这是正文第一段'));
  assert.equal(received.video.kind, 'none');
  assert.equal(received.selection, '用户选中的文字');
  assert.equal(received.meta.author, '李四');
  assert.equal(validateSnapshot(received).ok, true);
  assert.equal(bridge.state.posts.length, 1);
  assert.equal(bridge.state.postErrors.length, 0);
});

test('端到端：B 站字幕快照（kind=bilibili）也能通过契约', async (t) => {
  const bridge = await createMockBridge({ port: 0 });
  t.after(() => bridge.close());

  const cues = [
    { start: 0, end: 2.53, text: '大家好，欢迎收看' },
    { start: 2.53, end: 5.1, text: '这期视频聊聊浏览器扩展' },
    { start: 5.1, end: 8.2, text: '先看架构图' },
  ];
  const snapshot = buildSnapshot({
    tabId: 31,
    windowId: 1,
    active: true,
    url: 'https://www.bilibili.com/video/BV1MEW46JEYB/',
    title: '【测试】用 10 分钟讲清楚浏览器扩展',
    siteName: '哔哩哔哩',
    selection: '',
    meta: { description: '视频简介', author: '示例 UP 主', lang: 'zh' },
    content: { text: '页面正文（B 站视频页文字）' },
    video: {
      kind: 'bilibili',
      title: '【测试】用 10 分钟讲清楚浏览器扩展',
      author: '示例 UP 主',
      durationSec: 634,
      currentTimeSec: 42,
      transcriptSource: 'bilibili-page',
      cues,
    },
  });

  assert.equal(validateSnapshot(snapshot).ok, true);
  const post = await net.postJson(`${bridge.url}/__bridge/context`, snapshot, { timeoutMs: 3000 });
  assert.equal(post.ok, true, post.error);

  const latest = await net.getJson(`${bridge.url}/__bridge/context/latest?tabId=31`, { timeoutMs: 3000 });
  assert.equal(latest.ok, true);
  assert.equal(latest.data.video.kind, 'bilibili');
  assert.equal(latest.data.video.transcriptSource, 'bilibili-page');
  assert.equal(latest.data.video.transcript.length, 3);
  assert.equal(latest.data.video.title, '【测试】用 10 分钟讲清楚浏览器扩展');
  assert.equal(validateSnapshot(latest.data).ok, true);
});

test('端到端：视频页快照（page-text 兜底）也能通过契约', async (t) => {
  const bridge = await createMockBridge({ port: 0 });
  t.after(() => bridge.close());

  const doc = makeDocument({
    title: '视频页',
    head: [meta('og:title', '视频页标题', 'property'), meta('description', '视频简介')],
    body: h('body', {},
      h('h1', {}, '视频页标题'),
      p('这是视频页的第一段文字内容，用来做 page-text 兜底字幕。'),
      p('这是视频页的第二段文字内容，同样用来做兜底。')),
  });
  const lines = core.collectPageTextLines(doc, { pageUrl: 'https://example.com/v' });
  const snapshot = buildSnapshot({
    tabId: 12,
    windowId: 3,
    active: true,
    url: 'https://example.com/v',
    title: '视频页标题',
    siteName: 'example.com',
    content: { text: '页面正文' },
    video: {
      kind: 'html5',
      title: '视频页标题',
      author: '',
      durationSec: 300,
      currentTimeSec: 5,
      transcriptSource: 'page-text',
      cues: lines.lines.map((text) => ({ start: 0, end: 0, text })),
    },
  });
  const post = await net.postJson(`${bridge.url}/__bridge/context`, snapshot, { timeoutMs: 3000 });
  assert.equal(post.ok, true, post.error);
  const latest = await net.getJson(`${bridge.url}/__bridge/context/latest?tabId=12`, { timeoutMs: 3000 });
  assert.equal(latest.data.video.transcriptSource, 'page-text');
  assert.ok(latest.data.video.transcript.length > 0);
  await wait(5);
});
