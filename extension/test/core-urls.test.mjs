/**
 * URL / 站点判断 / bridge 地址规范化 的单元测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { core } from './helpers.mjs';

const {
  DEFAULT_BRIDGE_URL,
  isRestrictedUrl,
  parseUrlSafe,
  siteNameFromUrl,
  parseYouTubeUrl,
  normalizeBridgeUrl,
  buildBridgeEndpoints,
  isBridgeOrigin,
} = core;

test('isRestrictedUrl：chrome:// 与扩展页跳过，http(s)/file 允许', () => {
  const restricted = [
    'chrome://settings',
    'chrome-extension://abcdefghijklmnop/sidepanel.html',
    'chrome-untrusted://foo',
    'devtools://devtools/bundled/inspector.html',
    'edge://version',
    'about:blank',
    'view-source:https://example.com',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'blob:https://example.com/uuid',
    '',
    null,
  ];
  for (const url of restricted) {
    assert.equal(isRestrictedUrl(url), true, `应当跳过：${url}`);
  }
  for (const url of ['https://example.com/a', 'http://127.0.0.1:41789/', 'file:///C:/tmp/a.html']) {
    assert.equal(isRestrictedUrl(url), false, `不应当跳过：${url}`);
  }
});

test('parseUrlSafe：非法 URL 返回 null', () => {
  assert.equal(parseUrlSafe('not a url'), null);
  assert.ok(parseUrlSafe('https://example.com'));
});

test('siteNameFromUrl：走站点映射，未知域名回落到 hostname', () => {
  assert.equal(siteNameFromUrl('https://www.youtube.com/watch?v=abc'), 'YouTube');
  assert.equal(siteNameFromUrl('https://youtu.be/abc'), 'YouTube');
  assert.equal(siteNameFromUrl('https://www.zhihu.com/question/1'), '知乎');
  assert.equal(siteNameFromUrl('https://blog.example.org/post'), 'blog.example.org');
  assert.equal(siteNameFromUrl('https://example.com', '自定义站点'), '自定义站点');
  assert.equal(siteNameFromUrl('not-a-url'), '');
});

test('parseYouTubeUrl：watch / youtu.be / shorts / embed / music', () => {
  const watch = parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s');
  assert.deepEqual(
    { isYouTube: watch.isYouTube, videoId: watch.videoId },
    { isYouTube: true, videoId: 'dQw4w9WgXcQ' },
  );

  assert.equal(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=42').videoId, 'dQw4w9WgXcQ');

  const shorts = parseYouTubeUrl('https://www.youtube.com/shorts/abcdefghijk');
  assert.equal(shorts.videoId, 'abcdefghijk');
  assert.equal(shorts.isShorts, true);

  const embed = parseYouTubeUrl('https://www.youtube.com/embed/xyz987');
  assert.equal(embed.videoId, 'xyz987');
  assert.equal(embed.isEmbed, true);

  assert.equal(parseYouTubeUrl('https://music.youtube.com/watch?v=zzz').videoId, 'zzz');

  const nonYt = parseYouTubeUrl('https://vimeo.com/12345');
  assert.equal(nonYt.isYouTube, false);
  assert.equal(nonYt.videoId, '');

  assert.equal(parseYouTubeUrl('chrome://settings').isYouTube, false);
});

test('normalizeBridgeUrl：补协议/端口，去尾斜杠与查询串', () => {
  assert.equal(normalizeBridgeUrl(''), DEFAULT_BRIDGE_URL);
  assert.equal(normalizeBridgeUrl(null), DEFAULT_BRIDGE_URL);
  assert.equal(normalizeBridgeUrl('127.0.0.1:41789'), 'http://127.0.0.1:41789');
  assert.equal(normalizeBridgeUrl('http://127.0.0.1:41789/'), 'http://127.0.0.1:41789');
  assert.equal(normalizeBridgeUrl('http://127.0.0.1:41789/foo?x=1#h'), 'http://127.0.0.1:41789');
  assert.equal(normalizeBridgeUrl('https://bridge.example.com'), 'https://bridge.example.com:41789');
  assert.equal(normalizeBridgeUrl('ftp://example.com'), DEFAULT_BRIDGE_URL);
  assert.equal(normalizeBridgeUrl('http://localhost:41800'), 'http://localhost:41800');
});

test('buildBridgeEndpoints：派生 4 个端点', () => {
  const endpoints = buildBridgeEndpoints('http://127.0.0.1:41789/');
  assert.equal(endpoints.base, 'http://127.0.0.1:41789');
  assert.equal(endpoints.health, 'http://127.0.0.1:41789/__bridge/health');
  assert.equal(endpoints.context, 'http://127.0.0.1:41789/__bridge/context');
  assert.equal(endpoints.latest, 'http://127.0.0.1:41789/__bridge/context/latest');
  assert.equal(endpoints.list, 'http://127.0.0.1:41789/__bridge/context/list');
});

test('isBridgeOrigin：同源判断（端口不同即不同源）', () => {
  assert.equal(isBridgeOrigin('http://127.0.0.1:41789/x', 'http://127.0.0.1:41789'), true);
  assert.equal(isBridgeOrigin('http://127.0.0.1:41790/x', 'http://127.0.0.1:41789'), false);
  assert.equal(isBridgeOrigin('https://127.0.0.1:41789/x', 'http://127.0.0.1:41789'), false);
});
