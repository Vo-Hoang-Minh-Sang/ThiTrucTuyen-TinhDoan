import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AuthPanel, { PasswordForm } from './AuthPanel';
import CandidateWorkspace from './CandidateWorkspace';
import ManageWorkspace from './ManageWorkspace';
import Reports from './Reports';
import useSession from './useSession';
import { assetUrl } from './api';
import { DateFilters, Notice, ResourceState, Table, formatDate, roleNames, useResource } from './ui';
import './styles.css';

// Trang công khai dùng dữ liệu thật; dữ liệu tài khoản và đáp án nằm trong khu vực riêng.
function Countdown({ competition }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const start = competition?.startDate ? Date.parse(competition.startDate) : NaN;
  const end = competition?.endDate ? Date.parse(competition.endDate) : NaN;
  const target = Number.isFinite(start) && now < start ? start : end;
  const total = Number.isFinite(target) ? Math.max(0, target - now) : 0;
  const days = Math.floor(total / 86400000), hours = Math.floor(total / 3600000) % 24, minutes = Math.floor(total / 60000) % 60, seconds = Math.floor(total / 1000) % 60;
  return <div className="countdown-block"><div className="countdown-panel"><div><strong>{String(days).padStart(2, '0')}</strong><span>Ngày</span></div><div><strong>{String(hours).padStart(2, '0')}</strong><span>Giờ</span></div><div><strong>{String(minutes).padStart(2, '0')}</strong><span>Phút</span></div><div><strong>{String(seconds).padStart(2, '0')}</strong><span>Giây</span></div></div><a className="start-button" href="#auth-panel">▶ Vào thi ngay</a></div>;
}

function PublicHome({ refresh, site, units, onAuthenticated, showAuth }) {
  const exams = useResource('/exams', null, refresh);
  const dashboard = useResource('/dashboard', null, refresh);
  const [filters, setFilters] = useState({ q: '', from: '', to: '' });
  const items = exams.data?.data || [];
  const data = dashboard.data?.data || dashboard.data;
  const visible = items.filter(item => (!filters.q || item.title.toLocaleLowerCase('vi').includes(filters.q.toLocaleLowerCase('vi'))) && (!filters.from || Date.parse(item.endAt) >= Date.parse(`${filters.from}T00:00:00`)) && (!filters.to || Date.parse(item.startAt) <= Date.parse(`${filters.to}T23:59:59`)));
  return <>
    <section className="landing-grid"><Countdown competition={data?.competition} />{showAuth ? <AuthPanel units={units} onAuthenticated={onAuthenticated} /> : <div className="landing-message"><h3>{data?.competition?.name || 'Cuộc thi trực tuyến'}</h3><p>Đăng nhập để tham gia làm bài và xem kết quả cá nhân.</p></div>}</section>
    <section className="content-section" id="lich-thi"><h2>Lịch trình cuộc thi</h2><ResourceState resource={dashboard} empty={!data?.rounds?.length}><ol className="timeline">{data?.rounds?.map((round, index) => <li key={round.id}><span className="round-number">{round.roundNumber || index + 1}</span><div><h3>{round.name || `Vòng thi ${round.roundNumber || index + 1}`}</h3><p>{formatDate(round.startAt)} → {formatDate(round.endAt)}</p></div></li>)}</ol></ResourceState></section>
    <section className="content-section public-exams"><h2>Danh sách kỳ thi</h2><div className="form-grid filters"><label>Tên kỳ thi / đề thi<input value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} /></label><DateFilters value={filters} onChange={setFilters} /></div><ResourceState resource={exams} empty={!visible.length}><div className="exam-grid">{visible.map(item => <article className="exam-card" key={item.id}><span className="round-number">{item.id}</span><div><span className="exam-status">{item.status}</span><h3>{item.title}</h3><p>{item.description}</p><p>{item.questions} câu hỏi · {item.duration}</p><p>Bắt đầu: {formatDate(item.startAt)}</p><p>Kết thúc: {formatDate(item.endAt)}</p></div></article>)}</div></ResourceState></section>
    {!!data?.results?.length && <section className="content-section"><p className="eyebrow">KẾT QUẢ</p><h2>Kết quả mới công bố</h2><p className="section-note">Tối đa 100 kết quả mới nhất của {data.competition?.name || 'cuộc thi'}.</p><Table headings={['Họ và tên', 'Đơn vị', 'Điểm / 100', 'Hoàn thành']}>{data.results.map(item => <tr key={item.id}><td>{item.fullName}</td><td>{item.unitName || '—'}</td><td>{item.score}</td><td>{formatDate(item.finishedAt)}</td></tr>)}</Table></section>}
    <section className="content-section"><p className="eyebrow">THỐNG KÊ</p><h2>Thống kê cuộc thi</h2><ResourceState resource={dashboard}><div className="stat-cards"><div><strong>{Number(data?.statistics?.totalRegistrations || 0).toLocaleString('vi-VN')}</strong><span>Số lượng đăng ký</span></div><div><strong>{Number(data?.statistics?.totalTests || 0).toLocaleString('vi-VN')}</strong><span>Số lượt thi</span></div></div></ResourceState></section>
    {site?.newsUrl && <section className="content-section news-section"><p className="eyebrow">TIN TỨC</p><h2>Tin tức</h2><a className="document-link" href={assetUrl(site.newsUrl)} target="_blank" rel="noreferrer">{site.newsTitle || 'Xem tài liệu công bố'} ↗</a></section>}
  </>;
}

