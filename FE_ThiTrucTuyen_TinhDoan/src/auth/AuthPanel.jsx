import { useState } from 'react';
import { api } from '../shared/api';

const initialForm = { hoten: '', chucVu: 'Đoàn viên', dienthoai: '', email: '', donviID: '', identifier: '', password: '', otp: '', newPassword: '', confirmPassword: '' };
const titles = { login: '\u0110\u0103ng nh\u1eadp', register: '\u0110\u0103ng k\u00fd t\u00e0i kho\u1ea3n', forgot: 'Qu\u00ean m\u1eadt kh\u1ea9u', verify: 'X\u00e1c nh\u1eadn email', reset: '\u0110\u1eb7t l\u1ea1i m\u1eadt kh\u1ea9u' };

// C\u00e1c chu\u1ed7i hi\u1ec3n th\u1ecb d\u00f9ng Unicode escape \u0111\u1ec3 kh\u00f4ng b\u1ecb l\u1ed7i m\u00e3 h\u00f3a tr\u00ean m\u00f4i tr\u01b0\u1eddng Windows.
export default function AuthPanel({ units = [], unitsError, onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [loading, setLoading] = useState(false);
  const update = event => setForm(current => ({ ...current, [event.target.name]: event.target.value }));
  const changeMode = next => { setMode(next); setMessage(''); setIsError(false); setForm(initialForm); };
  async function submit(event) {
    event.preventDefault();
    if (loading || (mode === 'register' && !units.length)) return;
    if (mode === 'reset' && form.newPassword !== form.confirmPassword) { setMessage('\u004d\u1eadt kh\u1ea9u x\u00e1c nh\u1eadn ch\u01b0a kh\u1edbp.'); setIsError(true); return; }
    setLoading(true); setMessage(''); setIsError(false);
    const routes = {
      login: ['/auth/login', { identifier: form.identifier, password: form.password }],
      register: ['/auth/register', { hoten: form.hoten, chucVu: form.chucVu, dienthoai: form.dienthoai, email: form.email, donviID: form.donviID, password: form.password }],
      forgot: ['/auth/request-password-reset', { identifier: form.identifier }],
      verify: ['/auth/verify-registration', { identifier: form.identifier, otp: form.otp }],
      reset: ['/auth/reset-password', { identifier: form.identifier, otp: form.otp, newPassword: form.newPassword }]
    };
    try {
      const [path, body] = routes[mode]; const payload = await api(path, { body });
      setMessage(payload.message || 'Thao t\u00e1c th\u00e0nh c\u00f4ng.');
      if (mode === 'login') onAuthenticated(payload);
      if (mode === 'register' && payload.registrationPending) { setMode('verify'); setForm({ ...initialForm, identifier: form.email }); }
      else if (mode === 'register') { setMode('login'); setForm({ ...initialForm, identifier: form.dienthoai }); }
      else if (mode === 'forgot' && payload.otpRequired !== false) setMode('reset');
      else if (mode === 'verify' || mode === 'reset') { setMode('login'); setForm({ ...initialForm, identifier: form.identifier }); }
    } catch (error) {
      if (mode === 'register' && error.payload?.registrationPending) { setMode('verify'); setForm({ ...initialForm, identifier: error.payload.email || form.email }); }
      setMessage(error.message); setIsError(true);
    } finally { setLoading(false); }
  }
  const resend = async () => {
    const path = mode === 'verify' ? '/auth/resend-registration' : '/auth/request-password-reset';
    setLoading(true);
    try { const payload = await api(path, { body: { identifier: form.identifier } }); setMessage(payload.message); setIsError(false); }
    catch (error) { setMessage(error.message); setIsError(true); }
    finally { setLoading(false); }
  };
  return <section className="login-card auth-panel" aria-labelledby="auth-title">
    <h2 id="auth-title">{titles[mode]}</h2>
    {mode === 'register' && <p className="section-note">{'\u0110\u0103ng k\u00fd d\u00e0nh cho th\u00ed sinh. T\u00e0i kho\u1ea3n gi\u1ea3ng vi\u00ean do qu\u1ea3n tr\u1ecb vi\u00ean c\u1ea5p.'}</p>}
    {mode === 'forgot' && <p className="section-note">{'Nh\u1eadp email \u0111\u00e3 \u0111\u0103ng k\u00fd. H\u1ec7 th\u1ed1ng s\u1ebd g\u1eedi m\u00e3 OTP \u0111\u1ec3 b\u1ea1n \u0111\u1eb7t m\u1eadt kh\u1ea9u m\u1edbi.'}</p>}
    {['verify', 'reset'].includes(mode) && <p className="section-note">{'M\u00e3 OTP g\u1ed3m 6 ch\u1eef s\u1ed1, \u0111\u00e3 \u0111\u01b0\u1ee3c g\u1eedi t\u1edbi email c\u1ee7a b\u1ea1n.'}</p>}
    <form onSubmit={submit}><fieldset disabled={loading}>
      {mode === 'register' && <>
        <label>{'H\u1ecd v\u00e0 t\u00ean'}<input name="hoten" value={form.hoten} onChange={update} autoComplete="name" maxLength={255} required /></label>
        <label>{'Ch\u1ee9c v\u1ee5'}<input name="chucVu" value={form.chucVu} onChange={update} placeholder={'V\u00ed d\u1ee5: B\u00ed th\u01b0 Chi \u0111o\u00e0n'} maxLength={100} required /></label>
        <label>{'S\u1ed1 \u0111i\u1ec7n tho\u1ea1i'}<input name="dienthoai" type="tel" value={form.dienthoai} onChange={update} autoComplete="tel" maxLength={30} required /></label>
        <label>Email<input name="email" type="email" value={form.email} onChange={update} autoComplete="email" maxLength={255} required /></label>
        <label>{'\u0110\u01a1n v\u1ecb'}<select name="donviID" value={form.donviID} onChange={update} required><option value="">{'Ch\u1ecdn \u0111\u01a1n v\u1ecb'}</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.ten}</option>)}</select></label>
        {!units.length && <p className="form-note">{unitsError || '\u0043h\u01b0a c\u00f3 \u0111\u01a1n v\u1ecb \u0111\u0103ng k\u00fd. Vui l\u00f2ng li\u00ean h\u1ec7 ban t\u1ed5 ch\u1ee9c.'}</p>}
      </>}
      {mode === 'login' && <input aria-label={'S\u1ed1 \u0111i\u1ec7n tho\u1ea1i ho\u1eb7c email'} name="identifier" placeholder={'S\u1ed1 \u0111i\u1ec7n tho\u1ea1i ho\u1eb7c email'} value={form.identifier} onChange={update} autoComplete="username" maxLength={255} required />}
      {mode === 'forgot' && <label>Email<input name="identifier" type="email" placeholder="email@example.com" value={form.identifier} onChange={update} autoComplete="email" maxLength={255} required /></label>}
      {['verify', 'reset'].includes(mode) && <label>Email<input value={form.identifier} type="email" autoComplete="email" readOnly /></label>}
      {mode === 'verify' && <label>{'M\u00e3 OTP'}<input name="otp" inputMode="numeric" pattern="[0-9]{6}" value={form.otp} onChange={update} maxLength={6} required /></label>}
      {mode === 'reset' && <><label>{'M\u00e3 OTP'}<input name="otp" inputMode="numeric" pattern="[0-9]{6}" value={form.otp} onChange={update} maxLength={6} required /></label><label>{'M\u1eadt kh\u1ea9u m\u1edbi'}<input name="newPassword" type="password" value={form.newPassword} onChange={update} autoComplete="new-password" minLength={8} required /></label><label>{'Nh\u1eadp l\u1ea1i m\u1eadt kh\u1ea9u m\u1edbi'}<input name="confirmPassword" type="password" value={form.confirmPassword} onChange={update} autoComplete="new-password" minLength={8} required /></label></>}
      {mode !== 'forgot' && !['verify', 'reset'].includes(mode) && (mode === 'login' ? <input aria-label={'M\u1eadt kh\u1ea9u'} name="password" type="password" placeholder={'M\u1eadt kh\u1ea9u'} value={form.password} onChange={update} autoComplete="current-password" required /> : <label>{'M\u1eadt kh\u1ea9u'}<input name="password" type="password" value={form.password} onChange={update} autoComplete="new-password" minLength={8} required /></label>)}
      {['register', 'reset'].includes(mode) && <p className="form-note">{'M\u1eadt kh\u1ea9u t\u1ed1i thi\u1ec3u 8 k\u00fd t\u1ef1, t\u1ed1i \u0111a 72 byte UTF-8.'}</p>}
      <button type="submit" disabled={mode === 'register' && !units.length}>{loading ? '\u0110ang x\u1eed l\u00fd\u2026' : mode === 'forgot' ? 'G\u1eedi m\u00e3 OTP' : mode === 'verify' ? 'X\u00e1c nh\u1eadn t\u00e0i kho\u1ea3n' : mode === 'reset' ? '\u0110\u1eb7t l\u1ea1i m\u1eadt kh\u1ea9u' : titles[mode]}</button>
    </fieldset></form>
    {message && <p className={`auth-message ${isError ? 'error-message' : ''}`} role={isError ? 'alert' : 'status'}>{message}</p>}
    <div className="login-links">{mode === 'login' ? <><button disabled={loading} onClick={() => changeMode('register')}>{'\u0110\u0103ng k\u00fd t\u00e0i kho\u1ea3n'}</button><button disabled={loading} onClick={() => changeMode('forgot')}>{'Qu\u00ean m\u1eadt kh\u1ea9u?'}</button></> : <>{['verify', 'reset'].includes(mode) && <button disabled={loading} onClick={resend}>{'G\u1eedi l\u1ea1i OTP'}</button>}<button disabled={loading} onClick={() => changeMode('login')}>{'Quay l\u1ea1i \u0111\u0103ng nh\u1eadp'}</button></>}</div>
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
