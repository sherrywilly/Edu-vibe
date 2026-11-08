import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { RuntimeConfigError, validateRuntimeConfig } from './runtime-config';

const production = {
  NODE_ENV: 'production',
  RATE_LIMIT_SECRET: 'mU6fY9pKn3cR2zQ8vH4sL7dT1wB5xA0j',
  WEB_ORIGIN: 'https://school.example',
  DATABASE_URL: 'postgresql://database:5432/eduvibe?schema=public',
  RATE_LIMIT_IP_MODE: 'direct',
};

describe('production runtime configuration', () => {
  it('leaves development and test configuration unchanged', () => {
    for (const NODE_ENV of [undefined, 'development', 'test']) {
      expect(() => validateRuntimeConfig({ NODE_ENV })).not.toThrow();
    }
  });

  it('accepts explicit direct, disabled and forwarded policies', () => {
    expect(() => validateRuntimeConfig(production)).not.toThrow();
    expect(() =>
      validateRuntimeConfig({ ...production, RATE_LIMIT_IP_MODE: 'disabled' }),
    ).not.toThrow();
    expect(() =>
      validateRuntimeConfig({
        ...production,
        RATE_LIMIT_IP_MODE: 'forwarded',
        RATE_LIMIT_TRUSTED_PROXIES: '10.0.0.2, 2001:db8::1, ::ffff:10.0.0.3',
      }),
    ).not.toThrow();
  });

  it.each([
    undefined,
    '',
    'short',
    'a'.repeat(32),
    'abcdefgh'.repeat(4),
    'replace-with-a-separate-long-random-secret',
    'abcdefghijklmnopqrstuvwxyz0123456789',
    ' leading-and-trailing-whitespace-secret ',
  ])('rejects unsafe secrets without disclosing them', (secret) => {
    try {
      validateRuntimeConfig({ ...production, RATE_LIMIT_SECRET: secret });
      throw new Error('validation unexpectedly succeeded');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigError);
      expect((error as Error).message).toContain('RATE_LIMIT_SECRET');
      if (secret) expect((error as Error).message).not.toContain(secret);
    }
  });

  it.each([
    undefined,
    '*',
    'null',
    'http://school.example',
    'https://*.example.com',
    'https://localhost',
    'https://foo.localhost',
    'https://127.0.0.1',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    ['https://user', 'school.example'].join('@'),
    'https://school.example/',
    'https://school.example/path',
    'https://school.example?x=1',
    'https://school.example#x',
    'https://school.example:443',
  ])('rejects unsafe or non-exact origin %s', (WEB_ORIGIN) => {
    expect(() => validateRuntimeConfig({ ...production, WEB_ORIGIN })).toThrow(
      'WEB_ORIGIN',
    );
  });

  it.each([
    undefined,
    '',
    'sqlite://database/file',
    'postgresql://database',
    'postgresql:///eduvibe',
    'postgresql://database/eduvibe#fragment',
    ' postgres://database/eduvibe',
  ])('rejects invalid database URLs without logging them', (DATABASE_URL) => {
    try {
      validateRuntimeConfig({ ...production, DATABASE_URL });
      throw new Error('validation unexpectedly succeeded');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeConfigError);
      expect((error as Error).message).toContain('DATABASE_URL');
      if (DATABASE_URL)
        expect((error as Error).message).not.toContain(DATABASE_URL);
    }
  });

  it('reports all missing settings using only safe field descriptions', () => {
    expect(() => validateRuntimeConfig({ NODE_ENV: 'production' })).toThrow(
      /RATE_LIMIT_SECRET.*WEB_ORIGIN.*DATABASE_URL.*RATE_LIMIT_IP_MODE/,
    );
  });

  it('fails before application bootstrap without exposing configuration values', () => {
    const secret = 'replace-with-this-unsafe-production-secret';
    const databasePassword = 'database-private-sentinel';
    const result = spawnSync(
      process.execPath,
      ['-r', require.resolve('ts-node/register'), join(__dirname, 'main.ts')],
      {
        env: {
          ...process.env,
          ...production,
          RATE_LIMIT_SECRET: secret,
          DATABASE_URL: `postgresql://user:${databasePassword}@database/eduvibe`,
        },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('RATE_LIMIT_SECRET');
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain(databasePassword);
    expect(result.stdout + result.stderr).not.toContain(
      'Starting Nest application',
    );
  }, 40000);

  it.each([
    undefined,
    '',
    '10.0.0.0/8',
    '*',
    '10.0.0.1,',
    '10.0.0.1,invalid',
    '0.0.0.0',
    '::',
    'fe80::1%eth0',
  ])('rejects invalid trusted proxies %s', (RATE_LIMIT_TRUSTED_PROXIES) => {
    expect(() =>
      validateRuntimeConfig({
        ...production,
        RATE_LIMIT_IP_MODE: 'forwarded',
        RATE_LIMIT_TRUSTED_PROXIES,
      }),
    ).toThrow('RATE_LIMIT_TRUSTED_PROXIES');
  });

  it('rejects implicit, unknown, and contradictory proxy policies', () => {
    for (const RATE_LIMIT_IP_MODE of [undefined, '', 'true', 'proxy']) {
      expect(() =>
        validateRuntimeConfig({ ...production, RATE_LIMIT_IP_MODE }),
      ).toThrow('RATE_LIMIT_IP_MODE');
    }
    for (const RATE_LIMIT_IP_MODE of ['direct', 'disabled']) {
      expect(() =>
        validateRuntimeConfig({
          ...production,
          RATE_LIMIT_IP_MODE,
          RATE_LIMIT_TRUSTED_PROXIES: '10.0.0.2',
        }),
      ).toThrow('RATE_LIMIT_TRUSTED_PROXIES');
    }
  });
});
