import request from 'supertest';
import { ExamDeadlineWorker } from './exam-deadline.worker';
import { ExamService } from './exam.service';
import { createWorkerHealthServer } from './health-worker-server';

const workerEvents: Record<string, () => void> = {};
const queueEvents: Record<string, () => void> = {};
const write = jest.fn();
const redis = { status: 'ready', set: write };
const running = jest.fn();
const paused = jest.fn();
jest.mock('bullmq', () => ({
  ...jest.requireActual<typeof import('bullmq')>('bullmq'),
  Queue: jest.fn().mockImplementation(() => ({
    getBackend: () => ({ client: Promise.resolve(redis) }),
    toKey: (name: string) => `bull:exam-deadlines:${name}`,
    on: (name: string, handler: () => void) => {
      queueEvents[name] = handler;
    },
    close: jest.fn().mockResolvedValue(undefined),
    add: jest.fn().mockResolvedValue(undefined),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: (name: string, handler: () => void) => {
      workerEvents[name] = handler;
    },
    getBackend: () => ({
      client: Promise.resolve(redis),
      blockingClient: Promise.resolve(redis),
    }),
    isRunning: running,
    isPaused: paused,
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('worker health', () => {
  let worker: ExamDeadlineWorker;
  let service: {
    pendingDeadlines: jest.Mock;
    sweep: jest.Mock;
    onModuleDestroy: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    redis.status = 'ready';
    write.mockResolvedValue('OK');
    running.mockReturnValue(true);
    paused.mockReturnValue(false);
    service = {
      pendingDeadlines: jest.fn().mockResolvedValue([]),
      sweep: jest.fn().mockResolvedValue(undefined),
      onModuleDestroy: jest.fn().mockResolvedValue(undefined),
    };
    worker = new ExamDeadlineWorker(
      service as unknown as ExamService,
      'redis://localhost',
    );
  });

  afterEach(async () => {
    await worker.close();
    jest.useRealTimers();
  });

  it('requires startup, database access, a running worker, and Redis commands', async () => {
    expect(await worker.health()).toEqual({ database: false, redis: false });
    workerEvents.ready();
    worker.start();
    await new Promise((resolve) => setImmediate(resolve));
    const server = createWorkerHealthServer(worker);
    await request(server)
      .get('/health')
      .expect(200, { status: 'ok', database: true, redis: true });
    expect(write).toHaveBeenCalledWith(
      'bull:exam-deadlines:health-check:queue',
      '1',
      { EX: 10 },
    );
    expect(write).toHaveBeenCalledWith(
      'bull:exam-deadlines:health-check:worker',
      '1',
      { EX: 10 },
    );
    await request(server).get('/other').expect(404);
    write.mockRejectedValueOnce(new Error('READONLY redis password'));
    const failure = await request(server).get('/health').expect(503);
    expect(failure.body).toEqual({
      status: 'unavailable',
      database: true,
      redis: false,
    });
    expect(JSON.stringify(failure.body)).not.toContain('password');
    redis.status = 'close';
    workerEvents['ioredis:close']();
    expect((await worker.health()).redis).toBe(false);
    redis.status = 'ready';
    write.mockResolvedValue('OK');
    expect((await worker.health()).redis).toBe(true);
  });

  it('reports database failure and stale stalled reconciliation', async () => {
    jest.useFakeTimers();
    workerEvents.ready();
    worker.start();
    await jest.advanceTimersByTimeAsync(0);
    expect((await worker.health()).database).toBe(true);
    service.pendingDeadlines.mockRejectedValueOnce(
      new Error('database secret'),
    );
    await jest.advanceTimersByTimeAsync(30_000);
    expect((await worker.health()).database).toBe(false);
    service.pendingDeadlines.mockResolvedValueOnce([]);
    await jest.advanceTimersByTimeAsync(30_000);
    expect((await worker.health()).database).toBe(true);
    let release!: (value: never[]) => void;
    service.pendingDeadlines.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await jest.advanceTimersByTimeAsync(90_000);
    expect((await worker.health()).database).toBe(false);
    release([]);
  });

  it('fails closed when the worker is stopped or Redis is not ready', async () => {
    workerEvents.ready();
    worker.start();
    await new Promise((resolve) => setImmediate(resolve));
    running.mockReturnValue(false);
    expect((await worker.health()).redis).toBe(false);
    running.mockReturnValue(true);
    paused.mockReturnValue(true);
    expect((await worker.health()).redis).toBe(false);
    paused.mockReturnValue(false);
    redis.status = 'reconnecting';
    expect((await worker.health()).redis).toBe(false);
    workerEvents.error();
    redis.status = 'close';
    expect((await worker.health()).redis).toBe(false);
  });

  it('bounds stalled writes even when another write fails', async () => {
    jest.useFakeTimers();
    write
      .mockRejectedValueOnce(new Error('READONLY'))
      .mockImplementation(() => new Promise(() => {}));
    worker.start();
    await jest.advanceTimersByTimeAsync(0);
    const first = worker.health();
    const second = worker.health();
    await jest.advanceTimersByTimeAsync(2_000);
    expect((await first).redis).toBe(false);
    expect((await second).redis).toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
    const third = worker.health();
    await jest.advanceTimersByTimeAsync(2_000);
    expect((await third).redis).toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
