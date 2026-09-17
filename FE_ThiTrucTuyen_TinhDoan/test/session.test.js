import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import useSession, { tokenExpiresAt } from '../src/auth/useSession.js';
import { TOKEN_KEY } from '../src/shared/api.js';

// Token giả chỉ phục vụ kiểm tra giao diện; không phải JWT có chữ ký hợp lệ để gọi backend.
const tokenFor = (name, expires = Math.floor(Date.now() / 1000) + 3600) => `header.${Buffer.from(JSON.stringify({ sub: name, exp: expires })).toString('base64url')}.signature`;
const response = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
const userResponse = name => response({ success: true, user: { id: name, hoten: name } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const cleanups = new WeakMap();
function cleanup(t, callback) {
  if (!cleanups.has(t)) {
    cleanups.set(t, []);
    t.after(() => { for (const dispose of cleanups.get(t).reverse()) dispose(); });
  }
  cleanups.get(t).push(callback);
}

// Mô phỏng localStorage và sự kiện trình duyệt trong Node, rồi hoàn trả môi trường sau test.
function environment(t, initialToken) {
  const values = new Map(initialToken ? [[TOKEN_KEY, initialToken]] : []);
  const localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  for (const [key, value] of Object.entries({ localStorage, window, document })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    cleanup(t, () => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  return {
    localStorage, window, document,
    changeToken(next) {
      if (next) localStorage.setItem(TOKEN_KEY, next); else localStorage.removeItem(TOKEN_KEY);
      window.dispatchEvent(Object.assign(new Event('storage'), { key: TOKEN_KEY, newValue: next }));
    }
  };
}

// Gắn hook vào thành phần thử nghiệm để quan sát thay đổi phiên sau mỗi thao tác bất đồng bộ.
async function mount(t) {
  let session;
  let renderer;
  function Harness() { session = useSession(); return null; }
  await act(async () => { renderer = create(React.createElement(Harness)); });
  cleanup(t, () => { act(() => renderer.unmount()); });
  return { get current() { return session; } };
}

test('JWT decoding accepts numeric expiration and rejects malformed metadata', () => {
  assert.equal(tokenExpiresAt(tokenFor('one', 1700000000)), 1700000000000);
  for (const value of [null, '', 'garbage', 'one.bad.three', tokenFor('one', '1700000000')]) assert.equal(tokenExpiresAt(value), null);
});

test('a mounted session expires automatically without a reload', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1700000000000 });
  const token = tokenFor('one', 1700000005);
  const env = environment(t, token);
  t.mock.method(globalThis, 'fetch', async () => userResponse('one'));
  const session = await mount(t);
  assert.equal(session.current.user.hoten, 'one');
  await act(async () => { t.mock.timers.tick(5000); });
  assert.equal(session.current.token, null);
  assert.equal(session.current.user, null);
  assert.equal(env.localStorage.getItem(TOKEN_KEY), null);
  assert.match(session.current.error, /hết hạn/);
  assert.equal(session.current.loading, false);
});

test('returning focus revalidates and clears a session revoked on the server', async t => {
  const env = environment(t, tokenFor('one'));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? userResponse('one') : response({ success: false, message: 'revoked' }, 401));
  const session = await mount(t);
  assert.equal(session.current.user.hoten, 'one');
  await act(async () => { env.window.dispatchEvent(new Event('focus')); });
  assert.equal(calls, 2);
  assert.equal(session.current.token, null);
  assert.equal(session.current.user, null);
});

test('a delayed logout response does not erase a newer login from another tab', async t => {
  const older = tokenFor('older');
  const newer = tokenFor('newer');
  const env = environment(t, older);
  const pendingLogout = deferred();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/logout')) return pendingLogout.promise;
    return userResponse(options.headers.Authorization.endsWith(newer) ? 'newer' : 'older');
  });
  const session = await mount(t);
  let logout;
  act(() => { logout = session.current.logout(); });
  assert.equal(session.current.loading, true);
  await act(async () => { env.changeToken(newer); });
  assert.equal(session.current.user.hoten, 'newer');
  await act(async () => { pendingLogout.resolve(response({ success: true })); await logout; });
  assert.equal(env.localStorage.getItem(TOKEN_KEY), newer);
  assert.equal(session.current.token, newer);
  assert.equal(session.current.user.hoten, 'newer');
  assert.equal(session.current.loading, false);
});

test('a stale profile response cannot replace the user of a newer token', async t => {
  const older = tokenFor('older');
  const newer = tokenFor('newer');
  const env = environment(t, older);
  const pendingProfile = deferred();
  t.mock.method(globalThis, 'fetch', async (_url, options) => options.headers.Authorization.endsWith(older) ? pendingProfile.promise : userResponse('newer'));
  const session = await mount(t);
  assert.equal(session.current.loading, true);
  await act(async () => { env.changeToken(newer); });
  await act(async () => { pendingProfile.resolve(userResponse('older')); });
  assert.equal(session.current.token, newer);
  assert.equal(session.current.user.hoten, 'newer');
  assert.equal(session.current.loading, false);
});
