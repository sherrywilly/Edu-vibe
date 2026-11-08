import type { Request } from 'express';
import { networkIdentity } from './network';

const request = (peer: string | undefined, forwarded?: string) =>
  ({
    socket: { remoteAddress: peer },
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  }) as Request;

describe('networkIdentity', () => {
  const originalMode = process.env.RATE_LIMIT_IP_MODE;
  const originalProxies = process.env.RATE_LIMIT_TRUSTED_PROXIES;

  afterEach(() => {
    if (originalMode === undefined) delete process.env.RATE_LIMIT_IP_MODE;
    else process.env.RATE_LIMIT_IP_MODE = originalMode;
    if (originalProxies === undefined)
      delete process.env.RATE_LIMIT_TRUSTED_PROXIES;
    else process.env.RATE_LIMIT_TRUSTED_PROXIES = originalProxies;
  });

  it('does not use a shared proxy or spoofed headers by default', () => {
    delete process.env.RATE_LIMIT_IP_MODE;
    expect(networkIdentity(request('10.0.0.2', '1.2.3.4'))).toBeUndefined();
  });

  it('uses only the socket address in direct mode', () => {
    process.env.RATE_LIMIT_IP_MODE = 'direct';
    expect(networkIdentity(request('::ffff:192.0.2.10', '1.2.3.4'))).toBe(
      '192.0.2.10',
    );
    expect(networkIdentity(request(undefined))).toBeUndefined();
  });

  it('requires an explicitly trusted immediate proxy and walks the chain from the right', () => {
    process.env.RATE_LIMIT_IP_MODE = 'forwarded';
    process.env.RATE_LIMIT_TRUSTED_PROXIES = '10.0.0.2, 2001:db8::1';
    expect(
      networkIdentity(request('10.0.0.2', '6.6.6.6, 192.0.2.5, 2001:0db8::1')),
    ).toBe('192.0.2.5');
    expect(networkIdentity(request('10.0.0.3', '192.0.2.5'))).toBeUndefined();
    expect(networkIdentity(request('10.0.0.2', '2001:db8::1'))).toBeUndefined();
  });

  it('does not use missing, malformed, oversized, or ambiguous forwarding data', () => {
    process.env.RATE_LIMIT_IP_MODE = 'forwarded';
    process.env.RATE_LIMIT_TRUSTED_PROXIES = '10.0.0.2';
    expect(networkIdentity(request('10.0.0.2'))).toBeUndefined();
    expect(
      networkIdentity(request('10.0.0.2', '192.0.2.1, invalid')),
    ).toBeUndefined();
    expect(
      networkIdentity(
        request('10.0.0.2', Array(33).fill('192.0.2.1').join(',')),
      ),
    ).toBeUndefined();
    expect(
      networkIdentity(request('10.0.0.2', 'x'.repeat(2049))),
    ).toBeUndefined();
    process.env.RATE_LIMIT_TRUSTED_PROXIES = '10.0.0.2,10.0.0.0/8';
    expect(networkIdentity(request('10.0.0.2', '192.0.2.1'))).toBeUndefined();
  });

  it('normalizes IPv4-mapped proxies and IPv6 clients', () => {
    process.env.RATE_LIMIT_IP_MODE = 'forwarded';
    process.env.RATE_LIMIT_TRUSTED_PROXIES = '10.0.0.2';
    expect(
      networkIdentity(request('::ffff:10.0.0.2', '2001:0db8:0:0::2')),
    ).toBe('2001:db8::2');
  });
});
