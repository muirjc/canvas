import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { clientIp } from '../../src/audit/audit.service.js';

/** canvas-1bty.14: X-Canvas-Client-IP is the Python front door's, read only with TRUST_CLIENT_IP_HEADER=true. */
const request = (headers: Record<string, string | string[]>) =>
  ({ headers, socket: { remoteAddress: '10.0.0.7' }, ip: '1.1.1.1' }) as unknown as FastifyRequest;

describe('clientIp', () => {
  const original = process.env.TRUST_CLIENT_IP_HEADER;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUST_CLIENT_IP_HEADER;
    else process.env.TRUST_CLIENT_IP_HEADER = original;
  });

  it('ignores X-Canvas-Client-IP unless TRUST_CLIENT_IP_HEADER is "true"', () => {
    const headers = { 'x-canvas-client-ip': '6.6.6.6', 'x-forwarded-for': '5.5.5.5, 203.0.113.9' };
    delete process.env.TRUST_CLIENT_IP_HEADER;
    expect(clientIp(request(headers))).toBe('203.0.113.9');
    process.env.TRUST_CLIENT_IP_HEADER = 'yes';
    expect(clientIp(request(headers))).toBe('203.0.113.9');
    process.env.TRUST_CLIENT_IP_HEADER = 'false';
    expect(clientIp(request(headers))).toBe('203.0.113.9');
  });

  it('uses X-Canvas-Client-IP when trusted, falling back when it is absent or empty', () => {
    process.env.TRUST_CLIENT_IP_HEADER = 'true';
    expect(clientIp(request({ 'x-canvas-client-ip': '198.51.100.4', 'x-forwarded-for': '203.0.113.9' }))).toBe('198.51.100.4');
    expect(clientIp(request({ 'x-canvas-client-ip': '', 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(request({ 'x-forwarded-for': '5.5.5.5, 203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('takes the last X-Forwarded-For entry, else the connection address', () => {
    delete process.env.TRUST_CLIENT_IP_HEADER;
    expect(clientIp(request({ 'x-forwarded-for': ['1.2.3.4', '5.6.7.8'] }))).toBe('5.6.7.8');
    expect(clientIp(request({}))).toBe('10.0.0.7');
  });
});
