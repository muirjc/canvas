import httpProxy from '@fastify/http-proxy';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';

/**
 * canvas-1bty.3: while the backend moves to Python (docs/python-backend-assessment.md), this service
 * stays the front door: browsers keep one address, and requests under the prefixes the Python service
 * now answers are forwarded to it (an internal-only container in Azure). Cookies go through unchanged
 * -- both services read the same sessions (canvas-1bty.2) -- and so do Set-Cookie headers coming back.
 *
 * Each prefix covers itself and everything under it ("/py" = /py and /py/...). Off when
 * PYTHON_API_URL isn't set.
 */
export async function registerPythonFrontDoor(app: FastifyInstance, config: Pick<AppConfig, 'pythonApiUrl' | 'pythonRoutePrefixes'>): Promise<void> {
  if (!config.pythonApiUrl) return;
  for (const prefix of config.pythonRoutePrefixes) {
    await app.register(httpProxy, {
      upstream: config.pythonApiUrl,
      prefix,
      rewritePrefix: prefix,
      // The upstream sees the original client in X-Forwarded-For and the original host and scheme.
      replyOptions: {
        rewriteRequestHeaders: (request, headers) => ({
          ...headers,
          'x-forwarded-host': request.headers.host ?? '',
          'x-forwarded-proto': request.protocol,
        }),
      },
    });
  }
}
