/**
 * 本地 mock bridge —— 用于在没有 DSH 的情况下验证扩展的推送契约。
 * ---------------------------------------------------------------------------
 * 实现规格 §2 的 4 个端点（内存态，不落盘）：
 *   GET  /__bridge/health
 *   POST /__bridge/context
 *   GET  /__bridge/context/latest?tabId=&windowId=
 *   GET  /__bridge/context/list
 * CORS 行为与规格一致：请求 Origin 是 chrome-extension:// 时回显它，允许 GET/POST/OPTIONS。
 *
 * 用法（独立起服务）：
 *   node extension/test/mock-bridge.mjs                 # 127.0.0.1:41789
 *   node extension/test/mock-bridge.mjs --port 41800    # 自定义端口
 *
 * 也作为库被 node --test 引入（listen 随机端口，避免和真实 bridge 抢端口）。
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import '../lib/core.js';

const core = globalThis.DSHSidebarCore;

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function corsHeaders(request) {
  const origin = String(request.headers.origin || '');
  return {
    // 规格：Origin 是 chrome-extension:// 时回显；其他情况按宽松策略回显/通配
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    'cache-control': 'no-store',
    vary: 'origin',
  };
}

function sendJson(response, request, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
  }, corsHeaders(request)));
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * 启动 mock bridge。
 * @param {{port?:number, host?:string, log?:boolean|((msg:string)=>void), upstreamOk?:boolean}} [options]
 */
export function createMockBridge(options) {
  const opts = options || {};
  const state = {
    version: 'mock-bridge-1.0.0',
    upstreamOk: opts.upstreamOk !== false,
    latest: null,
    byTab: new Map(),
    posts: [],            // 收到的所有快照（按顺序）
    postErrors: [],       // 校验失败/解析失败
    requests: [],         // [{method, url, at}] 便于调试
    updatedAt: null,
  };
  const log = typeof opts.log === 'function'
    ? opts.log
    : (opts.log ? (msg) => console.log(`[mock-bridge] ${msg}`) : () => {});

  async function handleHealth(request, response) {
    sendJson(response, request, 200, {
      ok: true,
      version: state.version,
      upstream: { ok: state.upstreamOk, port: 4064 },
      context: {
        tabs: state.byTab.size,
        updatedAt: state.updatedAt,
      },
    });
  }

  async function handlePostContext(request, response) {
    const raw = await readBody(request);
    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch (error) {
      state.postErrors.push({ at: new Date().toISOString(), error: `JSON 解析失败：${error.message}` });
      sendJson(response, request, 400, { ok: false, error: '请求体不是合法 JSON' });
      return;
    }
    const validation = core.validateSnapshot(snapshot);
    if (!validation.ok) {
      state.postErrors.push({ at: new Date().toISOString(), errors: validation.errors });
      sendJson(response, request, 400, { ok: false, error: '快照结构不符合规格', errors: validation.errors });
      return;
    }
    const updatedAt = new Date().toISOString();
    state.latest = snapshot;
    state.byTab.set(snapshot.tabId, snapshot);
    state.posts.push({ snapshot, updatedAt });
    state.updatedAt = updatedAt;
    log(`POST /__bridge/context tab=${snapshot.tabId} chars=${snapshot.content.charCount} cues=${snapshot.video.transcript.length}`);
    sendJson(response, request, 200, { ok: true, id: snapshot.id, updatedAt });
  }

  async function handleLatest(request, response, url) {
    const tabIdRaw = url.searchParams.get('tabId');
    const windowIdRaw = url.searchParams.get('windowId');
    const tabId = tabIdRaw === null ? null : Number(tabIdRaw);
    const windowId = windowIdRaw === null ? null : Number(windowIdRaw);

    let snapshot = null;
    if (Number.isFinite(tabId) && state.byTab.has(tabId)) {
      snapshot = state.byTab.get(tabId);
    } else if (state.latest) {
      snapshot = state.latest;
    }
    if (!snapshot) {
      sendJson(response, request, 404, { ok: false, error: '尚无浏览器页面快照' });
      return;
    }
    if (Number.isFinite(windowId) && snapshot.windowId !== windowId) {
      sendJson(response, request, 404, { ok: false, error: '该窗口暂无快照' });
      return;
    }
    sendJson(response, request, 200, snapshot);
  }

  function handleList(request, response) {
    const list = Array.from(state.byTab.values()).map((snapshot) => ({
      tabId: snapshot.tabId,
      windowId: snapshot.windowId,
      url: snapshot.url,
      title: snapshot.title,
      updatedAt: snapshot.capturedAt,
      video: { kind: snapshot.video.kind },
    }));
    sendJson(response, request, 200, { ok: true, tabs: list });
  }

  async function requestListener(request, response) {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    state.requests.push({ method: request.method, url: request.url, at: new Date().toISOString() });
    log(`${request.method} ${request.url}`);

    if (request.method === 'OPTIONS') {
      response.writeHead(204, corsHeaders(request));
      response.end();
      return;
    }
    try {
      if (url.pathname === '/__bridge/health' && request.method === 'GET') {
        await handleHealth(request, response);
        return;
      }
      if (url.pathname === '/__bridge/context' && request.method === 'POST') {
        await handlePostContext(request, response);
        return;
      }
      if (url.pathname === '/__bridge/context/latest' && request.method === 'GET') {
        await handleLatest(request, response, url);
        return;
      }
      if (url.pathname === '/__bridge/context/list' && request.method === 'GET') {
        handleList(request, response);
        return;
      }
      // 测试超时用：延迟响应
      if (url.pathname === '/__slow' && request.method === 'GET') {
        const ms = Number(url.searchParams.get('ms')) || 1000;
        await new Promise((resolve) => setTimeout(resolve, ms));
        sendJson(response, request, 200, { ok: true, delayedMs: ms });
        return;
      }
      // 测试「bridge 返回非 JSON」用
      if (url.pathname === '/__notjson' && request.method === 'GET') {
        response.writeHead(200, Object.assign({ 'content-type': 'text/html' }, corsHeaders(request)));
        response.end('<html><body>not json</body></html>');
        return;
      }
      sendJson(response, request, 404, { ok: false, error: `未知路由：${url.pathname}` });
    } catch (error) {
      sendJson(response, request, 500, { ok: false, error: (error && error.message) || String(error) });
    }
  }

  const server = http.createServer((request, response) => {
    requestListener(request, response).catch((error) => {
      try {
        sendJson(response, request, 500, { ok: false, error: String(error) });
      } catch (_) { /* 响应已结束 */ }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port === undefined ? 0 : opts.port, opts.host || '127.0.0.1', () => {
      const address = server.address();
      const url = `http://${opts.host || '127.0.0.1'}:${address.port}`;
      resolve({
        state,
        server,
        url,
        port: address.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let port = 41789;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--port' && args[i + 1]) port = Number(args[i + 1]);
    if (args[i].startsWith('--port=')) port = Number(args[i].slice('--port='.length));
  }
  const bridge = await createMockBridge({ port, log: true });
  console.log(`\n[mock-bridge] listening on ${bridge.url}`);
  console.log('[mock-bridge] endpoints:');
  console.log(`  GET  ${bridge.url}/__bridge/health`);
  console.log(`  POST ${bridge.url}/__bridge/context`);
  console.log(`  GET  ${bridge.url}/__bridge/context/latest`);
  console.log(`  GET  ${bridge.url}/__bridge/context/list`);
  console.log('\n把扩展设置里的 bridge 地址指到上面的地址即可。Ctrl+C 退出。\n');

  const shutdown = async () => {
    console.log('\n[mock-bridge] shutting down…');
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
