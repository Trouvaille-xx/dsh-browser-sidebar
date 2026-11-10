/**
 * dsh-browser-sidecar bridge API — /__bridge/* JSON endpoints used by the Chrome
 * extension.
 *
 * Design notes:
 *  - Only loopback (`127.0.0.1` / `localhost`) and `chrome-extension://` origins
 *    are allowed. Any other browser origin is refused, so a random web page the
 *    user visits cannot read synced page content from the local bridge.
 *  - Requests without an `Origin` header (curl, node, the health check) are
 *    treated as local tooling and allowed; the socket is loopback-only anyway.
 *  - The read/write surface is deliberately tiny: JSON snapshots in, JSON out.
 *    No file, shell, or navigation endpoints exist here.
 */
import { BridgeError, LIMITS } from './core.js';

export const BRIDGE_PREFIX = '/__bridge';

/** True for /__bridge and /__bridge/* — these must never be proxied upstream. */
export function isBridgePath(pathname) {
  return pathname === BRIDGE_PREFIX || pathname.startsWith(BRIDGE_PREFIX + '/');
}

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-z0-9]+$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

/** Whether one browser Origin may talk to the bridge. */
export function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') return false;
  return EXTENSION_ORIGIN.test(origin) || LOOPBACK_ORIGIN.test(origin);
}

/**
 * CORS headers for one request Origin.
 *
 * @param {string|undefined} origin
 * @returns {{ allowed: boolean, headers: Record<string,string> }}
 */
export function corsFor(origin) {
  if (typeof origin !== 'string' || origin === '') return { allowed: true, headers: {} };
  if (!isAllowedOrigin(origin)) return { allowed: false, headers: {} };
  return {
    allowed: true,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    },
  };
}