export function App() {
  const session = useSession();
  const [view, setView] = useState('home');
  const [menuOpen, setMenuOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState('');
  const site = useResource('/site', null, refresh);
  const units = useResource('/units', null, refresh);
  const health = useResource('/health', null, refresh);
  const data = site.data?.item;
  const user = session.user;
  const forced = Boolean(Number(user?.must_change_password));
  const allowedReports = user?.role === 'candidate' || user?.role === 'admin' || user?.permissions?.includes('reports');
  const changePassword = async () => { await session.logout(); setNotice('Đã đổi mật khẩu. Vui lòng đăng nhập lại bằng mật khẩu mới.'); setView('account'); };
  const authenticate = payload => { session.authenticate(payload); setNotice(''); setView(payload.user?.role === 'candidate' ? 'candidate' : 'manage'); };
  const logout = async () => { await session.logout(); setView('account'); setNotice(''); };
  const selected = !user && !['home', 'account'].includes(view) ? 'account' : view;
  return <main>
    <header className="site-header"><div className="container header-inner"><a className="site-brand" href="#trang-chu" onClick={() => { setView('home'); setMenuOpen(false); }}><span className="brand-mark" aria-hidden="true">✦</span>Thi trực tuyến</a><nav className={`site-nav${menuOpen ? ' is-open' : ''}`} aria-label="Điều hướng trang"><a href="#trang-chu" onClick={() => { setView('home'); setMenuOpen(false); }}>Trang chủ</a><a href="#lich-thi" onClick={() => setMenuOpen(false)}>Lịch thi</a><a href="#auth-panel" onClick={() => { setView('account'); setMenuOpen(false); }}>Đăng nhập</a></nav><span className="header-context">{user ? `${user.hoten} · ${roleNames[user.role] || 'Tài khoản'}` : ''}</span><button className="menu-toggle" aria-label="Mở menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}>☰</button></div></header>
    <div className="container page-content" id="trang-chu">
      <section className="banner-panel">{data?.bannerUrl ? <img className="site-banner" src={assetUrl(data.bannerUrl)} alt="Banner cuộc thi" /> : <div className="banner-copy"><p>TỈNH ĐOÀN VĨNH LONG</p><h1>{data?.title || 'Cổng thi trực tuyến'}</h1><p>{data?.description || 'Theo dõi lịch thi, tham gia làm bài và tra cứu kết quả.'}</p></div>}</section>
      <div className="data-status"><span role="status">{health.loading ? 'Đang kiểm tra kết nối…' : health.error ? 'Chưa kết nối được máy chủ' : 'Đã kết nối máy chủ'}</span><button className="secondary" onClick={() => { setRefresh(value => value + 1); session.retry(); }}>Tải lại dữ liệu</button></div>
      <nav className="tab-nav primary-tabs" aria-label="Điều hướng chính"><button className={selected === 'home' ? 'active' : ''} aria-pressed={selected === 'home'} onClick={() => setView('home')}>Trang chủ, lịch thi</button>{user && !forced && <>{user.role === 'candidate' ? <button className={selected === 'candidate' ? 'active' : ''} aria-pressed={selected === 'candidate'} onClick={() => setView('candidate')}>Làm bài, kết quả</button> : <button className={selected === 'manage' ? 'active' : ''} aria-pressed={selected === 'manage'} onClick={() => setView('manage')}>Quản lý</button>}{allowedReports && <button className={selected === 'reports' ? 'active' : ''} aria-pressed={selected === 'reports'} onClick={() => setView('reports')}>Thống kê</button>}</>}<button className={selected === 'account' ? 'active' : ''} aria-pressed={selected === 'account'} onClick={() => setView('account')}>Tài khoản</button>{user && <button className="logout-button" disabled={session.loading} onClick={logout}>Đăng xuất</button>}</nav>
      <Notice text={notice} /><Notice text={session.error} error /><Notice text={site.error} error />
      {forced ? <PasswordForm token={session.token} required onChanged={changePassword} /> : <>
        {selected === 'home' && <PublicHome refresh={refresh} site={data} units={units.data?.data || []} onAuthenticated={authenticate} showAuth={!user} />}
        {selected === 'account' && <div id="auth-panel">{user ? <><section className="login-card"><h2>Thông tin tài khoản</h2><p><strong>{user.hoten}</strong> · {roleNames[user.role]}</p><p>{user.dienthoai} · {user.email}</p><p>Đơn vị: {user.donvi?.ten || user.unitName || units.data?.data?.find(unit => String(unit.id) === String(user.donviID))?.ten || 'Chưa chọn đơn vị'}</p></section><PasswordForm token={session.token} onChanged={changePassword} /></> : session.loading ? <p className="empty-state" role="status">Đang kiểm tra phiên đăng nhập…</p> : session.token ? <section className="login-card"><p>Chưa thể xác minh phiên đăng nhập.</p><div className="actions"><button onClick={session.retry}>Thử lại</button><button className="secondary" onClick={logout}>Đăng xuất trên thiết bị này</button></div></section> : <AuthPanel units={units.data?.data || []} unitsError={units.error} onAuthenticated={authenticate} />}</div>}
        {user?.role === 'candidate' && <div hidden={selected !== 'candidate'}><CandidateWorkspace key={user.id} user={user} token={session.token} /></div>}
        {user && user.role !== 'candidate' && selected === 'manage' && <ManageWorkspace key={user.id} user={user} token={session.token} units={units.data?.data || []} onSiteChanged={() => setRefresh(value => value + 1)} />}
        {user && allowedReports && selected === 'reports' && <Reports token={session.token} role={user.role} />}
      </>}
    </div><footer><div className="container"><strong>Tỉnh Đoàn Vĩnh Long</strong><p>Cổng thông tin thi trực tuyến · © {new Date().getFullYear()}</p></div></footer>
  </main>;
}
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
