/**
 * /__bridge/* API behaviour: CORS, snapshot ingest, latest/list, validation,
 * truncation, body cap and 404/405 paths.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createBridgeHandler } from '../bridge.js';
import { ContextStore } from '../context-store.js';
import { LIMITS } from '../core.js';
import { httpRequest } from './support/http-client.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function validSnapshot(overrides = {}) {
  return {
    tabId: 123,
    windowId: 1,
    active: true,
    url: 'https://example.com/article',
    title: '示例文章',
    siteName: 'example.com',
    capturedAt: '2026-11-10T12:00:00.000Z',
    selection: '',
    content: { text: '正文内容', charCount: 4, truncated: false },
    ...overrides,
  };
}

describe('bridge API', () => {
  let server;
  let port;
  let store;

  before(async () => {
    store = new ContextStore();
    let handler;
    const bridge = createBridgeHandler({
      store,
      getHealth: () => ({
        version: '1.0.0',
        uptimeMs: 42,
        upstream: { port: 4064, authReady: true, lastAuthError: null },
      }),
      logger: silentLogger,
    });
    handler = bridge;
    server = http.createServer((req, res) => {
      handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1')).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  describe('CORS', () => {
    it('answers a chrome-extension preflight with echo, methods and Max-Age', async () => {
      const response = await httpRequest({
        port,
        method: 'OPTIONS',
        path: '/__bridge/context',
        headers: {
          origin: 'chrome-extension://abcdefghijklmnop',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers['access-control-allow-origin'], 'chrome-extension://abcdefghijklmnop');
      assert.match(String(response.headers['access-control-allow-methods']), /POST/);
      assert.match(String(response.headers['access-control-allow-methods']), /GET/);
      assert.match(String(response.headers['access-control-allow-methods']), /OPTIONS/);
      assert.match(String(response.headers['access-control-allow-headers']), /content-type/);
      assert.equal(response.headers['access-control-max-age'], '600');
    });

    it('echoes a loopback http origin (devtools / options page testing)', async () => {
      const response = await httpRequest({
        port,
        method: 'OPTIONS',
        path: '/__bridge/health',
        headers: { origin: 'http://127.0.0.1:5173' },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers['access-control-allow-origin'], 'http://127.0.0.1:5173');
    });

    it('refuses any other browser origin', async () => {
      const preflight = await httpRequest({
        port,
        method: 'OPTIONS',
        path: '/__bridge/health',
        headers: { origin: 'https://evil.example' },
      });
      assert.equal(preflight.status, 403);
      assert.equal(preflight.headers['access-control-allow-origin'], undefined);
      assert.equal(preflight.json.error.code, 'forbidden-origin');

      const read = await httpRequest({
        port,
        path: '/__bridge/health',
        headers: { origin: 'https://evil.example' },
      });
      assert.equal(read.status, 403);
      assert.equal(read.json.error.code, 'forbidden-origin');
    });

    it('allows local tooling without an Origin header', async () => {
      const response = await httpRequest({ port, path: '/__bridge/health' });
      assert.equal(response.status, 200);
      assert.equal(response.json.ok, true);
      assert.equal(response.json.upstream.port, 4064);
      assert.equal(response.json.context.tabs, 0);
    });
  });

  describe('context ingest', () => {
    it('stores a snapshot and reports it as the active context', async () => {
      const response = await httpRequest({ port, method: 'POST', path: '/__bridge/context', body: validSnapshot() });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.json.ok, true);
      assert.ok(typeof response.json.id === 'string' && response.json.id.length > 0);
      assert.ok(typeof response.json.updatedAt === 'string');
      assert.equal(response.json.activeTabId, 123);

      const latest = await httpRequest({ port, path: '/__bridge/context/latest' });
      assert.equal(latest.status, 200);
      // Raw snapshot at the top level (spec §2), so the side panel can validate it directly.
      assert.equal(latest.json.url, 'https://example.com/article');
      assert.equal(latest.json.title, '示例文章');
      assert.equal(latest.json.content.text, '正文内容');
      assert.equal(latest.json.capturedAt, '2026-11-10T12:00:00.000Z');
      assert.equal(typeof latest.json.video.kind, 'string');

      const list = await httpRequest({ port, path: '/__bridge/context/list' });
      assert.equal(list.status, 200);
      assert.equal(list.json.count, 1);
      assert.equal(list.json.tabs[0].tabId, 123);
      assert.equal(list.json.tabs[0].videoKind, 'none');
      assert.equal(list.json.tabs[0].video.kind, 'none');
      assert.equal(typeof list.json.tabs[0].updatedAt, 'string');
    });

    it('preserves a client-supplied snapshot id (extension contract)', async () => {
      const response = await httpRequest({
        port,
        method: 'POST',
        path: '/__bridge/context',
        body: validSnapshot({ tabId: 321, id: 'client-snapshot-id-321', active: false }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.json.id, 'client-snapshot-id-321');
      const latest = await httpRequest({ port, path: '/__bridge/context/latest?tabId=321' });
      assert.equal(latest.json.id, 'client-snapshot-id-321');
    });

    it('routes latest by tabId and keeps the active tab separate', async () => {
      await httpRequest({
        port,
        method: 'POST',
        path: '/__bridge/context',
        body: validSnapshot({ tabId: 456, active: false, url: 'https://example.com/second', title: '第二个' }),
      });
      const byTab = await httpRequest({ port, path: '/__bridge/context/latest?tabId=456' });
      assert.equal(byTab.status, 200);
      assert.equal(byTab.json.title, '第二个');

      const active = await httpRequest({ port, path: '/__bridge/context/latest' });
      assert.equal(active.json.tabId, 123, 'a non-active snapshot must not steal the active slot');

      const windowMatch = await httpRequest({ port, path: '/__bridge/context/latest?tabId=456&windowId=1' });
      assert.equal(windowMatch.status, 200);
      const windowMismatch = await httpRequest({ port, path: '/__bridge/context/latest?tabId=456&windowId=99' });
      assert.equal(windowMismatch.status, 404);
      assert.equal(windowMismatch.json.error.code, 'no-context');

      const list = await httpRequest({ port, path: '/__bridge/context/list' });
      assert.equal(list.json.count, 3);
      assert.equal(list.json.activeTabId, 123);
      assert.ok(list.json.tabs.some((row) => row.tabId === 456));
    });

    it('ignores unknown fields and clamps oversized content', async () => {
      const hugeText = 'x'.repeat(LIMITS.maxContentChars + 5000);
      const response = await httpRequest({
        port,
        method: 'POST',
        path: '/__bridge/context',
        body: {
          ...validSnapshot({ tabId: 789, active: true }),
          unknownField: { nested: true },
          content: { text: hugeText, charCount: hugeText.length },
        },
      });
      assert.equal(response.status, 200);
      const latest = await httpRequest({ port, path: '/__bridge/context/latest?tabId=789' });
      const snapshot = latest.json;
      assert.equal(snapshot.unknownField, undefined);
      assert.equal(snapshot.content.text.length, LIMITS.maxContentChars);
      assert.equal(snapshot.content.charCount, LIMITS.maxContentChars);
      assert.equal(snapshot.content.originalCharCount, hugeText.length);
      assert.equal(snapshot.content.truncated, true);
    });

    it('truncates transcripts by entry count', async () => {
      const transcript = Array.from({ length: LIMITS.maxTranscriptEntries + 100 }, (_, index) => ({
        start: index,
        end: index + 1,
        text: 'c' + index,
      }));
      const response = await httpRequest({
        port,
        method: 'POST',
        path: '/__bridge/context',
        body: validSnapshot({
          tabId: 900,
          active: false,
          video: { kind: 'youtube', title: '视频', durationSec: 120, transcriptSource: 'youtube-captions', transcript },
        }),
      });
      assert.equal(response.status, 200);
      const latest = await httpRequest({ port, path: '/__bridge/context/latest?tabId=900' });
      assert.equal(latest.json.video.transcript.length, LIMITS.maxTranscriptEntries);
      assert.equal(latest.json.video.transcriptTruncated, true);
    });

    it('rejects snapshots missing required fields', async () => {
      for (const [label, body] of [
        ['url', { ...validSnapshot(), url: '' }],
        ['title', (() => { const copy = validSnapshot(); delete copy.title; return copy; })()],
        ['capturedAt', { ...validSnapshot(), capturedAt: 'not-a-date' }],
        ['tabId', (() => { const copy = validSnapshot(); delete copy.tabId; return copy; })()],
      ]) {
        const response = await httpRequest({ port, method: 'POST', path: '/__bridge/context', body });
        assert.equal(response.status, 400, 'expected 400 for missing ' + label + ', got ' + response.status + ' ' + response.text);
        assert.equal(response.json.error.code, 'invalid-context');
      }
    });

    it('rejects malformed JSON and wrong methods', async () => {
      const bad = await httpRequest({
        port,
        method: 'POST',
        path: '/__bridge/context',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error.code, 'invalid-json');

      const wrongMethod = await httpRequest({ port, path: '/__bridge/context' });
      assert.equal(wrongMethod.status, 405);
    });

    it('rejects a body above the 8 MB cap with 413', async () => {
      const oversized = { ...validSnapshot({ tabId: 901 }), filler: 'z'.repeat(LIMITS.maxBodyBytes) };
      const response = await httpRequest({ port, method: 'POST', path: '/__bridge/context', body: oversized, timeoutMs: 20000 });
      assert.equal(response.status, 413);
      assert.equal(response.json.error.code, 'payload-too-large');
    });

    it('evicts the oldest tab beyond the 50-snapshot cap', async () => {
      store.clear();
      for (let index = 0; index < LIMITS.maxTabs + 1; index += 1) {
        const response = await httpRequest({
          port,
          method: 'POST',
          path: '/__bridge/context',
          body: validSnapshot({ tabId: 1000 + index, active: index === 0, url: 'https://example.com/' + index }),
        });
        assert.equal(response.status, 200);
      }
      const list = await httpRequest({ port, path: '/__bridge/context/list' });
      assert.equal(list.json.count, LIMITS.maxTabs);
      const evicted = await httpRequest({ port, path: '/__bridge/context/latest?tabId=1000' });
      assert.equal(evicted.status, 404);
      assert.equal(evicted.json.error.code, 'no-context');
      const newest = await httpRequest({ port, path: '/__bridge/context/latest?tabId=' + (1000 + LIMITS.maxTabs) });
      assert.equal(newest.status, 200);
    });
  });

  describe('unknown endpoints and empty context', () => {
    it('returns 404 JSON for an unknown bridge path', async () => {
      const response = await httpRequest({ port, path: '/__bridge/nope' });
      assert.equal(response.status, 404);
      assert.equal(response.json.error.code, 'not-found');
    });

    it('returns 404 no-context when nothing was synced', async () => {
      store.clear();
      const response = await httpRequest({ port, path: '/__bridge/context/latest?tabId=424242' });
      assert.equal(response.status, 404);
      assert.equal(response.json.error.code, 'no-context');
    });
  });
});
