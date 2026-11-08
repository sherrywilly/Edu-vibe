import { isIP } from 'node:net';
import type { Request } from 'express';

function normalizeAddress(value: string): string | undefined {
  if (!isIP(value)) return undefined;
  if (isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Returns an address only when the deployment explicitly enables a trustworthy
 * source. Next's default rewrite preserves client-supplied forwarding headers.
 */
export function networkIdentity(req: Request): string | undefined {
  const mode = process.env.RATE_LIMIT_IP_MODE;
  if (mode !== 'direct' && mode !== 'forwarded') return undefined;
  const peer = normalizeAddress(req.socket?.remoteAddress ?? '');
  if (!peer) return undefined;
  if (mode === 'direct') return peer;

  const configured = process.env.RATE_LIMIT_TRUSTED_PROXIES?.split(',') ?? [];
  const proxies = configured.map((value) => normalizeAddress(value.trim()));
  if (!proxies.length || proxies.some((value) => !value)) return undefined;
  const trusted = new Set(proxies);
  if (!trusted.has(peer)) return undefined;

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string' || forwarded.length > 2048)
    return undefined;
  const parts = forwarded.split(',');
  if (parts.length > 32) return undefined;
  const chain = parts.map((value) => normalizeAddress(value.trim()));
  if (chain.some((value) => !value)) return undefined;
  for (let i = chain.length - 1; i >= 0; i--) {
    const address = chain[i]!;
    if (!trusted.has(address)) return address;
  }
  return undefined;
}
