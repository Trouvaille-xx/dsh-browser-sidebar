/**
 * In-process mock of the DSH Web upstream for the dsh-browser-sidecar tests.
 *
 * It mirrors the real `@deepseek-ai/dsh-client-connection` behaviour that makes
 * the reverse proxy necessary:
 *   - `GET /?token=<launch token>` answers 303 + `Set-Cookie: dsh-auth-<sha256(authority)>`,
 *   - the cookie name and signed audience are derived from the request `Host`
 *     header (authority), so a token exchange only helps requests that keep
 *     that same Host,
 *   - `/api/*` applies the Host/Origin/sec-fetch-site fence, then the cookie,
 *   - `/` (the UI index) only requires the cookie,
 *   - `/api/remote.mux`-style WebSocket upgrades apply the same fence+cookie.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { gzipSync } from 'node:zlib';

/** Same derivation as dsh-client-connection's `cookieName()`. */
export function authCookieName(authority) {
  return 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url');
}

const LOOPBACK_AUTHORITY = /^(127\.0\.0\.1|localhost):\d+$/;
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function parseCookies(headerValue) {
  const out = new Map();
  if (typeof headerValue !== 'string') return out;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    out.set(segment.slice(0, at).trim(), segment.slice(at + 1).trim());
  }
  return out;
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {{ token?: string, sseDelayMs?: number }} [options]
 */
