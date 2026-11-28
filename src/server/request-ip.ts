import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    clientIp: string;
  }
}

function normalizeIp(value: string | undefined) {
  if (!value) return undefined;
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6 || value.includes('%')) return undefined;
  const ipv6 = new URL(`http://[${value}]`).hostname.slice(1, -1);
  if (!ipv6.startsWith('::ffff:')) return ipv6;
  const [high, low] = ipv6
    .slice(7)
    .split(':')
    .map((part) => Number.parseInt(part, 16));
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

export function effectiveClientIp(
  request: Pick<FastifyRequest, 'raw' | 'headers' | 'ip'>,
  trustCloudflareTunnel: boolean,
) {
  const peer = normalizeIp(request.raw.socket.remoteAddress);
  if (trustCloudflareTunnel && (peer === '::1' || peer?.startsWith('127.'))) {
    const header = request.headers['cf-connecting-ip'];
    if (typeof header === 'string') {
      const visitor = normalizeIp(header.trim());
      if (visitor) return visitor;
    }
  }
  return peer ?? normalizeIp(request.ip) ?? '';
}

export function resolveListenHost(env = process.env) {
  const host = env.HOST || '0.0.0.0';
  if (
    env.TRUST_CLOUDFLARE_TUNNEL === 'true' &&
    host !== '127.0.0.1' &&
    host !== '::1'
  )
    throw new Error(
      'TRUST_CLOUDFLARE_TUNNEL requires HOST=127.0.0.1 or HOST=::1',
    );
  return host;
}
