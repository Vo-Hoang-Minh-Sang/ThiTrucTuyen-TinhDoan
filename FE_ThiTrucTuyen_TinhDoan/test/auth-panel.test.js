import assert from 'node:assert/strict';
import { mkdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import React from 'react';
import { act, create } from 'react-test-renderer';

// Biên dịch JSX thành tệp tạm để kiểm tra biểu mẫu trong Node mà không mở trình duyệt.
const output = resolve('.test-build', `auth-panel-${randomUUID()}.mjs`);
await mkdir(resolve('.test-build'), { recursive: true });
await build({ entryPoints: ['src/auth/AuthPanel.jsx'], outfile: output, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external', define: { 'import.meta.env': '{}' } });
const { default: AuthPanel } = await import(pathToFileURL(output).href);
after(() => unlink(output));

// Thay fetch bằng phản hồi giả, ghi nhận dữ liệu gửi và hoàn trả môi trường sau mỗi test.
function mount(t, handler, props = {}) {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    const result = await handler(url, body);
    return new Response(JSON.stringify(result.payload), { status: result.status || 200, headers: { 'Content-Type': 'application/json' } });
  };
  let renderer;
  act(() => { renderer = create(React.createElement(AuthPanel, { units: [{ id: 1, ten: 'Đơn vị thử nghiệm' }], onAuthenticated: () => {}, ...props })); });
  t.after(() => { act(() => renderer.unmount()); globalThis.fetch = previousFetch; });
  const change = (name, value) => act(() => renderer.root.findAll(node => (node.type === 'input' || node.type === 'select') && node.props.name === name)[0].props.onChange({ target: { name, value } }));
  const button = text => renderer.root.findAllByType('button').find(node => node.children.join('') === text);
  return { renderer, calls, change, button, submit: () => act(async () => { await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); }) };
}

test('SMTP failure opens recoverable verification form and resend works without entering an OTP', async t => {
  const view = mount(t, async url => url.endsWith('/register')
    ? { status: 503, payload: { success: false, registrationPending: true, email: 'qa@example.com', message: 'Chưa thể gửi email OTP.' } }
    : { payload: { success: true, message: 'Đã gửi lại OTP.' } });
  act(() => view.button('Đăng ký tài khoản').props.onClick());
  view.change('hoten', 'Kiểm thử'); view.change('dienthoai', '0900000000'); view.change('email', 'qa@example.com'); view.change('donviID', '1'); view.change('password', 'test-pass-123');
  await view.submit();
  assert.equal(view.renderer.root.findByType('h2').children.join(''), 'Xác nhận email');
  assert.equal(view.renderer.root.findAllByType('input').find(input => input.props.name === 'identifier').props.value, 'qa@example.com');
  assert.equal(view.renderer.root.findAllByType('input').some(input => input.props.name === 'password'), false);
  await act(async () => { await view.button('Gửi lại OTP').props.onClick({ preventDefault() {} }); });
  assert.equal(view.calls[1].url, '/api/auth/resend-registration');
  assert.deepEqual(view.calls[1].body, { identifier: 'qa@example.com' });
});

test('login passes token/user to session management and accepts existing short passwords', async t => {
  let authenticated;
  const view = mount(t, async () => ({ payload: { success: true, token: 'token', user: { id: 1, hoten: 'Kiểm thử' } } }), { onAuthenticated: payload => { authenticated = payload; } });
  view.change('identifier', 'qa@example.com'); view.change('password', '123456');
  assert.equal(view.renderer.root.findAllByType('input').find(input => input.props.name === 'password').props.minLength, undefined);
  await view.submit();
  assert.equal(authenticated.token, 'token');
  assert.deepEqual(view.calls[0].body, { identifier: 'qa@example.com', password: '123456' });
});

test('reset flow resends to the same identifier and clears sensitive form fields afterwards', async t => {
  const view = mount(t, async () => ({ payload: { success: true, message: 'Thành công.' } }));
  act(() => view.button('Quên mật khẩu?').props.onClick());
  view.change('identifier', 'qa@example.com');
  await view.submit();
  assert.equal(view.renderer.root.findByType('h2').children.join(''), 'Đặt lại mật khẩu');
  await act(async () => { await view.button('Gửi lại OTP').props.onClick({ preventDefault() {} }); });
  assert.equal(view.calls[1].url, '/api/auth/request-password-reset');
  view.change('otp', '123456'); view.change('newPassword', 'new-pass-123');
  await view.submit();
  assert.equal(view.calls[2].url, '/api/auth/reset-password');
  assert.equal(view.renderer.root.findByType('h2').children.join(''), 'Đăng nhập');
  assert.equal(view.renderer.root.findAllByType('input').find(input => input.props.name === 'password').props.value, '');
});

test('registration cannot be submitted when no units have been loaded', t => {
  const view = mount(t, async () => { throw new Error('No request expected'); }, { units: [], unitsError: 'Không tải được đơn vị.' });
  act(() => view.button('Đăng ký tài khoản').props.onClick());
  assert.equal(view.renderer.root.findAllByType('button').find(button => button.props.type === 'submit').props.disabled, true);
  assert.equal(view.calls.length, 0);
});
