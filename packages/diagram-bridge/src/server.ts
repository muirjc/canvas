import { createServer, type IncomingMessage, type Server } from 'node:http';
import { BadRequest, handlers } from './handlers.js';

/**
 * canvas-1bty.4: diagram-core over HTTP for the Python service (docs/python-backend-assessment.md,
 * phase 1). Transition only: it goes once diagram-core's server side is ported to Python and passes
 * the golden corpus.
 *
 *   POST /<operation>  JSON body -> 200 JSON | 400 { error } | 404 | 413 | 500 { error }
 *   GET  /health       { status: "ok" }
 *
 * Listens on 127.0.0.1 by default: it runs next to the Python service (a sidecar container sharing
 * its network), never on a public or shared address.
 */

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createBridgeServer(): Server {
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    try {
      const op = (req.url ?? '/').split('?')[0].slice(1);
      if (req.method === 'GET' && op === 'health') return send(200, { status: 'ok' });
      const handler = Object.hasOwn(handlers, op) ? handlers[op] : undefined;
      if (req.method !== 'POST' || !handler) return send(404, { error: 'not found' });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (error) {
        if ((error as { status?: number }).status === 413) return send(413, { error: 'body too large' });
        return send(400, { error: 'body must be JSON' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'body must be a JSON object' });
      return send(200, await handler(body as Record<string, unknown>));
    } catch (error) {
      if (error instanceof BadRequest) return send(400, { error: error.message });
      // No stack traces or input echoed back.
      return send(500, { error: 'internal error' });
    }
  });
}
