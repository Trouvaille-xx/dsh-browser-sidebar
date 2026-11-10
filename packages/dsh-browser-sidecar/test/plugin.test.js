/**
 * Plugin wiring test: apply() against a fake cordis context plus the in-process
 * mock upstream. Covers the happy path (connection service → token exchange →
 * proxied UI + bridge + tool + prompt section) and the degraded paths the real
 * Host can hit (no `connection`, no upstream, busy port, no `tools` service).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apply, SYSTEM_PROMPT_SECTION, name as pluginName } from '../index.js';
import { createMockUpstream } from './support/mock-upstream.js';
import { httpRequest, waitFor } from './support/http-client.js';

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/**
 * Minimal cordis-context double: enough surface for apply() and for asserting
 * what the plugin registered.
 */
function createFakeContext(services = {}) {
  const tools = [];
  const sections = [];
  const disposers = [];
  const provided = new Map();
  const injected = [];
  const ctx = {
    logger() {
      return silentLogger;
    },
    effect(execute, label) {
      const result = execute();
      if (typeof result === 'function') disposers.push(result);
      return () => {};
    },
    provide(serviceName, value) {
      provided.set(serviceName, value);
      return () => provided.delete(serviceName);
    },
    get(serviceName) {
      return services[serviceName];
    },
    on() {
      return () => {};
    },
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    inject(deps, callback) {
      injected.push([...deps]);
      // Real cordis only runs the callback once every dependency is available,
      // and the child context exposes each service as a property.
      const available = (dep) => (dep === 'tools' ? ctx.tools !== undefined : services[dep] !== undefined);
      if (deps.every(available)) callback(ctx);
      return ctx;
    },
  };
  // Like a cordis child context: waiting services are readable as properties.
  for (const [serviceName, value] of Object.entries(services)) {
    if (ctx[serviceName] === undefined) ctx[serviceName] = value;
  }
  return {
    ctx,
    tools,
    sections,
    provided,
    injected,
    services,
    async dispose() {
      for (const disposer of disposers.slice().reverse()) {
        try { await disposer(); } catch { /* already disposed */ }
      }
    },
  };
}

