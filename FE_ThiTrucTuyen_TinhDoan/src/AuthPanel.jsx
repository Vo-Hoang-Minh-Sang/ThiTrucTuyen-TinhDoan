import { useState } from 'react';
import { api } from './api';

const initialForm = { hoten: '', dienthoai: '', email: '', donviID: '', identifier: '', password: '' };
const titles = { login: 'Đăng nhập', register: 'Đăng ký tài khoản', forgot: 'Quên mật khẩu' };

// OTP đang tắt: đăng ký kích hoạt ngay, khôi phục mật khẩu qua yêu cầu hỗ trợ quản trị viên.
export default function AuthPanel({ units = [], unitsError, onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [loading, setLoading] = useState(false);
  const update = event => setForm(current => ({ ...current, [event.target.name]: event.target.value }));
  function changeMode(next) { setMode(next); setMessage(''); setIsError(false); setForm(current => ({ ...current, password: '' })); }
  async function submit(event) {
    event.preventDefault();
    if (loading || (mode === 'register' && !units.length)) return;
    setLoading(true); setMessage(''); setIsError(false);
    const routes = {
      login: ['/auth/login', { identifier: form.identifier, password: form.password }],
      register: ['/auth/register', { hoten: form.hoten, dienthoai: form.dienthoai, email: form.email, donviID: form.donviID, password: form.password }],
      forgot: ['/auth/request-password-reset', { identifier: form.identifier }]
    };
    try {
      const [path, body] = routes[mode];
      const payload = await api(path, { body });
      setMessage(payload.message || (mode === 'register' ? 'Đăng ký thành công. Bạn có thể đăng nhập.' : 'Đã ghi nhận yêu cầu. Vui lòng liên hệ ban tổ chức để được hỗ trợ.'));
      if (mode === 'login') onAuthenticated(payload);
      if (mode === 'register') { setMode('login'); setForm(current => ({ ...initialForm, identifier: current.dienthoai })); }
    } catch (error) { setMessage(error.message); setIsError(true); }
    finally { setLoading(false); }
  }
  return <section className="login-card auth-panel" aria-labelledby="auth-title">
    <h2 id="auth-title">{titles[mode]}</h2>
    {mode === 'register' && <p className="section-note">Đăng ký dành cho thí sinh. Tài khoản giảng viên do quản trị viên cấp.</p>}
    {mode === 'forgot' && <p className="section-note">Gửi yêu cầu hỗ trợ và liên hệ ban tổ chức để xác minh danh tính, nhận mật khẩu tạm thời.</p>}
    <form onSubmit={submit}><fieldset disabled={loading}>
      {mode === 'register' && <>
        <label>Họ và tên<input name="hoten" value={form.hoten} onChange={update} autoComplete="name" maxLength={255} required /></label>
        <label>Số điện thoại<input name="dienthoai" type="tel" value={form.dienthoai} onChange={update} autoComplete="tel" maxLength={30} required /></label>
        <label>Email<input name="email" type="email" value={form.email} onChange={update} autoComplete="email" maxLength={255} required /></label>
        <label>Đơn vị<select name="donviID" value={form.donviID} onChange={update} required><option value="">Chọn đơn vị</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.ten}</option>)}</select></label>
        {!units.length && <p className="form-note">{unitsError || 'Chưa có đơn vị đăng ký. Vui lòng liên hệ ban tổ chức.'}</p>}
      </>}
      {mode !== 'register' && <label>Số điện thoại hoặc email<input name="identifier" value={form.identifier} onChange={update} autoComplete="username" maxLength={255} required /></label>}
      {mode !== 'forgot' && <label>Mật khẩu<input name="password" type="password" value={form.password} onChange={update} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 8 : undefined} required /></label>}
      {mode === 'register' && <p className="form-note">Mật khẩu tối thiểu 8 ký tự, tối đa 72 byte UTF-8.</p>}
      <button type="submit" disabled={mode === 'register' && !units.length}>{loading ? 'Đang xử lý…' : mode === 'forgot' ? 'Gửi yêu cầu hỗ trợ' : titles[mode]}</button>
    </fieldset></form>
    {message && <p className={`auth-message ${isError ? 'error-message' : ''}`} role={isError ? 'alert' : 'status'}>{message}</p>}
    <div className="login-links">{mode === 'login' ? <><button disabled={loading} onClick={() => changeMode('register')}>Đăng ký tài khoản</button><button disabled={loading} onClick={() => changeMode('forgot')}>Quên mật khẩu?</button></> : <button disabled={loading} onClick={() => changeMode('login')}>Quay lại đăng nhập</button>}</div>
  </section>;
}

export function PasswordForm({ token, required = false, onChanged }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (form.newPassword !== form.confirm) { setMessage('Mật khẩu xác nhận chưa khớp.'); return; }
    setBusy(true); setMessage('');
    try {
      const payload = await api('/auth/change-password', { token, body: { currentPassword: form.currentPassword, newPassword: form.newPassword } });
      setForm({ currentPassword: '', newPassword: '', confirm: '' }); onChanged(payload);
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  return <section className="login-card auth-panel"><h2>Đổi mật khẩu</h2>{required && <p>Bạn cần đổi mật khẩu tạm thời trước khi tiếp tục sử dụng tài khoản.</p>}
    <form onSubmit={submit}><fieldset disabled={busy}>{[['currentPassword', 'Mật khẩu hiện tại'], ['newPassword', 'Mật khẩu mới'], ['confirm', 'Nhập lại mật khẩu mới']].map(([key, label]) => <label key={key}>{label}<input name={key} type="password" autoComplete={key === 'currentPassword' ? 'current-password' : 'new-password'} value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} minLength={key === 'currentPassword' ? undefined : 8} required /></label>)}<p className="form-note">Tối thiểu 8 ký tự, tối đa 72 byte UTF-8. Các phiên đăng nhập cũ sẽ được thu hồi.</p><button>{busy ? 'Đang lưu…' : 'Lưu mật khẩu mới'}</button></fieldset></form>
    {message && <p role="alert" className="error-message notice">{message}</p>}
  </section>;
}
