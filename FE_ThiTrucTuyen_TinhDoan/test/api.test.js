import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../src/shared/api.js';

// Giả lập fetch và thời gian để kiểm tra lỗi API mà không gọi máy chủ thật.
test('API preserves pending-registration metadata on SMTP failure', async t => {
  const payload = { success: false, message: 'Email unavailable', code: 'OTP_DELIVERY_FAILED', registrationPending: true };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    return { ok: false, status: 503, json: async () => payload };
  });
  await assert.rejects(api('/auth/register', { body: { email: 'test@example.com' } }), error => error.status === 503 && error.payload.registrationPending === true);
});

test('caller cancellation while reading response body remains AbortError', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => { controller.abort(); throw new DOMException('cancelled', 'AbortError'); } }));
  await assert.rejects(api('/auth/me', { signal: controller.signal }), { name: 'AbortError' });
});

test('slow response body times out after 30 seconds with the timeout message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({ ok: true, status: 200, json: () => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true }); }) }));
  const request = api('/auth/register', { body: {} });
  const result = assert.rejects(request, /quá thời gian chờ/);
  await Promise.resolve();
  t.mock.timers.tick(30000);
  await result;
});
