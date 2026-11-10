/**
 * Minimal HTTP / SSE / raw-WebSocket clients for the dsh-browser-sidecar tests.
 * No dependencies: node builtins only, matching the plugin's own constraint.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * One plain HTTP request to 127.0.0.1:<port>.
 *
 * @param {{
 *   port: number,
 *   method?: string,
 *   path?: string,
 *   headers?: Record<string, string>,
 *   body?: string|Buffer|object,
 *   timeoutMs?: number,
 * }} options
 */
export function httpRequest(options) {
  const { port, method = 'GET', path = '/', headers = {}, body, timeoutMs = 8000 } = options;
  return new Promise((resolve, reject) => {
    const outgoing = {};
    for (const [key, value] of Object.entries(headers)) outgoing[key] = value;
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      if (outgoing['content-type'] === undefined && outgoing['Content-Type'] === undefined) {
        outgoing['content-type'] = 'application/json; charset=utf-8';
      }
      if (outgoing['content-length'] === undefined && outgoing['Content-Length'] === undefined) {
        outgoing['content-length'] = String(Buffer.byteLength(payload));
      }
    }
    const request = http.request({ host: '127.0.0.1', port, method, path, headers: outgoing, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: buffer,
          text,
          json: parseJson(text),
        });
      });
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('http request timeout')));
    request.on('error', reject);
    if (payload !== undefined) request.end(payload);
    else request.end();
  });
}

/**
 * Consume a Server-Sent Events stream, recording arrival times so a test can
 * prove the proxy streams instead of buffering the whole response.
 *
 * @param {{ port: number, path: string, headers?: Record<string,string>, timeoutMs?: number }} options
 */
export function collectSse(options) {
  const { port, path, headers = {}, timeoutMs = 8000 } = options;
  return new Promise((resolve, reject) => {
    const events = [];
    const stamps = [];
    const startedAt = Date.now();
    let endedAt;
    const request = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers, agent: false }, (response) => {
      response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          events.push(buffer.slice(0, index));
          stamps.push(Date.now() - startedAt);
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf('\n\n');
        }
      });
      response.on('end', () => {
        endedAt = Date.now() - startedAt;
        resolve({ status: response.statusCode ?? 0, headers: response.headers, events, stamps, endedAt });
      });
      response.on('error', reject);
    });
    const timer = setTimeout(() => request.destroy(new Error('sse timeout')), timeoutMs);
    timer.unref();
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

/**
 * Perform a raw WebSocket upgrade handshake against the sidecar, resolving once
 * the response headers arrived. The returned socket is the same TCP socket, so
 * the caller can exchange raw bytes (the mock upstream echoes them).
 *
 * @param {{ port: number, path: string, headers?: Record<string,string>, timeoutMs?: number }} options
 */
export function rawUpgrade(options) {
  const { port, path, headers = {}, timeoutMs = 8000 } = options;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0);
    const fail = (error) => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.destroy();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const split = buffer.indexOf('\r\n\r\n');
      if (split === -1) return;
      socket.off('data', onData);
      socket.off('error', onError);
      const head = buffer.subarray(0, split).toString('latin1');
      const rest = buffer.subarray(split + 4);
      const status = Number(head.split(' ')[1]);
      resolve({ socket, status, head, rest });
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.once('connect', () => {
      const key = randomBytes(16).toString('base64');
      const lines = [
        'GET ' + path + ' HTTP/1.1',
        'Host: 127.0.0.1:' + String(port),
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Key: ' + key,
        'Sec-WebSocket-Version: 13',
      ];
      for (const [name, value] of Object.entries(headers)) lines.push(name + ': ' + value);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    const timer = setTimeout(() => fail(new Error('upgrade handshake timeout')), timeoutMs);
    timer.unref();
  });
}

/**
 * Write one payload on an upgraded socket and resolve with the bytes echoed back.
 *
 * @param {import('node:net').Socket} socket
 * @param {Buffer|string} payload
 * @param {number} [timeoutMs]
 */
export function echoOnce(socket, payload, timeoutMs = 4000) {
  const expected = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= expected.length) {
        cleanup();
        resolve(Buffer.concat(chunks).subarray(0, expected.length));
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed before echo arrived'));
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.write(expected);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('ws echo timeout'));
    }, timeoutMs);
    timer.unref();
  });
}

/** Poll `predicate` until it is truthy or the timeout expires. */
export async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('timeout waiting for ' + label);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
