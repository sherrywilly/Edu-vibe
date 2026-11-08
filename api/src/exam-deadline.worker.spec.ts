import { DelayedError } from 'bullmq';
import { ExamDeadlineWorker } from './exam-deadline.worker';
import { ExamService } from './exam.service';

const add = jest.fn();
const queueClose = jest.fn();
const workerClose = jest.fn();
jest.mock('bullmq', () => {
  const actual = jest.requireActual('bullmq');
  return {
    ...actual,
    Queue: jest
      .fn()
      .mockImplementation(() => ({ add, close: queueClose, on: jest.fn() })),
    Worker: jest
      .fn()
      .mockImplementation(() => ({ close: workerClose, on: jest.fn() })),
  };
});

describe('exam deadline worker', () => {
  let service: {
    finalizeDue: jest.Mock;
    sweep: jest.Mock;
    pendingDeadlines: jest.Mock;
    onModuleDestroy: jest.Mock;
  };
  let worker: ExamDeadlineWorker;

  beforeEach(() => {
    jest.clearAllMocks();
    service = {
      finalizeDue: jest.fn(),
      sweep: jest.fn().mockResolvedValue(undefined),
      pendingDeadlines: jest.fn().mockResolvedValue([]),
      onModuleDestroy: jest.fn(),
    };
    worker = new ExamDeadlineWorker(
      service as unknown as ExamService,
      'redis://localhost:6379',
    );
  });

  it('reconciles all pages with stable delayed jobs', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({
      id: `attempt-${i}`,
      remainingMs: i,
    }));
    service.pendingDeadlines
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([{ id: 'last', remainingMs: 42 }]);
    await worker.reconcile();
    expect(service.pendingDeadlines).toHaveBeenNthCalledWith(2, 'attempt-99');
    expect(add).toHaveBeenCalledTimes(101);
    expect(add).toHaveBeenLastCalledWith(
      'finalize',
      { attemptId: 'last' },
      { jobId: 'last', delay: 42 },
    );
  });

  it('checks service timing and delays an early job without treating it as failed', async () => {
    service.finalizeDue.mockResolvedValue({ remainingMs: 3000 });
    const moveToDelayed = jest.fn();
    const before = Date.now();
    await expect(
      worker.process(
        { data: { attemptId: 'id' }, moveToDelayed } as never,
        'lock',
      ),
    ).rejects.toBeInstanceOf(DelayedError);
    expect(service.finalizeDue).toHaveBeenCalledWith('id');
    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'lock');
    expect(moveToDelayed.mock.calls[0][0]).toBeGreaterThanOrEqual(
      before + 3000,
    );
    service.finalizeDue.mockResolvedValue(null);
    await expect(
      worker.process({ data: { attemptId: 'id' } } as never, 'lock'),
    ).resolves.toBeUndefined();
  });

  it('continues recovery when Redis is unavailable and closes resources', async () => {
    service.pendingDeadlines.mockResolvedValue([{ id: 'id', remainingMs: 0 }]);
    add.mockRejectedValueOnce(new Error('redis unavailable'));
    worker.start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.sweep).toHaveBeenCalled();
    await worker.close();
    expect(queueClose).toHaveBeenCalled();
    expect(workerClose).toHaveBeenCalled();
    expect(service.onModuleDestroy).toHaveBeenCalled();
  });

  it('propagates processing failures for BullMQ retries', async () => {
    service.finalizeDue.mockRejectedValue(new Error('database unavailable'));
    await expect(
      worker.process({ data: { attemptId: 'id' } } as never, 'lock'),
    ).rejects.toThrow('database unavailable');
  });

  it('keeps sweeping while a Redis enqueue is stalled', async () => {
    jest.useFakeTimers();
    let release!: () => void;
    add.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    service.pendingDeadlines.mockResolvedValue([{ id: 'id', remainingMs: 0 }]);
    worker.start();
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(service.sweep).toHaveBeenCalledTimes(2);
    release();
    await worker.close();
    jest.useRealTimers();
  });

  it('can shut down while a Redis enqueue never completes', async () => {
    add.mockImplementationOnce(() => new Promise(() => {}));
    service.pendingDeadlines.mockResolvedValue([{ id: 'id', remainingMs: 0 }]);
    worker.start();
    await new Promise((resolve) => setImmediate(resolve));
    await expect(worker.close()).resolves.toBeUndefined();
    expect(workerClose).toHaveBeenCalledWith(true);
  });
});
