/**
 * Reverse-proxy behaviour of dsh-browser-sidecar against an in-process mock of
 * the DSH Web upstream: token exchange, cookie/Host injection, streaming, SSE,
 * WebSocket tunnelling, 401 self-healing, retry ladder and lifecycle.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';

import { createSidecarProxy } from '../proxy.js';
import { ContextStore } from '../context-store.js';
import { createBridgeHandler } from '../bridge.js';
import { authCookieName, createMockUpstream } from './support/mock-upstream.js';
import { collectSse, echoOnce, httpRequest, rawUpgrade, waitFor } from './support/http-client.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Proxy + bridge wired to one mock upstream; port 0 so tests never collide. */
function createProxy(mock, overrides = {}) {
  const store = new ContextStore();
  let proxy;
  const bridge = createBridgeHandler({
    store,
    getHealth: () => proxy.health(),
    logger: silentLogger,
  });
  proxy = createSidecarProxy({
    port: 0,
    upstreamPort: mock.port,
    getAuthUrl: overrides.getAuthUrl ?? (() => mock.launchUrl(proxy.port)),
    bridgeHandler: bridge,
    logger: overrides.logger ?? silentLogger,
    retryDelaysMs: overrides.retryDelaysMs ?? [10, 20, 40],
    tokenTimeoutMs: 2000,
  });
  return { proxy, store };
}

