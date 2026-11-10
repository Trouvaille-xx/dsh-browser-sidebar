/**
 * dsh-browser-sidecar reverse proxy.
 *
 * Why a proxy at all: DSH Web authenticates the browser with an HttpOnly
 * SameSite=Strict cookie bound to the request authority (`Host`). A Chrome side
 * panel iframe is a different origin than http://127.0.0.1:4064, so the browser
 * will neither send that cookie nor accept a cross-site `Origin`. The sidecar
 * therefore serves the UI from its own loopback origin (default :41789) and
 * injects the credential server-side:
 *
 *   1. On startup, ask the Harness for a launch URL via
 *      `connection.authenticatedUrl('http://127.0.0.1:<port>/')`, request it
 *      from the upstream **with `Host: 127.0.0.1:<port>`** (the cookie name and
 *      signed audience are derived from that authority), and keep the
 *      `Set-Cookie` value it returns.
 *   2. Forward every proxied request to the upstream with that `Host` and an
 *      injected `Cookie`, rewriting `sec-fetch-site` to `same-origin` so the
 *      iframe's first cross-site navigation is not rejected with 403.
 *   3. WebSocket upgrades are tunnelled the same way: build the upgrade request
 *      by hand, inject the same headers, then pipe raw sockets both ways.
 *
 * If the token exchange fails, the proxy stays up, retries with exponential
 * backoff, and serves a diagnosable HTML page on `/` instead of a silent 401.
 * Nothing is ever buffered end-to-end: HTTP bodies and SSE/streaming responses
 * are piped, and gzip is passed through untouched.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {
  DEFAULT_PORT,
  DEFAULT_UPSTREAM_PORT,
  SIDECAR_HOST,
  VERSION,
} from './core.js';
import { isBridgePath } from './bridge.js';

/** Hop-by-hop headers never forwarded in either direction. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Request bodies up to this size are buffered so a 401 can be retried once. */
const RETRYABLE_BODY_BYTES = 1024 * 1024;

/** Default token-exchange retry ladder (ms); the last value repeats forever. */
const DEFAULT_RETRY_DELAYS = Object.freeze([1000, 2000, 5000, 10000, 30000]);

/** On-demand exchanges (triggered by requests while degraded) are throttled. */
const ON_DEMAND_EXCHANGE_INTERVAL_MS = 1000;