describe('plugin apply(): happy path with a mock upstream', () => {
  it('wires proxy, bridge, tool and prompt section end to end', async () => {
    const mock = createMockUpstream();
    await mock.start();
    const fake = createFakeContext({
      connection: {
        // Mirrors connection.authenticatedUrl(): base URL + process launch token.
        authenticatedUrl: (baseUrl) => baseUrl + '?token=' + mock.token,
      },
      systemPrompt: {
        section(section) {
          fake.sections.push(section);
          return () => {};
        },
        getSectionOrder() {
          return 0;
        },
      },
    });
    const api = apply(fake.ctx, { port: 0, upstreamPort: mock.port });
    try {
      assert.equal(pluginName, 'browser-sidecar');
      assert.ok(api !== undefined && typeof api.health === 'function');
      const fromService = fake.provided.get('browserSidecar');
      assert.equal(fromService, api, 'the plugin must provide the browserSidecar service');
      await api.started;
      await waitFor(() => api.health().upstream.authReady, { label: 'auth ready', timeoutMs: 8000 });
      assert.ok(Number.isSafeInteger(api.port) && api.port > 0);

      // The official UI is served from the proxy origin.
      const page = await httpRequest({ port: api.port, path: '/' });
      assert.equal(page.status, 200);
      assert.match(page.text, /mock-dsh-ui/);

      // The bridge API lives on the same origin and never reaches upstream.
      const health = await httpRequest({ port: api.port, path: '/__bridge/health' });
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assert.equal(health.json.version, '1.0.0');
      assert.equal(health.json.upstream.port, mock.port);
      assert.equal(health.json.upstream.authReady, true);
      assert.deepEqual(health.json.context, { tabs: 0, activeTabId: null, updatedAt: null });

      // Extension snapshot → the agent tool reads it.
      const ingest = await httpRequest({
        port: api.port,
        method: 'POST',
        path: '/__bridge/context',
        headers: { origin: 'chrome-extension://abcdefghijklmnop' },
        body: {
          tabId: 7,
          windowId: 1,
          active: true,
          url: 'https://example.com/post',
          title: '侧边栏上下文',
          capturedAt: new Date().toISOString(),
          content: { text: '侧边栏同步过来的正文。', charCount: 11 },
          video: { kind: 'none', transcript: [] },
        },
      });
      assert.equal(ingest.status, 200, ingest.text);
      assert.equal(ingest.json.activeTabId, 7);

      assert.equal(fake.tools.length, 1, 'exactly one agent tool is registered');
      const tool = fake.tools[0];
      assert.equal(tool.name, 'browser_page');
      const summary = await tool.execute({ mode: 'summary' }, {});
      assert.equal(summary.ok, true);
      assert.match(summary.text, /侧边栏上下文/);
      assert.match(summary.text, /https:\/\/example\.com\/post/);

      // Prompt section: one registration, <= 5 lines, points at the tool.
      assert.equal(fake.sections.length, 1);
      assert.equal(fake.sections[0].name, 'browser-sidecar:browser-context');
      assert.equal(fake.sections[0].order, 700);
      assert.ok(SYSTEM_PROMPT_SECTION.split('\n').length <= 5, 'prompt section must stay <= 5 lines');
      assert.match(fake.sections[0].text, /browser_page/);
      assert.match(fake.sections[0].text, /读取当前页/);

      const diagnostics = api.health();
      assert.equal(diagnostics.context.tabs, 1);
      assert.equal(diagnostics.listen.port, api.port);
      assert.equal(diagnostics.listen.startError, null);
    } finally {
      await api.close();
      await fake.dispose();
      await mock.close();
    }
  });

  it('keeps working when the connection service never appears (degraded)', async () => {
    const fake = createFakeContext(); // no connection, no systemPrompt
    const api = apply(fake.ctx, { port: 0, upstreamPort: 4064 });
    try {
      await api.started;
      assert.ok(Number.isSafeInteger(api.port) && api.port > 0, 'proxy must still bind');

      const page = await httpRequest({ port: api.port, path: '/' });
      assert.equal(page.status, 200);
      assert.match(page.text, /等待鉴权/);
      assert.match(page.text, /data-sidecar-state="auth-pending"/);

      const health = await httpRequest({ port: api.port, path: '/__bridge/health' });
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assert.equal(health.json.upstream.authReady, false);
      assert.match(String(health.json.upstream.lastAuthError), /connection/);

      // The tool still answers with the actionable no-context prompt.
      const tool = fake.tools[0];
      const result = await tool.execute({ mode: 'summary' }, {});
      assert.equal(result.ok, false);
      assert.match(result.text, /读取当前页/);

      // Bridge ingest keeps working while auth is pending.
      const ingest = await httpRequest({
        port: api.port,
        method: 'POST',
        path: '/__bridge/context',
        body: {
          tabId: 1,
          active: true,
          url: 'https://example.com/',
          title: 't',
          capturedAt: new Date().toISOString(),
          content: { text: 'x' },
        },
      });
      assert.equal(ingest.status, 200);
    } finally {
      await api.close();
      await fake.dispose();
    }
  });

  it('degrades without throwing when the tools service is absent', async () => {
    const fake = createFakeContext();
    const tools = fake.ctx.tools;
    fake.ctx.tools = undefined;
    const api = apply(fake.ctx, { port: 0, upstreamPort: 1 });
    try {
      await api.started;
      assert.equal(fake.tools.length, 0);
      const health = await httpRequest({ port: api.port, path: '/__bridge/health' });
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
    } finally {
      fake.ctx.tools = tools;
      await api.close();
      await fake.dispose();
    }
  });

  it('survives a busy sidecar port without crashing the host', async () => {
    const first = createFakeContext();
    const firstApi = apply(first.ctx, { port: 0, upstreamPort: 1 });
    await firstApi.started;
    const busyPort = firstApi.port;

    const second = createFakeContext();
    const secondApi = apply(second.ctx, { port: busyPort, upstreamPort: 1 });
    try {
      assert.equal(await secondApi.started, false, 'start() must resolve false, not reject, on EADDRINUSE');
      assert.match(String(secondApi.health().listen.startError), /EADDRINUSE|失败|占用/);
    } finally {
      await secondApi.close();
      await second.dispose();
      await firstApi.close();
      await first.dispose();
    }
  });
});
