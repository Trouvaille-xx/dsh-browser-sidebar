/**
 * dsh-browser-sidecar — Host plugin entry.
 *
 * Wires the four pieces the Chrome side panel needs into the running Harness:
 *
 *   1. a loopback reverse proxy (`http://127.0.0.1:41789` by default) so the side
 *      panel iframe can load the official DSH Web UI with the launch credential
 *      injected server-side (see proxy.js),
 *   2. the /__bridge/* context API the extension pushes page snapshots to
 *      (see bridge.js),
 *   3. the `browser_page` agent tool (see tools.js),
 *   4. a <= 5 line system-prompt section telling the agent when to read that
 *      context.
 *
 * Hard constraint: this module imports only node builtins and the plugin's own
 * files. A `link:`-installed bundle resolves from its real path, so importing
 * anything from `@deepseek-ai/*` would fail at load time. Everything is taken
 * from injected cordis services (`connection`, `systemPrompt`, `tools`).
 *
 * Degraded behaviour is deliberate: if the proxy cannot bind, or `connection`
 * never arrives, the tool and bridge API still work and nothing throws — the
 * proxy serves a diagnosable page and retries the token exchange in the
 * background.
 */
import { ContextStore } from './context-store.js';
import { createBridgeHandler } from './bridge.js';
import { createSidecarProxy } from './proxy.js';
import { createBrowserPageTool } from './tools.js';
import { DEFAULT_PORT, DEFAULT_UPSTREAM_PORT, SIDECAR_HOST, VERSION } from './core.js';

export { ContextStore } from './context-store.js';
export { createBridgeHandler } from './bridge.js';
export { createSidecarProxy, authCookieName } from './proxy.js';
export { createBrowserPageTool } from './tools.js';
export * from './core.js';

/** Stable cordis plugin name. */
export const name = 'browser-sidecar';

/** Prompt section order: right after the plan/team policy blocks, before tool docs. */
const PROMPT_SECTION_ORDER = 700;

/** Injected into every agent: <= 5 lines, only about this plugin's surface. */
export const SYSTEM_PROMPT_SECTION = [
  '用户可能在 Chrome 侧边栏里询问他当前正在看的网页或视频；这些内容是用户主动同步到本机 bridge 的，不是实时读取。',
  '问题涉及「当前页面 / 这个网页 / 这个视频 / 我屏幕上」时，先调用 browser_page(mode="summary") 判断有没有上下文，',
  '再按需用 mode=page 取正文、selection 取选中文本、video 看视频信息、transcript 取字幕；没有上下文时请用户点侧边栏的「读取当前页」。',
  '同步有延迟，页面可能已经变化：引用时说明抓取时间（工具返回里带 capturedAt）。',
].join('\n');

function errorMessage(error) {
  if (error === undefined || error === null) return String(error);
  return error instanceof Error ? error.message : String(error);
}

function readPort(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 65535 ? value : fallback;
}

function makeLogger(ctx) {
  try {
    if (typeof ctx.logger === 'function') {
      const logger = ctx.logger('browser-sidecar');
      if (logger && typeof logger.info === 'function') return logger;
    }
  } catch { /* fall through to console */ }
  return {
    info: (...args) => console.log('[browser-sidecar]', ...args),
    warn: (...args) => console.warn('[browser-sidecar]', ...args),
    error: (...args) => console.error('[browser-sidecar]', ...args),
    debug: () => {},
  };
}

/**
 * Compose the plugin.
 *
 * @param {any} ctx - cordis context of the Host plugin fiber
 * @param {any} config - raw config from cordis.patch.yml (not schema-validated)
 */