export function createMockUpstream(options = {}) {
  const token = typeof options.token === 'string' ? options.token : 'test-launch-token';
  const sseDelayMs = Number.isFinite(options.sseDelayMs) ? options.sseDelayMs : 25;
  /** cookie value per authority (Host header) */
  const cookies = new Map();
  const requests = [];
  const wsUpgrades = [];
  const fenceFailures = [];
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  let tokenExchanges = 0;

  /** Host/Origin/sec-fetch-site fence, same rules as isTrustedApiRequest(). */
  function fenceFailure(req) {
    const host = req.headers.host;
    if (typeof host !== 'string' || !LOOPBACK_AUTHORITY.test(host)) {
      return { status: 403, reason: 'untrusted-host' };
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return { status: 403, reason: 'cross-site' };
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '') {
      let originHost;
      try {
        originHost = new URL(origin).host;
      } catch {
        return { status: 403, reason: 'bad-origin' };
      }
      if (originHost !== host) return { status: 403, reason: 'origin-mismatch' };
    }
    return undefined;
  }

  /** Cookie check bound to the request authority. */
  function cookieValid(req) {
    const authority = req.headers.host;
    if (typeof authority !== 'string') return false;
    const expected = cookies.get(authority);
    if (expected === undefined) return false;
    const jar = parseCookies(req.headers.cookie);
    return jar.get(authCookieName(authority)) === expected;
  }

  /** Reject an /api request the way the real Connection carrier does. */
  function apiRejection(req, res) {
    const failure = fenceFailure(req);
    if (failure !== undefined) {
      fenceFailures.push({ reason: failure.reason, headers: req.headers });
      writeJson(res, failure.status, { ok: false, error: { code: failure.reason } });
      return true;
    }
    if (!cookieValid(req)) {
      writeJson(res, 401, { ok: false, error: { code: 'unauthorized' } });
      return true;
    }
    return false;
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://mock.invalid');
    requests.push({ method: req.method, path: url.pathname, headers: req.headers });

    // 1. Token exchange endpoint (mirrors authorizeIndex()).
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.getAll('token').length > 0) {
      const tokens = url.searchParams.getAll('token');
      const failure = fenceFailure(req);
      if (failure !== undefined && failure.reason === 'untrusted-host') {
        writeJson(res, 403, { ok: false, error: { code: failure.reason } });
        return;
      }
      if (tokens.length !== 1 || tokens[0] !== token) {
        writeJson(res, 401, { ok: false, error: { code: 'bad-token' } });
        return;
      }
      const authority = req.headers.host;
      const cookieValue = randomBytes(12).toString('hex');
      cookies.set(authority, cookieValue);
      tokenExchanges += 1;
      res.writeHead(303, {
        location: '/',
        'cache-control': 'no-store',
        'set-cookie': [
          authCookieName(authority) + '=' + cookieValue +
          '; Max-Age=86400; Path=/; HttpOnly; SameSite=Strict',
        ],
      });
      res.end();
      return;
    }

    // 2. UI index: cookie only (real authorizeIndex has no Host/Origin fence).
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (!cookieValid(req)) {
        writeJson(res, 401, { ok: false, error: { code: 'unauthorized' } });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>MOCK DSH UI</title></head>' +
        '<body><div id="app">mock-dsh-ui</div></body></html>');
      return;
    }

    // 3. Authenticated API surface.
    if (url.pathname === '/api/echo' && req.method === 'POST') {
      if (apiRejection(req, res)) return;
      const body = await readBody(req);
      writeJson(res, 200, {
        ok: true,
        echo: body,
        method: req.method,
        path: url.pathname,
        headers: req.headers,
      });
      return;
    }

    if (url.pathname === '/api/headers' && req.method === 'GET') {
      if (apiRejection(req, res)) return;
      writeJson(res, 200, { ok: true, headers: req.headers });
      return;
    }

    if (url.pathname === '/api/sse' && req.method === 'GET') {
      if (apiRejection(req, res)) return;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      let index = 0;
      const emit = () => {
        index += 1;
        res.write('id: ' + index + '\ndata: {"n":' + index + '}\n\n');
        if (index >= 3) {
          res.end();
          return;
        }
        setTimeout(emit, sseDelayMs);
      };
      emit();
      return;
    }

    // Test helper: a gzip-encoded response, to prove the proxy never decodes.
    if (url.pathname === '/api/gzip' && req.method === 'GET') {
      if (apiRejection(req, res)) return;
      const payload = Buffer.from(JSON.stringify({ compressed: true, body: 'gzip-passthrough-payload' }));
      const gzipped = gzipSync(payload);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': gzipped.length,
      });
      res.end(gzipped);
      return;
    }

    // Test helper: invalidate every issued cookie, as if the browser session expired.
    if (url.pathname === '/api/revoke' && req.method === 'POST') {
      cookies.clear();
      writeJson(res, 200, { ok: true, revoked: true });
      return;
    }

    writeJson(res, 404, { ok: false, error: { code: 'not-found', path: url.pathname } });
  }

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url ?? '/', 'http://mock.invalid');
    wsUpgrades.push({ path: url.pathname, headers: req.headers });
    socket.on('error', () => { /* test teardown */ });

    const failure = fenceFailure(req);
    if (failure !== undefined || !cookieValid(req)) {
      const status = failure !== undefined ? failure.status : 401;
      socket.write('HTTP/1.1 ' + status + ' Nope\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n',
    );
    // The test client speaks raw bytes, not real WebSocket frames: echo is enough
    // to prove the sidecar tunnels both directions.
    socket.on('data', (chunk) => {
      try { socket.write(chunk); } catch { /* closed */ }
    });
  }

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      try { writeJson(res, 500, { ok: false, error: { code: 'mock-error', message: String(error) } }); } catch { /* closed */ }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head));

  return {
    token,
    get port() {
      const address = server.address();
      return address !== null && typeof address === 'object' ? address.port : 0;
    },
    get url() {
      return 'http://127.0.0.1:' + this.port;
    },
    requests,
    wsUpgrades,
    fenceFailures,
    get tokenExchanges() {
      return tokenExchanges;
    },
    revokeCookies() {
      cookies.clear();
    },
    /** Start listening; resolves with the mock handle. */
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve(this);
        });
      });
    },
    close() {
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* already gone */ }
      }
      sockets.clear();
      return new Promise((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
      });
    },
    /** Convenience: an authenticatedUrl()-shaped launch URL for the given sidecar port. */
    launchUrl(sidecarPort) {
      return 'http://127.0.0.1:' + String(sidecarPort) + '/?token=' + token;
    },
  };
}