function writeJson(res, status, headers, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function writeError(res, headers, error) {
  const status = error instanceof BridgeError ? error.status : 500;
  const code = error instanceof BridgeError ? error.code : 'internal-error';
  writeJson(res, status, headers, { ok: false, error: { code, message: error.message } });
}

/** Read a request body with a hard byte cap. */
export function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        // Keep draining (without buffering) so the client can finish its upload
        // and still read the 413 instead of seeing a connection reset.
        fail(new BridgeError('payload-too-large', '快照请求体超过 ' + limitBytes + ' 字节上限', 413));
        try { req.resume(); } catch { /* already gone */ }
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (error) => fail(error instanceof Error ? error : new Error(String(error)));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/** Parse a JSON body, rejecting anything that is not an object. */
async function readJsonObject(req, limitBytes) {
  // The byte cap is enforced while draining in readBody(), so an oversize upload
  // is answered with a 413 without buffering it in memory.
  const raw = await readBody(req, limitBytes);
  if (raw.trim() === '') throw new BridgeError('invalid-json', '请求体为空，需要一个 JSON 对象');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BridgeError('invalid-json', '请求体不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BridgeError('invalid-json', '请求体必须是 JSON 对象');
  }
  return parsed;
}

/**
 * Build the /__bridge/* handler.
 *
 * @param {{
 *   store: import('./context-store.js').ContextStore,
 *   getHealth: () => { version: string, uptimeMs: number, upstream: object },
 *   logger?: { warn: Function },
 * }} options
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL) => Promise<boolean>}
 *   Resolves true when the request was handled (bridge path), false otherwise.
 */
export function createBridgeHandler(options) {
  const store = options.store;
  const getHealth = options.getHealth;
  const logger = options.logger;

  return async function handleBridge(req, res, url) {
    const pathname = url.pathname;
    if (!isBridgePath(pathname)) return false;

    const cors = corsFor(req.headers.origin);
    if (req.method === 'OPTIONS') {
      if (!cors.allowed) {
        if (logger) logger.warn('bridge: rejected preflight from origin %s', req.headers.origin);
        writeJson(res, 403, {}, { ok: false, error: { code: 'forbidden-origin', message: '来源不被允许：' + String(req.headers.origin) } });
        return true;
      }
      res.writeHead(204, cors.headers);
      res.end();
      return true;
    }

    if (!cors.allowed) {
      if (logger) logger.warn('bridge: rejected request from origin %s', req.headers.origin);
      writeJson(res, 403, {}, { ok: false, error: { code: 'forbidden-origin', message: '来源不被允许：' + String(req.headers.origin) } });
      return true;
    }
    const headers = cors.headers;

    try {
      if (pathname === BRIDGE_PREFIX + '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        const base = getHealth();
        writeJson(res, 200, headers, {
          ok: true,
          version: base.version,
          uptimeMs: base.uptimeMs,
          upstream: base.upstream,
          context: store.health(),
        });
        return true;
      }

      if (pathname === BRIDGE_PREFIX + '/context') {
        if (req.method !== 'POST') throw new BridgeError('method-not-allowed', '请使用 POST 推送快照', 405);
        const body = await readJsonObject(req, LIMITS.maxBodyBytes);
        const result = store.upsert(body);
        writeJson(res, 200, headers, {
          ok: true,
          id: result.snapshot.id,
          tabId: result.snapshot.tabId,
          updatedAt: result.snapshot.receivedAt,
          activeTabId: result.activeTabId ?? null,
        });
        return true;
      }

      if (pathname === BRIDGE_PREFIX + '/context/latest') {
        if (req.method !== 'GET') throw new BridgeError('method-not-allowed', '请使用 GET', 405);
        const rawTabId = url.searchParams.get('tabId');
        const tabId = rawTabId === null ? undefined : Number(rawTabId);
        const rawWindowId = url.searchParams.get('windowId');
        const windowId = rawWindowId === null ? undefined : Number(rawWindowId);
        const snapshot = store.latest(tabId);
        if (snapshot === undefined) {
          writeJson(res, 404, headers, {
            ok: false,
            error: {
              code: 'no-context',
              message: tabId === undefined || Number.isNaN(tabId)
                ? '还没有任何浏览器页面快照；请先在侧边栏点击「读取当前页」'
                : '标签页 ' + rawTabId + ' 没有快照；请先在该标签页点击「读取当前页」',
            },
          });
          return true;
        }
        if (Number.isSafeInteger(windowId) && snapshot.windowId !== windowId) {
          writeJson(res, 404, headers, {
            ok: false,
            error: { code: 'no-context', message: '窗口 ' + rawWindowId + ' 里没有该标签页的当前快照' },
          });
          return true;
        }
        // Raw snapshot at the top level (spec §2: "→ 最新快照"), so the side
        // panel can feed it straight into validateSnapshot().
        writeJson(res, 200, headers, snapshot);
        return true;
      }

      if (pathname === BRIDGE_PREFIX + '/active') {
        if (req.method !== 'POST') throw new BridgeError('method-not-allowed', '请使用 POST 报告活动标签页', 405);
        const body = await readJsonObject(req, LIMITS.maxBodyBytes);
        const tabId = body.tabId;
        if (!Number.isSafeInteger(tabId)) throw new BridgeError('invalid-tab', 'tabId 必须是整数');
        const known = store.setActive(tabId);
        writeJson(res, 200, headers, {
          ok: known,
          tabId,
          activeTabId: store.getActiveTabId(),
          ...(known ? {} : { error: { code: 'no-context', message: '该标签页还没有快照；请先同步页面内容' } }),
        });
        return true;
      }

      if (pathname === BRIDGE_PREFIX + '/context/list') {
        if (req.method !== 'GET') throw new BridgeError('method-not-allowed', '请使用 GET', 405);
        const rows = store.list();
        writeJson(res, 200, headers, { ok: true, count: rows.length, activeTabId: store.getActiveTabId(), tabs: rows });
        return true;
      }

      throw new BridgeError('not-found', '未知的 bridge 端点：' + pathname, 404);
    } catch (error) {
      if (logger && !(error instanceof BridgeError)) logger.warn('bridge: %s', error && error.message ? error.message : String(error));
      writeError(res, headers, error instanceof Error ? error : new Error(String(error)));
      return true;
    }
  };
}
