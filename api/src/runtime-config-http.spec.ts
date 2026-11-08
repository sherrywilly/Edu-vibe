import express from 'express';
import request from 'supertest';
import { securityHeaders } from './runtime-config-http';

describe('securityHeaders', () => {
  const app = express();
  app.use(securityHeaders);
  app.get('/data', (_req, res) => res.json({ ok: true }));
  app.get('/download', (_req, res) =>
    res.set('Cache-Control', 'private, no-store').send('download'),
  );

  it.each(['/data', '/missing'])(
    'sets no-store, nosniff, and frame denial for %s',
    async (path) => {
      const response = await request(app).get(path);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
    },
  );

  it('preserves a route’s stricter no-store policy', async () => {
    const response = await request(app).get('/download');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });
});
