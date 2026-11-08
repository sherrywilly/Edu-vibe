import { isIP } from 'node:net';

type Environment = Readonly<Record<string, string | undefined>>;

export class RuntimeConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid production configuration: ${problems.join('; ')}`);
    this.name = 'RuntimeConfigError';
  }
}

function validOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !host.includes('*') &&
      host !== 'localhost' &&
      !host.endsWith('.localhost') &&
      host !== '0.0.0.0' &&
      !host.startsWith('127.') &&
      host !== '[::]' &&
      host !== '[::1]' &&
      !host.startsWith('[::ffff:7f')
    );
  } catch {
    return false;
  }
}

function validDatabaseUrl(value: string | undefined): boolean {
  if (!value || value !== value.trim() || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      !!url.hostname &&
      url.pathname.length > 1 &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validSecret(value: string | undefined): boolean {
  if (
    !value ||
    value !== value.trim() ||
    value.length < 32 ||
    Buffer.byteLength(value, 'utf8') > 1024 ||
    Array.from(value).some((char) => {
      const code = char.codePointAt(0)!;
      return code < 32 || code === 127;
    }) ||
    new Set(value).size < 8 ||
    /^(.{1,16})\1+$/.test(value) ||
    /replace|change.?me|placeholder|example|your.?secret|abcdefghijklmnopqrstuvwxyz|0123456789/i.test(
      value,
    )
  )
    return false;
  return true;
}

function validProxies(value: string | undefined): boolean {
  if (!value) return false;
  return value.split(',').every((item) => {
    const address = item.trim();
    if (!isIP(address) || address.includes('%')) return false;
    if (address === '0.0.0.0') return false;
    if (isIP(address) === 6) {
      const canonical = new URL(`http://[${address}]/`).hostname;
      if (canonical === '[::]' || canonical === '[::ffff:0:0]') return false;
    }
    return true;
  });
}

/**
 * Validate before loading the application, whose modules instantiate clients.
 * The proxy policy controls networkIdentity, not Express's trust proxy setting.
 */
export function validateRuntimeConfig(env: Environment = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  const problems: string[] = [];
  if (!validSecret(env.RATE_LIMIT_SECRET))
    problems.push(
      'RATE_LIMIT_SECRET must be a non-placeholder random secret of at least 32 characters',
    );
  if (!validOrigin(env.WEB_ORIGIN))
    problems.push('WEB_ORIGIN must be an exact, non-local HTTPS origin');
  if (!validDatabaseUrl(env.DATABASE_URL))
    problems.push(
      'DATABASE_URL must be a PostgreSQL URL with a host and database',
    );

  const mode = env.RATE_LIMIT_IP_MODE;
  if (mode !== 'direct' && mode !== 'forwarded' && mode !== 'disabled') {
    problems.push('RATE_LIMIT_IP_MODE must be direct, forwarded, or disabled');
  } else if (mode === 'forwarded') {
    if (!validProxies(env.RATE_LIMIT_TRUSTED_PROXIES))
      problems.push(
        'RATE_LIMIT_TRUSTED_PROXIES must contain exact proxy IP addresses',
      );
  } else if (env.RATE_LIMIT_TRUSTED_PROXIES?.trim()) {
    problems.push(
      'RATE_LIMIT_TRUSTED_PROXIES is only permitted in forwarded mode',
    );
  }

  if (problems.length) throw new RuntimeConfigError(problems);
}
