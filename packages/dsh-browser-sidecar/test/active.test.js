/**
 * /__bridge/active — 切页只改「当前标签页」，不重发整页内容。
 *
 * 场景：扩展在标签页内容没变时会去重（不重复 POST /context），此时必须仍能
 * 把 activeTabId 告诉 bridge，否则 browser_page 会一直读上一个标签页。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createBridgeHandler } from '../bridge.js';
import { ContextStore } from '../context-store.js';
import { httpRequest } from './support/http-client.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function snapshot(tabId, url, active) {
  return {
    tabId,
    windowId: 1,
    active,
    url,
    title: '页面 ' + tabId,
    siteName: 'example.com',
    capturedAt: '2026-11-10T12:00:00.000Z',
    selection: '',
    content: { text: '正文 ' + tabId, charCount: 6, truncated: false },
  };
}

describe('bridge active-tab switch', () => {
  let server;
  let port;
  let store;

  before(async () => {
    store = new ContextStore();
    const handler = createBridgeHandler({
      store,
      getHealth: () => ({ version: '1.0.0', uptimeMs: 1, upstream: { port: 0, authReady: false, lastAuthError: null } }),
      logger: silentLogger,
    });
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

  it('accepts two snapshots, then switches the active tab without new content', async () => {
    await httpRequest({ port, method: 'POST', path: '/__bridge/context', body: snapshot(11, 'https://a.example/1', true) });
    await httpRequest({ port, method: 'POST', path: '/__bridge/context', body: snapshot(22, 'https://b.example/2', false) });

    let latest = await httpRequest({ port, method: 'GET', path: '/__bridge/context/latest' });
    assert.equal(latest.json.tabId, 11);

    const switched = await httpRequest({ port, method: 'POST', path: '/__bridge/active', body: { tabId: 22 } });
    assert.equal(switched.status, 200);
    assert.equal(switched.json.ok, true);
    assert.equal(switched.json.activeTabId, 22);

    latest = await httpRequest({ port, method: 'GET', path: '/__bridge/context/latest' });
    assert.equal(latest.status, 200);
    assert.equal(latest.json.tabId, 22);
    assert.equal(latest.json.active, true);

    // 旧的 active 标记必须被清掉，避免 list 里出现两个 active
    const list = await httpRequest({ port, method: 'GET', path: '/__bridge/context/list' });
    assert.equal(list.json.activeTabId, 22);
    assert.equal(list.json.tabs.filter((tab) => tab.active).length, 1);
  });

  it('reports ok=false for a tab that has no snapshot yet, and keeps the old active', async () => {
    const response = await httpRequest({ port, method: 'POST', path: '/__bridge/active', body: { tabId: 999 } });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, false);
    assert.equal(response.json.activeTabId, 22);
    const latest = await httpRequest({ port, method: 'GET', path: '/__bridge/context/latest' });
    assert.equal(latest.json.tabId, 22);
  });

  it('rejects a non-integer tabId and the wrong method', async () => {
    const bad = await httpRequest({ port, method: 'POST', path: '/__bridge/active', body: { tabId: 'abc' } });
    assert.equal(bad.status, 400);
    const wrongMethod = await httpRequest({ port, method: 'GET', path: '/__bridge/active' });
    assert.equal(wrongMethod.status, 405);
  });

  it('answers a chrome-extension preflight for POST /active', async () => {
    const response = await httpRequest({
      port,
      method: 'OPTIONS',
      path: '/__bridge/active',
      headers: {
        origin: 'chrome-extension://abcdefghijklmnop',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers['access-control-allow-origin'], 'chrome-extension://abcdefghijklmnop');
  });
});
