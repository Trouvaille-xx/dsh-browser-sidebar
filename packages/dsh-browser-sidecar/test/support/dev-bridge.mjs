#!/usr/bin/env node
/**
 * Bridge-only dev server for integration smoke checks.
 *
 * Runs the /__bridge/* API (and the degraded `/` page) without the DSH Host, so
 * the Chrome extension's own verifier can be pointed at a real implementation:
 *
 *   node packages/dsh-browser-sidecar/test/support/dev-bridge.mjs --port 41889
 *   node extension/test/verify-bridge.mjs --bridge http://127.0.0.1:41889
 *
 * This is a test/dev utility, not part of the plugin (package.json `files` does
 * not include it). An optional `--upstream-port` lets the proxy side report
 * auth-pending/upstream-unreachable health without a real DSH running.
 */
import { createBridgeHandler } from '../../bridge.js';
import { createSidecarProxy } from '../../proxy.js';

function parsePort(args, flag, fallback) {
  const index = args.indexOf(flag);
  const inline = args.find((arg) => arg.startsWith(flag + '='));
  const raw = inline !== undefined ? inline.slice(flag.length + 1) : index >= 0 ? args[index + 1] : undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= 65535 ? value : fallback;
}

const args = process.argv.slice(2);
const port = parsePort(args, '--port', 41889);
const upstreamPort = parsePort(args, '--upstream-port', 4064);

const store = new (await import('../../context-store.js')).ContextStore();
let proxy;
const bridge = createBridgeHandler({
  store,
  getHealth: () => proxy.health(),
  logger: { info() {}, warn() {}, error() {} },
});
proxy = createSidecarProxy({
  port,
  upstreamPort,
  bridgeHandler: bridge,
  getAuthUrl: () => undefined, // no DSH connection here: `/` stays diagnostic
  logger: {
    info: (format, ...values) => console.log('[dev-bridge] ' + format, ...values),
    warn: (format, ...values) => console.warn('[dev-bridge] ' + format, ...values),
    error: (format, ...values) => console.error('[dev-bridge] ' + format, ...values),
  },
});

await proxy.start();
console.log('[dev-bridge] listening on http://127.0.0.1:' + String(proxy.port) +
  ' (upstream ' + String(upstreamPort) + ')');
console.log('[dev-bridge] endpoints: GET /__bridge/health, POST /__bridge/context, ' +
  'GET /__bridge/context/latest, GET /__bridge/context/list');

const shutdown = async () => {
  await proxy.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
