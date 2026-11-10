/*!
 * DSH 侧边栏扩展 · 网络小工具（lib/net.js）
 * ---------------------------------------------------------------------------
 * 只做三件事：带超时的 fetch、JSON 收发、失败重试一次。
 * 与 core.js 一样是「经典脚本 + CJS 双兼容」：service worker 用 importScripts 加载，
 * sidepanel/options 用 <script src> 加载，Node 测试里按 CJS 引入。
 *
 * bridge 不是扩展的同源服务，所以：
 *   - 请求方（sidepanel / SW）必须容忍 CORS 失败、连接拒绝、超时；
 *   - 所有错误都收敛成 { ok:false, error } 而不是 throw，调用方不需要 try/catch。
 */

(function (global) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 3000;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
  }

  function describeError(error, url) {
    if (!error) return `请求失败：${url}`;
    if (error.name === 'AbortError') return `请求超时（>${DEFAULT_TIMEOUT_MS}ms）：${url}`;
    const msg = error.message || String(error);
    if (/Failed to fetch|NetworkError|fetch failed|ECONNREFUSED/i.test(msg)) {
      return `无法连接 bridge（确认 DSH 已启动且端口正确）：${url}`;
    }
    return `${msg}：${url}`;
  }

  /**
   * fetch + AbortController 超时。
   * @returns {Promise<{ok:boolean, response?:Response, error?:string, timedOut?:boolean, durationMs:number}>}
   */
  async function fetchWithTimeout(url, options) {
    const opts = options || {};
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const started = Date.now();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (controller) {
        try { controller.abort(); } catch (_) { /* ignore */ }
      }
    }, timeoutMs);
    const init = Object.assign({}, opts, { signal: controller ? controller.signal : undefined });
    delete init.timeoutMs;
    try {
      const response = await fetch(url, init);
      return { ok: true, response, durationMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
        error: timedOut ? `请求超时（>${timeoutMs}ms）：${url}` : describeError(error, url),
        timedOut,
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET JSON。
   * @returns {Promise<{ok:boolean, status?:number, data?:any, error?:string, durationMs:number}>}
   */
  async function getJson(url, options) {
    const opts = options || {};
    const result = await fetchWithTimeout(url, Object.assign({ method: 'GET', cache: 'no-store' }, opts));
    if (!result.ok) return { ok: false, error: result.error, durationMs: result.durationMs };
    const { response } = result;
    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      return { ok: false, status: response.status, error: `读取响应失败：${error && error.message}`, durationMs: result.durationMs };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `bridge 返回 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`,
        durationMs: result.durationMs,
      };
    }
    if (!text) return { ok: true, status: response.status, data: null, durationMs: result.durationMs };
    try {
      return { ok: true, status: response.status, data: JSON.parse(text), durationMs: result.durationMs };
    } catch (_) {
      return {
        ok: false,
        status: response.status,
        error: `bridge 返回的不是 JSON：${text.slice(0, 160)}`,
        durationMs: result.durationMs,
      };
    }
  }

  /**
   * POST JSON。
   * @returns {Promise<{ok:boolean, status?:number, data?:any, error?:string, durationMs:number}>}
   */
  async function postJson(url, body, options) {
    const opts = options || {};
    const result = await fetchWithTimeout(url, Object.assign({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body === undefined ? null : body),
      cache: 'no-store',
    }, opts));
    if (!result.ok) return { ok: false, error: result.error, durationMs: result.durationMs };
    const { response } = result;
    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      return { ok: false, status: response.status, error: `读取响应失败：${error && error.message}`, durationMs: result.durationMs };
    }
    let data = null;
    let jsonOk = true;
    if (text) {
      try { data = JSON.parse(text); } catch (_) { jsonOk = false; }
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `bridge 返回 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`,
        durationMs: result.durationMs,
      };
    }
    if (!jsonOk) {
      return {
        ok: false,
        status: response.status,
        error: `bridge 返回的不是 JSON：${text.slice(0, 160)}`,
        durationMs: result.durationMs,
      };
    }
    return { ok: true, status: response.status, data, durationMs: result.durationMs };
  }

  /**
   * 失败重试（默认总共 2 次尝试 = 重试 1 次，符合规格 §3「超时/重试 1 次」）。
   * @param {() => Promise<any>} task
   * @param {{retries?:number, delayMs?:number}} [options]
   */
  async function withRetry(task, options) {
    const opts = options || {};
    const retries = Number.isInteger(opts.retries) ? Math.max(0, opts.retries) : 1;
    const delayMs = Number.isInteger(opts.delayMs) ? Math.max(0, opts.delayMs) : 250;
    let last = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        last = await task(attempt);
      } catch (error) {
        last = { ok: false, error: describeError(error, '') };
      }
      if (last && last.ok) return Object.assign({ attempts: attempt + 1 }, last);
      if (attempt < retries) await sleep(delayMs);
    }
    return Object.assign({ attempts: retries + 1 }, last || { ok: false, error: '未知错误' });
  }

  const api = {
    DEFAULT_TIMEOUT_MS,
    sleep,
    describeError,
    fetchWithTimeout,
    getJson,
    postJson,
    withRetry,
  };

  try {
    global.DSHNet = api;
  } catch (_) { /* ignore */ }
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis
  : typeof self !== 'undefined' ? self
    : this));