describe('reverse proxy: authentication injection', () => {
  const mock = createMockUpstream();
  let proxy;

  after(async () => {
    if (proxy !== undefined) await proxy.close();
    await mock.close();
  });

  it('upstream rejects requests without the browser-session cookie', async () => {
    await mock.start();
    const index = await httpRequest({ port: mock.port, path: '/' });
    assert.equal(index.status, 401, 'mock upstream must require the cookie');

    const api = await httpRequest({ port: mock.port, path: '/api/headers' });
    assert.equal(api.status, 401);
  });

  it('proxy performs the token exchange and serves the UI with 200', async () => {
    const wired = createProxy(mock);
    proxy = wired.proxy;
    await proxy.start();
    assert.ok(Number.isSafeInteger(proxy.port) && proxy.port > 0);
    await waitFor(() => proxy.state.authReady, { label: 'auth ready' });

    const page = await httpRequest({ port: proxy.port, path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.text, /mock-dsh-ui/);

    const health = await httpRequest({ port: proxy.port, path: '/__bridge/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.upstream.ok, true);
    assert.equal(health.json.upstream.authReady, true);
    assert.equal(health.json.upstream.port, mock.port);
  });

  it('forwards Host/Cookie and rewrites the cross-site markers', async () => {
    const response = await httpRequest({
      port: proxy.port,
      path: '/api/headers',
      headers: {
        origin: 'chrome-extension://abcdefghijklmnop',
        'sec-fetch-site': 'cross-site',
        'accept-encoding': 'gzip, deflate, br',
      },
    });
    assert.equal(response.status, 200, 'the /api fence must admit the proxied request');
    const seen = response.json.headers;
    const authority = '127.0.0.1:' + String(proxy.port);
    assert.equal(seen.host, authority, 'Host must stay the sidecar authority (cookie is bound to it)');
    assert.equal(seen['sec-fetch-site'], 'same-origin');
    assert.equal(seen.origin, 'http://' + authority);
    assert.equal(seen['accept-encoding'], 'gzip, deflate, br', 'encoding negotiation passes through untouched');
    assert.ok(String(seen.cookie).includes(authCookieName(authority)), 'injected cookie uses the authority-derived name');
  });

  it('replays the JSON body for POST requests', async () => {
    const payload = { hello: 'world', n: 42 };
    const response = await httpRequest({ port: proxy.port, path: '/api/echo', method: 'POST', body: payload });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.json.echo), payload);
  });

  it('passes gzip responses through without decoding them', async () => {
    const response = await httpRequest({
      port: proxy.port,
      path: '/api/gzip',
      headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'gzip');
    const decoded = JSON.parse(gunzipSync(response.body).toString('utf8'));
    assert.equal(decoded.compressed, true);
    assert.equal(decoded.body, 'gzip-passthrough-payload');
  });

  it('never proxies /__bridge/* upstream', async () => {
    const before = mock.requests.length;
    const response = await httpRequest({ port: proxy.port, path: '/__bridge/context/list' });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    const after = mock.requests.slice(before).filter((entry) => entry.path.startsWith('/__bridge'));
    assert.deepEqual(after, []);
  });
});

describe('reverse proxy: streaming', () => {
  const mock = createMockUpstream({ sseDelayMs: 30 });
  let proxy;

  after(async () => {
    if (proxy !== undefined) await proxy.close();
    await mock.close();
  });

  it('streams SSE events one by one instead of buffering', async () => {
    await mock.start();
    const wired = createProxy(mock);
    proxy = wired.proxy;
    await proxy.start();
    await waitFor(() => proxy.state.authReady, { label: 'auth ready' });

    const result = await collectSse({ port: proxy.port, path: '/api/sse' });
    assert.equal(result.status, 200);
    assert.match(String(result.headers['content-type']), /text\/event-stream/);
    assert.equal(result.events.length, 3);
    assert.match(result.events[0], /"n":1/);
    assert.match(result.events[2], /"n":3/);
    assert.ok(result.stamps[0] < result.endedAt - 10,
      'first event must arrive while the stream is still open (got ' + JSON.stringify(result.stamps) + ' endedAt=' + result.endedAt + ')');
    assert.ok(result.stamps[2] > result.stamps[0] + 20, 'events are paced, not delivered in one buffered chunk');
  });
});

describe('reverse proxy: WebSocket tunnelling', () => {
  const mock = createMockUpstream();
  let proxy;

  after(async () => {
    if (proxy !== undefined) await proxy.close();
    await mock.close();
  });

  it('upstream refuses an unauthenticated upgrade', async () => {
    await mock.start();
    const result = await rawUpgrade({ port: mock.port, path: '/api/remote.mux' });
    assert.equal(result.status, 401);
    result.socket.destroy();
  });

  it('tunnels an authenticated upgrade and pipes bytes both ways', async () => {
    const wired = createProxy(mock);
    proxy = wired.proxy;
    await proxy.start();
    await waitFor(() => proxy.state.authReady, { label: 'auth ready' });

    const upgraded = await rawUpgrade({
      port: proxy.port,
      path: '/api/remote.mux',
      headers: { origin: 'chrome-extension://abcdefghijklmnop', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(upgraded.status, 101, 'upgrade head: ' + upgraded.head);
    assert.match(upgraded.head, /sec-websocket-accept:/i);
    const echoed = await echoOnce(upgraded.socket, Buffer.from('hello-sidecar-ws'));
    assert.equal(echoed.toString('utf8'), 'hello-sidecar-ws');
    upgraded.socket.destroy();

    const seen = mock.wsUpgrades.at(-1);
    assert.equal(seen.headers.host, '127.0.0.1:' + String(proxy.port));
    assert.equal(seen.headers.origin, 'http://127.0.0.1:' + String(proxy.port));
    assert.ok(String(seen.headers.cookie).includes(authCookieName('127.0.0.1:' + String(proxy.port))));
  });
});

describe('reverse proxy: auth retry and self-healing', () => {
  const mock = createMockUpstream();
  let proxy;

  after(async () => {
    if (proxy !== undefined) await proxy.close();
    await mock.close();
  });

  it('retries the token exchange with backoff until the launch URL appears', async () => {
    await mock.start();
    let calls = 0;
    const wired = createProxy(mock, {
      retryDelaysMs: [5, 10, 20, 40],
      getAuthUrl: () => {
        calls += 1;
        if (calls <= 2) return undefined; // connection service not ready yet
        return mock.launchUrl(wired.proxy.port);
      },
    });
    proxy = wired.proxy;
    await proxy.start();
    // First attempt fails because the port is not bound yet; later ones succeed.
    await waitFor(() => proxy.state.authReady, { label: 'auth ready after retries', timeoutMs: 5000 });
    assert.ok(calls >= 3, 'expected at least 3 provider calls, got ' + calls);
    assert.equal(proxy.state.lastAuthError, null);
    const page = await httpRequest({ port: proxy.port, path: '/' });
    assert.equal(page.status, 200);
  });

  it('re-exchanges once and replays the request when upstream answers 401', async () => {
    const exchangesBefore = mock.tokenExchanges;
    mock.revokeCookies();
    const response = await httpRequest({ port: proxy.port, path: '/api/echo', method: 'POST', body: { retried: true } });
    assert.equal(response.status, 200, 'stale cookie must be healed transparently');
    assert.deepEqual(JSON.parse(response.json.echo), { retried: true });
    assert.ok(mock.tokenExchanges > exchangesBefore, 'a fresh token exchange must have happened');
    assert.equal(proxy.state.authReady, true);
  });
});

describe('reverse proxy: degraded modes and lifecycle', () => {
  it('serves a diagnosable page when no launch URL is available', async () => {
    const mock = createMockUpstream();
    await mock.start();
    const wired = createProxy(mock, { getAuthUrl: () => undefined });
    const proxy = wired.proxy;
    try {
      await proxy.start();
      const page = await httpRequest({ port: proxy.port, path: '/' });
      assert.equal(page.status, 200);
      assert.match(page.text, /等待鉴权/);
      assert.match(page.text, /data-sidecar-state="auth-pending"/);
      assert.match(page.text, new RegExp(String(mock.port)), 'the page must name the upstream port');

      const health = await httpRequest({ port: proxy.port, path: '/__bridge/health' });
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assert.equal(health.json.upstream.ok, false);
      assert.equal(health.json.upstream.authReady, false);
      assert.ok(typeof health.json.upstream.lastAuthError === 'string');

      const api = await httpRequest({ port: proxy.port, path: '/api/whatever' });
      assert.equal(api.status, 503);
      assert.equal(api.json.error.code, 'upstream-auth-pending');
    } finally {
      await proxy.close();
      await mock.close();
    }
  });

  it('degrades cleanly when the upstream port is closed, without unhandled rejections', async () => {
    const closedPort = await freePort();
    const wired = createProxy(
      { port: closedPort, launchUrl: () => 'http://127.0.0.1:1/?token=x' },
      { retryDelaysMs: [5, 5, 5] },
    );
    const proxy = wired.proxy;
    try {
      await proxy.start();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const page = await httpRequest({ port: proxy.port, path: '/' });
      assert.equal(page.status, 200);
      assert.match(page.text, /等待鉴权/);
      assert.ok(typeof proxy.state.lastAuthError === 'string');
    } finally {
      await proxy.close();
    }
  });

  it('reports a busy port instead of throwing into the host', async () => {
    const occupied = net.createServer();
    await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const occupiedPort = occupied.address().port;
    const proxy = createSidecarProxy({
      port: occupiedPort,
      upstreamPort: 1,
      getAuthUrl: () => undefined,
      logger: silentLogger,
      retryDelaysMs: [5],
    });
    try {
      await assert.rejects(() => proxy.start());
      assert.match(String(proxy.state.startError), /EADDRINUSE|占用|失败/);
    } finally {
      await proxy.close();
      await new Promise((resolve) => occupied.close(resolve));
    }
  });

  it('closes the listener and stops retrying on close()', async () => {
    const mock = createMockUpstream();
    await mock.start();
    const wired = createProxy(mock, { retryDelaysMs: [5] });
    const proxy = wired.proxy;
    await proxy.start();
    const port = proxy.port;
    await proxy.close();
    await assert.rejects(() => httpRequest({ port, path: '/', timeoutMs: 1000 }), /ECONNREFUSED|timeout|socket hang up/);
    assert.equal(proxy.state.closed, true);
    await mock.close();
  });
});

/** Reserve a free loopback port, then release it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
