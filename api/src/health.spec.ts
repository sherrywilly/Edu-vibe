import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Server } from 'node:http';
import request from 'supertest';
import { HealthModule } from './health.module';
import { HealthProbe } from './health-probe';
import { HealthService } from './health.service';

const query = jest.fn<Promise<unknown>, [TemplateStringsArray]>();
const disconnect = jest.fn().mockResolvedValue(undefined);
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRaw: query,
    $disconnect: disconnect,
  })),
}));

describe('API readiness', () => {
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    expect(disconnect).toHaveBeenCalled();
  });

  it('returns success only after a real query succeeds', async () => {
    query.mockResolvedValue([{ '?column?': 1 }]);
    await request(app.getHttpServer() as Server)
      .get('/api/ready')
      .expect(200, { status: 'ok' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0][0]).toBe('SELECT 1');
  });

  it('returns a sanitized failure when the database rejects', async () => {
    query.mockRejectedValue(new Error('secret database URL'));
    const response = await request(app.getHttpServer() as Server)
      .get('/api/ready')
      .expect(503);
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('fails closed within the timeout when the query hangs', async () => {
    jest.useFakeTimers();
    query.mockImplementation(() => new Promise(() => {}));
    const pending = app.get(HealthService).ready();
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toBe(false);
    jest.useRealTimers();
  });
});

describe('bounded probe', () => {
  it('times out, shares a stuck request, and retries after it settles', async () => {
    jest.useFakeTimers();
    let finish!: (value: boolean) => void;
    const check = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(true);
    const probe = new HealthProbe(check, 25);
    const first = probe.run();
    const second = probe.run();
    await jest.advanceTimersByTimeAsync(25);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    finish(true);
    await jest.advanceTimersByTimeAsync(0);
    await expect(probe.run()).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});