export function apply(ctx, config) {
  const cfg = config !== null && typeof config === 'object' ? config : {};
  const port = readPort(cfg.port, DEFAULT_PORT);
  // Real Web UI port: the Desktop app boots the web app with `--port 0`, so this
  // is OS-assigned per launch. `upstreamPort > 0` in config pins it; otherwise
  // the value is discovered from the `webServer` service at runtime.
  const configuredUpstreamPort = readPort(cfg.upstreamPort, DEFAULT_UPSTREAM_PORT);
  const upstreamPortPinned = configuredUpstreamPort > 0 && configuredUpstreamPort !== DEFAULT_UPSTREAM_PORT;
  const upstreamPort = configuredUpstreamPort > 0 ? configuredUpstreamPort : DEFAULT_UPSTREAM_PORT;
  const upstreamHost = typeof cfg.upstreamHost === 'string' && cfg.upstreamHost !== '' ? cfg.upstreamHost : SIDECAR_HOST;
  const logger = makeLogger(ctx);

  const store = new ContextStore();

  /** @type {() => string|undefined} set once the `connection` service appears. */
  let authUrlProvider = () => undefined;
  /** @type {((req: any, res: any, url: URL) => Promise<boolean>)|undefined} */
  let bridgeHandlerImpl;

  const proxy = createSidecarProxy({
    port,
    host: SIDECAR_HOST,
    upstreamHost,
    upstreamPort,
    version: VERSION,
    logger,
    getAuthUrl: () => authUrlProvider(),
    bridgeHandler: (req, res, url) => {
      if (bridgeHandlerImpl === undefined) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: { code: 'bridge-not-ready', message: 'bridge API 尚未初始化' } }));
        return Promise.resolve(true);
      }
      return bridgeHandlerImpl(req, res, url);
    },
  });

  bridgeHandlerImpl = createBridgeHandler({
    store,
    getHealth: () => proxy.health(),
    logger,
  });

  /* ── 1. start the proxy (never rejects the plugin load) ───────────────── */
  const started = proxy.start().catch((error) => {
    logger.warn(
      'browser-sidecar: 反向代理无法监听 %s:%d（%s）；bridge API 与 browser_page 仍可用，' +
      '请在 DSH 重启后确认端口占用情况',
      SIDECAR_HOST, port, errorMessage(error),
    );
    return false;
  });
  void started.then((ok) => {
    if (ok !== false) void proxy.triggerExchange();
  });

  /* ── 2. expose a service for diagnostics / tests ──────────────────────── */
  const api = {
    version: VERSION,
    get port() {
      return proxy.port;
    },
    get started() {
      return started;
    },
    /** Full diagnostics: proxy + context store. */
    health() {
      const base = proxy.health();
      return { ...base, context: store.health() };
    },
    proxy,
    store,
    close() {
      return proxy.close();
    },
  };
  try {
    if (typeof ctx.provide === 'function') ctx.provide('browserSidecar', api);
  } catch (error) {
    logger.warn('browser-sidecar: 注册 browserSidecar 服务失败：%s', errorMessage(error));
  }

  /* ── 3. agent tool ────────────────────────────────────────────────────── */
  const registerTool = (toolsCtx) => {
    try {
      const definition = createBrowserPageTool({ store });
      if (typeof toolsCtx.effect === 'function') {
        toolsCtx.effect(() => toolsCtx.tools.register(definition), 'browser-sidecar: browser_page tool');
      } else {
        toolsCtx.tools.register(definition);
      }
    } catch (error) {
      logger.warn('browser-sidecar: 注册 browser_page 工具失败：%s', errorMessage(error));
    }
  };

  /* ── 4. system prompt + connection wiring ─────────────────────────────── */
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], registerTool);

    ctx.inject(['systemPrompt'], (promptCtx) => {
      try {
        const systemPrompt = promptCtx.systemPrompt;
        if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return;
        const register = () => systemPrompt.section({
          name: 'browser-sidecar:browser-context',
          order: PROMPT_SECTION_ORDER,
          text: SYSTEM_PROMPT_SECTION,
        });
        if (typeof promptCtx.effect === 'function') promptCtx.effect(register, 'browser-sidecar: prompt section');
        else register();
      } catch (error) {
        logger.warn('browser-sidecar: 注入系统提示片段失败：%s', errorMessage(error));
      }
    });

    ctx.inject(['connection'], (connectionCtx) => {
      try {
        const connection = connectionCtx.connection;
        if (connection === undefined || typeof connection.authenticatedUrl !== 'function') return;
        authUrlProvider = () => {
          const actualPort = proxy.port;
          if (!Number.isSafeInteger(actualPort)) return undefined;
          // The cookie DSH issues is bound to the request authority, so the URL
          // handed to authenticatedUrl() must carry the sidecar's own port.
          return connection.authenticatedUrl('http://' + SIDECAR_HOST + ':' + String(actualPort) + '/');
        };
        void proxy.triggerExchange();
      } catch (error) {
        logger.warn('browser-sidecar: 读取 connection.authenticatedUrl() 失败：%s', errorMessage(error));
      }
    });
    ctx.inject(['webServer'], (webCtx) => {
      try {
        const webServer = webCtx.webServer;
        const actualPort = webServer !== undefined && Number.isSafeInteger(webServer.port) ? webServer.port : undefined;
        if (actualPort !== undefined && actualPort > 0) {
          // Pinned config wins; otherwise the Web UI's real, per-launch port wins.
          proxy.setUpstreamPort(actualPort, { pinned: upstreamPortPinned });
          logger.info('browser-sidecar: 上游 DSH Web 端口 = %d', actualPort);
        }
      } catch (error) {
        logger.warn('browser-sidecar: 读取 webServer.port 失败：%s', errorMessage(error));
      }
    });

  } else if (typeof ctx.get === 'function') {
    // Compatibility fallback for a bare test context without inject().
    if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') registerTool(ctx);
    try {
      const connection = ctx.get('connection');
      if (connection !== undefined && typeof connection.authenticatedUrl === 'function') {
        authUrlProvider = () => {
          const actualPort = proxy.port;
          if (!Number.isSafeInteger(actualPort)) return undefined;
          return connection.authenticatedUrl('http://' + SIDECAR_HOST + ':' + String(actualPort) + '/');
        };
        void proxy.triggerExchange();
      }
    } catch { /* optional dependency */ }
    try {
      const webServer = ctx.get('webServer');
      const actualPort = webServer !== undefined && Number.isSafeInteger(webServer.port) ? webServer.port : undefined;
      if (actualPort !== undefined && actualPort > 0) proxy.setUpstreamPort(actualPort, { pinned: upstreamPortPinned });
    } catch { /* optional dependency */ }
  }

  /* ── 5. teardown ──────────────────────────────────────────────────────── */
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      store.clear();
      return proxy.close();
    }, 'browser-sidecar: teardown');
  }

  return api;
}