function errorMessage(error) {
  if (error === undefined || error === null) return String(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

function safeUrl(rawUrl, fallbackAuthority) {
  try {
    return new URL(rawUrl ?? '/', 'http://' + fallbackAuthority);
  } catch {
    return new URL('/', 'http://' + fallbackAuthority);
  }
}

function safeJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Read a request body into one Buffer.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limitBytes
 * @returns {Promise<Buffer>}
 */
function readRequestBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body exceeds ' + limitBytes + ' bytes'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Copy upstream response headers, dropping hop-by-hop ones (node re-chunks). */
function filterResponseHeaders(upstreamResponse) {
  const headers = {};
  for (const [name, value] of Object.entries(upstreamResponse.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  return headers;
}

/**
 * Build the request headers sent upstream.
 *
 * `Host` is always this sidecar's authority (the cookie is bound to it),
 * `Cookie` is the injected browser-session cookie, `sec-fetch-site` becomes
 * `same-origin`, and a mismatching `Origin`/`Referer` is rewritten to the
 * sidecar origin so the upstream Host/Origin fence admits the request.
 */
function buildUpstreamHeaders(req, authority, cookie, options = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'cookie' || lower === 'origin' || lower === 'sec-fetch-site') continue;
    if (!options.keepHopByHop && HOP_BY_HOP.has(lower)) continue;
    headers[lower] = value;
  }
  headers.host = authority;
  if (cookie) headers.cookie = cookie;
  headers['sec-fetch-site'] = 'same-origin';
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') headers.origin = 'http://' + authority;
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer !== '') {
    try {
      const parsed = new URL(referer);
      if (parsed.host !== authority) {
        parsed.protocol = 'http:';
        parsed.host = authority;
        headers.referer = parsed.href;
      }
    } catch {
      // Unparseable Referer: drop it rather than forward something odd.
      delete headers.referer;
    }
  }
  return headers;
}

/** One HTML page that explains exactly why the UI is not loading yet. */
function renderDiagnosticHtml(info) {
  const authState = info.authReady ? 'cookie 已就绪' : '等待鉴权';
  const reason = info.reason === 'auth-pending'
    ? '代理已启动，但还没有从 DSH 拿到浏览器会话凭据（launch token → Set-Cookie）。'
    : info.reason === 'upstream-unreachable'
      ? '代理已拿到凭据，但连不上上游 DSH Web 端口。'
      : '上游返回了非预期的响应。';
  const retryLine = info.authReady
    ? '重试：刷新本页即可；若持续失败请检查 DSH 是否在运行。'
    : '自动重试：' + info.retryHint + '（无需手动操作，成功后刷新本页即可）';
  const errorLine = info.lastAuthError ? escapeHtml(info.lastAuthError) : '（无）';
  // While the credential exchange is retrying in the background, reload the
  // iframe every 3s so the side panel heals itself once DSH becomes ready.
  const autoRefresh = info.reason === 'auth-pending' ? '<meta http-equiv="refresh" content="3">' : '';
  const rows = [
    ['上游地址', 'http://' + escapeHtml(info.upstreamHost) + ':' + String(info.upstreamPort)],
    ['上游端口', String(info.upstreamPort)],
    ['鉴权状态', authState],
    ['最近错误', errorLine],
  ].map(([label, value]) => '<tr><th>' + label + '</th><td>' + value + '</td></tr>').join('');
  return '<!doctype html>\n' +
    '<html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' + autoRefresh +
    '<title>DSH 浏览器侧边栏 · ' + authState + '</title>' +
    '<style>' +
    ':root{color-scheme:light dark}body{margin:0;padding:24px;font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;' +
    'background:#0f1115;color:#e6e6e6}h1{font-size:16px;margin:0 0 4px}p{margin:6px 0;color:#b7bdc9}' +
    'table{border-collapse:collapse;margin:14px 0;width:100%;max-width:560px}th,td{text-align:left;padding:6px 10px;' +
    'border-bottom:1px solid #262b35;vertical-align:top}th{color:#8e97a8;font-weight:500;width:96px}' +
    'code{background:#1a1f28;padding:1px 5px;border-radius:4px;color:#9fd0ff}' +
    '.hint{margin-top:14px;padding:10px 12px;background:#161a22;border:1px solid #262b35;border-radius:8px;max-width:560px}' +
    '.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#e0a800;margin-right:6px}' +
    '</style></head><body data-sidecar-state="' + escapeHtml(info.reason) + '">' +
    '<h1><span class="dot"></span>DSH 浏览器侧边栏桥接</h1>' +
    '<p>' + escapeHtml(reason) + '</p>' +
    '<table>' + rows + '</table>' +
    '<div class="hint"><p>' + escapeHtml(retryLine) + '</p>' +
    '<p>诊断 JSON：<code>http://127.0.0.1:' + String(info.port ?? '') + '/__bridge/health</code></p>' +
    '<p>常见原因：DSH 桌面应用没有运行 · DSH 刚启动、插件比 connection 服务先加载（等几秒会自愈）· 上游端口不是 ' +
    String(info.upstreamPort) + ' · 端口被其它进程占用。</p></div>' +
    '</body></html>\n';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/**
 * Create the sidecar proxy (not started yet).
 *
 * @param {{
 *   port?: number,
 *   host?: string,
 *   upstreamHost?: string,
 *   upstreamPort?: number,
 *   bridgeHandler?: Function,
 *   getAuthUrl?: () => string|undefined|Promise<string|undefined>,
 *   logger?: { info: Function, warn: Function, error: Function },
 *   retryDelaysMs?: number[],
 *   tokenTimeoutMs?: number,
 *   version?: string,
 * }} options
 */
export function createSidecarProxy(options = {}) {
  const requestedPort = Number.isSafeInteger(options.port) && options.port >= 0 && options.port <= 65535
    ? options.port
    : DEFAULT_PORT;
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : SIDECAR_HOST;
  const upstreamHost = typeof options.upstreamHost === 'string' && options.upstreamHost !== '' ? options.upstreamHost : SIDECAR_HOST;
  // The real Web UI port is only known at runtime (the Desktop app boots the web
  // app with `--port 0`, so the port is OS-assigned per launch). `upstreamPort`
  // is therefore mutable: index.js calls setUpstreamPort() as soon as the
  // `webServer` service (or an explicit config override) tells us the truth.
  let upstreamPort = Number.isSafeInteger(options.upstreamPort) && options.upstreamPort > 0 && options.upstreamPort <= 65535
    ? options.upstreamPort
    : DEFAULT_UPSTREAM_PORT;
  let explicitUpstreamPort = upstreamPort;
  let upstreamPortPinned = false;
  const version = typeof options.version === 'string' && options.version !== '' ? options.version : VERSION;
  const bridgeHandler = typeof options.bridgeHandler === 'function' ? options.bridgeHandler : undefined;
  const logger = options.logger ?? { info() {}, warn() {}, error() {} };
  const retryDelays = Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length > 0
    ? options.retryDelaysMs.filter((value) => Number.isFinite(value) && value >= 0)
    : DEFAULT_RETRY_DELAYS;
  const retryLadder = retryDelays.length > 0 ? retryDelays : DEFAULT_RETRY_DELAYS;
  const tokenTimeoutMs = Number.isFinite(options.tokenTimeoutMs) && options.tokenTimeoutMs > 0 ? options.tokenTimeoutMs : 5000;
  let getAuthUrl = options.getAuthUrl;

  const state = {
    authReady: false,
    cookie: null,
    lastAuthError: null,
    lastAuthAt: null,
    lastAttemptAt: 0,
    attempts: 0,
    retryIndex: 0,
    exchangeInFlight: null,
    exchangeQueued: false,
    retryTimer: null,
    startError: null,
    port: null,
    startedAt: Date.now(),
  };

  /** @type {import('node:http').Server|undefined} */
  let server;
  /** @type {Promise<void>|undefined} */
  let startPromise;
  let closed = false;
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();

  const authority = () => host + ':' + String(state.port ?? requestedPort);

  /** Hint used by diagnostics: the current retry ladder position. */
  function retryHint() {
    const delay = retryLadder[Math.min(state.retryIndex, retryLadder.length - 1)];
    return '每 ' + Math.round(delay / 1000 * 10) / 10 + ' 秒（指数退避，直到成功）';
  }

  /**
   * Point the proxy at the real upstream Web UI port. The injected cookie is
   * bound to the *sidecar* authority, not the upstream port, so only the token
   * exchange has to run again.
   *
   * @param {number} value - actual DSH Web UI port
   * @param {{ pinned?: boolean }} [settings] - pinned = explicit config wins over auto-detection
   * @returns {boolean} whether the port was accepted
   */
  function setUpstreamPort(value, settings = {}) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 65535) return false;
    const pinned = settings.pinned === true;
    if (upstreamPortPinned && !pinned) return true;
    if (pinned) upstreamPortPinned = true;
    if (value === upstreamPort) return true;
    upstreamPort = value;
    state.authReady = false;
    state.cookie = null;
    state.lastAuthError = null;
    state.retryIndex = 0;
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    void triggerExchange();
    return true;
  }

  function health() {
    return {
      version,
      uptimeMs: Date.now() - state.startedAt,
      upstream: {
        /** True once the launch token was exchanged and the injected cookie works. */
        ok: state.authReady,
        host: upstreamHost,
        port: upstreamPort,
        authReady: state.authReady,
        lastAuthError: state.lastAuthError,
        lastAuthAt: state.lastAuthAt,
        attempts: state.attempts,
      },
      listen: {
        host,
        port: state.port,
        startError: state.startError,
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * Token exchange
   * ------------------------------------------------------------------ */

  /** Request the launch-token URL upstream and capture the issued cookie. */
  function requestSetCookie(token) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: upstreamHost,
          port: upstreamPort,
          method: 'GET',
          path: '/?token=' + encodeURIComponent(token),
          // One connection per request made on behalf of the browser: keeps the
          // upstream socket lifecycle tied to the proxied request.
          agent: false,
          headers: {
            host: authority(),
            accept: 'text/html',
            'cache-control': 'no-store',
            'user-agent': 'dsh-browser-sidecar/' + version,
          },
        },
        (response) => {
          response.resume();
          const status = response.statusCode ?? 0;
          if (status !== 303 && status !== 302 && status !== 307) {
            reject(new Error('token 交换失败：上游返回 HTTP ' + status + '（期望 303 + Set-Cookie）'));
            return;
          }
          const setCookie = response.headers['set-cookie'];
          const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
          if (typeof raw !== 'string' || raw === '') {
            reject(new Error('token 交换失败：上游 303 响应里没有 Set-Cookie'));
            return;
          }
          const pair = raw.split(';', 1)[0].trim();
          const eq = pair.indexOf('=');
          if (eq <= 0 || eq === pair.length - 1) {
            reject(new Error('token 交换失败：Set-Cookie 格式无法解析'));
            return;
          }
          resolve({ pair, name: pair.slice(0, eq) });
        },
      );
      request.setTimeout(tokenTimeoutMs, () => request.destroy(new Error('token 交换超时（' + tokenTimeoutMs + 'ms）')));
      request.on('error', reject);
      request.end();
    });
  }

  async function exchangeOnce() {
    state.attempts += 1;
    state.lastAttemptAt = Date.now();
    let url;
    if (typeof getAuthUrl !== 'function') throw new Error('connection 服务不可用：没有 authenticatedUrl 提供者');
    try {
      url = await getAuthUrl();
    } catch (error) {
      throw new Error('读取 DSH launch URL 失败：' + errorMessage(error));
    }
    if (typeof url !== 'string' || url === '') {
      throw new Error('connection 服务尚未就绪：authenticatedUrl() 没有返回 URL（等 DSH 启动完成后会自动重试）');
    }
    let token;
    try {
      token = new URL(url).searchParams.get('token');
    } catch {
      throw new Error('authenticatedUrl() 返回了非法 URL');
    }
    if (typeof token !== 'string' || token === '') throw new Error('authenticatedUrl() 返回的 URL 缺少 token 参数');
    const issued = await requestSetCookie(token);
    state.cookie = issued.pair;
    state.authReady = true;
    state.lastAuthError = null;
    state.lastAuthAt = new Date().toISOString();
    state.retryIndex = 0;
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    logger.info('browser-sidecar: 上游鉴权就绪（cookie %s…，authority %s）', issued.name.slice(0, 14), authority());
  }

  function scheduleRetry() {
    if (closed || state.retryTimer !== null) return;
    const delay = retryLadder[Math.min(state.retryIndex, retryLadder.length - 1)];
    state.retryIndex += 1;
    const timer = setTimeout(() => {
      state.retryTimer = null;
      void triggerExchange();
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    state.retryTimer = timer;
  }

  /** Run one token exchange unless one is already in flight. Never rejects. */
  function triggerExchange() {
    if (closed) return Promise.resolve();
    if (state.exchangeInFlight !== null) {
      // A provider/service appeared while an attempt was running: run again once
      // that attempt settles instead of waiting for the next backoff tick.
      state.exchangeQueued = true;
      return state.exchangeInFlight;
    }
    const run = (async () => {
      try {
        if (startPromise !== undefined) await startPromise.catch(() => undefined);
        if (closed) return;
        await exchangeOnce();
      } catch (error) {
        state.authReady = false;
        state.cookie = null;
        state.lastAuthError = errorMessage(error);
        logger.warn('browser-sidecar: 上游鉴权未就绪：%s', state.lastAuthError);
        scheduleRetry();
      }
    })();
    state.exchangeInFlight = run;
    run.then(() => {
      if (state.exchangeInFlight === run) state.exchangeInFlight = null;
      if (state.exchangeQueued && !closed) {
        state.exchangeQueued = false;
        void triggerExchange();
      }
    });
    return run;
  }

  /** Ask for an exchange opportunistically, but never more than once a second. */
  function triggerExchangeOnDemand() {
    if (closed || state.authReady) return;
    if (Date.now() - state.lastAttemptAt < ON_DEMAND_EXCHANGE_INTERVAL_MS) return;
    void triggerExchange();
  }

  /** Force a fresh token exchange (used after an upstream 401). */
  async function refreshAuth() {
    if (closed) return false;
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    await triggerExchange();
    return state.authReady;
  }

  /* ------------------------------------------------------------------ *
   * Failure / diagnostic responses
   * ------------------------------------------------------------------ */

  function wantsHtml(req, url) {
    if (url.pathname === '/' || url.pathname === '/index.html') return true;
    const accept = req.headers.accept;
    return typeof accept === 'string' && accept.includes('text/html');
  }

  function respondFailure(req, res, url, info) {
    if (res.writableEnded || res.destroyed || res.headersSent) {
      try { res.destroy(); } catch { /* already gone */ }
      return;
    }
    const payload = {
      ok: false,
      error: {
        code: info.code ?? 'upstream-unavailable',
        message: info.message ?? '上游不可用',
        upstream: { host: upstreamHost, port: upstreamPort, authReady: state.authReady, lastAuthError: state.lastAuthError },
      },
    };
    if (wantsHtml(req, url)) {
      const body = renderDiagnosticHtml({
        reason: info.reason ?? 'auth-pending',
        authReady: state.authReady,
        lastAuthError: state.lastAuthError,
        upstreamHost,
        upstreamPort,
        port: state.port,
        retryHint: retryHint(),
      });
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    safeJson(res, info.status ?? 503, payload);
  }

  /* ------------------------------------------------------------------ *
   * HTTP forwarding
   * ------------------------------------------------------------------ */

  /**
   * Forward one request upstream. Bodies that fit RETRYABLE_BODY_BYTES are
   * buffered so a stale cookie 401 can be retried after a fresh token exchange.
   */
  async function forwardHttp(req, res) {
    const url = safeUrl(req.url, authority());
    const method = req.method ?? 'GET';
    const hasBody = method !== 'GET' && method !== 'HEAD';
    let body;
    let canReplay = true;
    if (hasBody) {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared >= 0 && declared <= RETRYABLE_BODY_BYTES) {
        try {
          body = await readRequestBody(req, RETRYABLE_BODY_BYTES);
        } catch (error) {
          respondFailure(req, res, url, {
            code: 'bad-request',
            status: 400,
            message: errorMessage(error),
            reason: 'upstream-error',
          });
          return;
        }
      } else {
        // Unknown-length (chunked) or large body: stream it, no 401 replay.
        body = undefined;
        canReplay = false;
      }
    } else {
      body = Buffer.alloc(0);
    }
    await pipeOnce(req, res, url, body, canReplay, false);
  }

  /**
   * One upstream round-trip. `body === undefined` means "stream the request
   * body"; a Buffer means it was buffered and may be replayed on a 401 retry.
   */
  function pipeOnce(req, res, url, body, canReplay, retried) {
    return new Promise((resolve) => {
      let responded = false;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const headers = buildUpstreamHeaders(req, authority(), state.cookie);
      let upstreamRequest;
      try {
        upstreamRequest = http.request({
          host: upstreamHost,
          port: upstreamPort,
          method: req.method,
          path: req.url ?? '/',
          agent: false,
          headers,
        });
      } catch (error) {
        respondFailure(req, res, url, {
          code: 'upstream-unavailable',
          status: 502,
          message: '无法向上游发起请求：' + errorMessage(error),
          reason: 'upstream-unreachable',
        });
        finish();
        return;
      }

      upstreamRequest.setTimeout(15000, () => upstreamRequest.destroy(new Error('连接上游超时（15s）')));

      upstreamRequest.on('response', (upstreamResponse) => {
        responded = true;
        upstreamRequest.setTimeout(0);
        const status = upstreamResponse.statusCode ?? 502;

        // Stale cookie: re-exchange once, then replay the (buffered) request.
        // NB: `req.destroyed` is unusable here — node auto-destroys a fully
        // consumed IncomingMessage; the response stream is the alive one.
        if (status === 401 && !retried && canReplay && !res.destroyed) {
          upstreamResponse.resume();
          logger.warn('browser-sidecar: 上游返回 401，重新做一次 token 交换后重试请求');
          state.authReady = false;
          void refreshAuth().then((ok) => {
            if (!ok || res.destroyed) {
              // Cannot retry: hand the 401 through so the caller can diagnose.
              if (!res.headersSent) {
                res.writeHead(401, {
                  'content-type': 'application/json; charset=utf-8',
                  'cache-control': 'no-store',
                });
                res.end(JSON.stringify({ ok: false, error: { code: 'unauthorized', message: '上游 401 且重新鉴权失败：' + (state.lastAuthError ?? 'unknown') } }));
              }
              finish();
              return;
            }
            pipeOnce(req, res, url, body, canReplay, true).then(finish, finish);
          });
          return;
        }

        const responseHeaders = filterResponseHeaders(upstreamResponse);
        if (res.destroyed) {
          upstreamResponse.resume();
          finish();
          return;
        }
        try {
          res.writeHead(status, responseHeaders);
        } catch (error) {
          logger.warn('browser-sidecar: 写响应头失败：%s', errorMessage(error));
          upstreamResponse.resume();
          res.destroy();
          finish();
          return;
        }
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        upstreamResponse.pipe(res);
        upstreamResponse.on('end', finish);
        upstreamResponse.on('error', (error) => {
          logger.warn('browser-sidecar: 上游响应中断：%s', errorMessage(error));
          res.destroy();
          finish();
        });
        res.on('close', () => {
          if (upstreamResponse.complete !== true) upstreamResponse.destroy();
        });
      });

      upstreamRequest.on('error', (error) => {
        if (responded) {
          if (!res.headersSent) {
            respondFailure(req, res, url, {
              code: 'upstream-error',
              status: 502,
              message: '上游响应失败：' + errorMessage(error),
              reason: 'upstream-unreachable',
            });
          } else {
            res.destroy();
          }
          finish();
          return;
        }
        respondFailure(req, res, url, {
          code: 'upstream-unavailable',
          status: 502,
          message: '连不上上游 DSH Web（http://' + upstreamHost + ':' + upstreamPort + '）：' + errorMessage(error),
          reason: 'upstream-unreachable',
        });
        finish();
      });

      req.on('aborted', () => upstreamRequest.destroy(new Error('客户端中断了请求')));

      if (body !== undefined) upstreamRequest.end(body);
      else req.pipe(upstreamRequest);
    });
  }

  /* ------------------------------------------------------------------ *
   * WebSocket (HTTP upgrade) forwarding
   * ------------------------------------------------------------------ */

  const UPGRADE_REASONS = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 502: 'Bad Gateway', 503: 'Service Unavailable' };

  function rejectUpgrade(socket, status, message) {
    try {
      const body = JSON.stringify({ ok: false, error: { code: 'upgrade-rejected', message } });
      socket.write(
        'HTTP/1.1 ' + status + ' ' + (UPGRADE_REASONS[status] ?? 'Error') + '\r\n' +
        'content-type: application/json; charset=utf-8\r\n' +
        'content-length: ' + Buffer.byteLength(body) + '\r\n' +
        'connection: close\r\n\r\n' + body,
      );
    } catch { /* socket may already be gone */ }
    try { socket.destroy(); } catch { /* already gone */ }
  }

  function forwardUpgrade(req, socket, head) {
    const url = safeUrl(req.url, authority());
    if (isBridgePath(url.pathname)) {
      rejectUpgrade(socket, 404, 'bridge 端点不支持 WebSocket');
      return;
    }
    if (!state.authReady) {
      triggerExchangeOnDemand();
      rejectUpgrade(socket, 503, '上游鉴权尚未就绪（正在自动重试），请稍后刷新');
      return;
    }

    const upstreamSocket = net.connect({ host: upstreamHost, port: upstreamPort });
    let gotResponse = false;
    let closedByError = false;

    const teardown = () => {
      try { upstreamSocket.destroy(); } catch { /* already gone */ }
    };

    upstreamSocket.on('connect', () => {
      const headers = buildUpstreamHeaders(req, authority(), state.cookie, { keepHopByHop: true });
      delete headers['proxy-connection'];
      const lines = [(req.method ?? 'GET') + ' ' + (req.url ?? '/') + ' HTTP/1.1'];
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const item of value) lines.push(name + ': ' + item);
        } else {
          lines.push(name + ': ' + value);
        }
      }
      lines.push('', '');
      upstreamSocket.write(lines.join('\r\n'));
      if (head !== undefined && head !== null && head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });

    upstreamSocket.on('data', (chunk) => {
      if (gotResponse) return;
      gotResponse = true;
      const headText = chunk.toString('latin1', 0, Math.min(chunk.length, 64));
      if (/\s(401|403)\s/.test(headText)) {
        logger.warn('browser-sidecar: WebSocket 升级被上游拒绝（%s），重新做一次 token 交换', headText.split('\r\n')[0]);
        state.authReady = false;
        void refreshAuth();
      }
    });

    upstreamSocket.on('error', (error) => {
      closedByError = true;
      if (!gotResponse) {
        rejectUpgrade(socket, 502, '连不上上游 WebSocket（http://' + upstreamHost + ':' + upstreamPort + '）：' + errorMessage(error));
      } else {
        try { socket.destroy(); } catch { /* already gone */ }
      }
    });

    upstreamSocket.on('close', () => {
      if (!closedByError) {
        try { socket.destroy(); } catch { /* already gone */ }
      }
    });

    socket.on('error', () => {
      closedByError = true;
      teardown();
    });
    socket.on('close', teardown);
  }

  /* ------------------------------------------------------------------ *
   * Request routing
   * ------------------------------------------------------------------ */

  async function handleRequest(req, res) {
    const url = safeUrl(req.url, authority());
    if (isBridgePath(url.pathname)) {
      if (bridgeHandler === undefined) {
        safeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'bridge API 未挂载' } });
        return;
      }
      await bridgeHandler(req, res, url);
      return;
    }
    if (!state.authReady) {
      // Kick an exchange on demand so the first request after DSH becomes ready
      // does not have to wait for the next backoff tick.
      triggerExchangeOnDemand();
      respondFailure(req, res, url, {
        code: 'upstream-auth-pending',
        status: 503,
        message: state.lastAuthError ?? '等待上游鉴权就绪',
        reason: 'auth-pending',
      });
      return;
    }
    await forwardHttp(req, res);
  }

  function onUpgrade(req, socket, head) {
    socket.on('error', () => { /* handled per-request below; swallow late errors */ });
    if (closed) {
      rejectUpgrade(socket, 503, 'sidecar 已关闭');
      return;
    }
    forwardUpgrade(req, socket, head);
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle
   * ------------------------------------------------------------------ */

  function start() {
    if (startPromise !== undefined) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      const instance = http.createServer((req, res) => {
        handleRequest(req, res).catch((error) => {
          logger.warn('browser-sidecar: 请求处理失败：%s', errorMessage(error));
          if (!res.headersSent) {
            safeJson(res, 500, { ok: false, error: { code: 'sidecar-error', message: errorMessage(error) } });
          } else {
            try { res.destroy(); } catch { /* already gone */ }
          }
        });
      });
      server = instance;
      instance.requestTimeout = 0; // long uploads / SSE must not be cut by node's default
      instance.headersTimeout = 60000;
      instance.keepAliveTimeout = 65000;
      instance.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      instance.on('upgrade', onUpgrade);
      instance.once('error', (error) => {
        state.startError = '监听 ' + host + ':' + String(requestedPort) + ' 失败：' + errorMessage(error);
        logger.error('browser-sidecar: %s', state.startError);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
      instance.listen(requestedPort, host, () => {
        const address = instance.address();
        state.port = address !== null && typeof address === 'object' ? address.port : requestedPort;
        state.startedAt = Date.now();
        logger.info('browser-sidecar: 代理已监听 http://%s:%s/ → http://%s:%s/', host, String(state.port), upstreamHost, String(upstreamPort));
        resolve();
        // Start the credential exchange immediately after bind; if the launch URL
        // is not available yet the attempt fails and the retry ladder takes over.
        void triggerExchange();
      });
    });
    // Mark the rejection handled so a caller that forgets cannot crash the process.
    startPromise.catch(() => undefined);
    return startPromise;
  }

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    state.authReady = false;
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    const pending = [];
    if (state.exchangeInFlight !== null) pending.push(state.exchangeInFlight.catch(() => undefined));
    for (const socket of sockets) {
      try { socket.destroy(); } catch { /* already gone */ }
    }
    sockets.clear();
    const current = server;
    server = undefined;
    if (current !== undefined) {
      pending.push(new Promise((resolve) => {
        try {
          current.close(() => resolve());
        } catch {
          resolve();
        }
      }));
    }
    return Promise.all(pending).then(() => undefined);
  }

  function setAuthUrlProvider(provider) {
    getAuthUrl = provider;
  }

  return {
    start,
    close,
    health,
    triggerExchange,
    refreshAuth,
    setAuthUrlProvider,
    setUpstreamPort,
    get port() {
      return state.port;
    },
    get upstreamPort() {
      return upstreamPort;
    },
    get authority() {
      return authority();
    },
    get state() {
      return {
        authReady: state.authReady,
        lastAuthError: state.lastAuthError,
        lastAuthAt: state.lastAuthAt,
        attempts: state.attempts,
        startError: state.startError,
        port: state.port,
        closed,
      };
    },
  };
}

/** Exported for tests/diagnostics: the cookie name DSH derives from an authority. */
export function authCookieName(authority) {
  return 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url');
}
