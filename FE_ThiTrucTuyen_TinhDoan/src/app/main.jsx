import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AuthPanel, { PasswordForm } from '../auth/AuthPanel';
import CandidateWorkspace from '../candidate/CandidateWorkspace';
import ManageWorkspace from '../management/ManageWorkspace';
import Reports from '../management/Reports';
import useSession from '../auth/useSession';
import { assetUrl } from '../shared/api';
import { Notice, ResourceState, Table, formatDate, roleNames, useResource } from '../shared/ui';
import '../shared/styles.css';

// Trang công khai dùng dữ liệu thật; dữ liệu tài khoản và đáp án nằm trong khu vực riêng.
function Countdown({ competition, onEnter }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const start = competition?.startDate ? Date.parse(competition.startDate) : NaN;
  const end = competition?.endDate ? Date.parse(competition.endDate) : NaN;
  const target = Number.isFinite(start) && now < start ? start : end;
  const total = Number.isFinite(target) ? Math.max(0, target - now) : 0;
  const days = Math.floor(total / 86400000), hours = Math.floor(total / 3600000) % 24, minutes = Math.floor(total / 60000) % 60, seconds = Math.floor(total / 1000) % 60;
  return <div className="countdown-block"><div className="countdown-panel"><div><strong>{String(days).padStart(2, '0')}</strong><span>Ngày</span></div><div><strong>{String(hours).padStart(2, '0')}</strong><span>Giờ</span></div><div><strong>{String(minutes).padStart(2, '0')}</strong><span>Phút</span></div><div><strong>{String(seconds).padStart(2, '0')}</strong><span>Giây</span></div></div><button type="button" className="start-button" onClick={onEnter}>▶ Vào thi ngay</button></div>;
}

function PublicHome({ refresh, site, units, onAuthenticated, showAuth, onEnter }) {
  const dashboard = useResource('/dashboard', null, refresh);
  const [bannerIndex, setBannerIndex] = useState(0);
  const [now, setNow] = useState(Date.now());
  // Cập nhật theo thời gian thực để lịch trình và thống kê đổi trạng thái khi kỳ thi mở hoặc kết thúc.
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const data = dashboard.data?.data || dashboard.data;
  const competitionStart = Date.parse(data?.competition?.startDate);
  const competitionEnd = Date.parse(data?.competition?.endDate);
  const hasActiveCompetition = Number.isFinite(competitionStart) && Number.isFinite(competitionEnd) && now >= competitionStart && now < competitionEnd;
  // Kỳ thi ghim được phép công bố lịch và số liệu sau khi đã kết thúc.
  const showCompetitionInformation = hasActiveCompetition || Boolean(data?.competition?.pinned);
  const banners = site?.banners?.length ? site.banners : site?.bannerUrl ? [{ url: site.bannerUrl, title: site.title }] : [];
  const news = site?.news?.length ? site.news : site?.newsUrl ? [{ url: site.newsUrl, title: site.newsTitle || 'Xem tài liệu công bố' }] : [];
  const banner = banners[bannerIndex % Math.max(1, banners.length)];
  return <>
    <section className="reference-hero" id="hero-section"><div className="reference-hero-grid"><div className="hero-media">{banner ? <img src={assetUrl(banner.url)} alt={banner.title || 'Banner cuộc thi'} /> : <div className="home-hero-copy"><p>TỈNH ĐOÀN</p><h1>{site?.title || 'Cổng thi trực tuyến'}</h1><p>{site?.description || 'Theo dõi lịch thi, tham gia làm bài và tra cứu kết quả.'}</p></div>}{banners.length > 1 && <div className="hero-dots">{banners.map((item, index) => <button key={item.url} aria-label={`Xem banner ${index + 1}`} aria-pressed={index === bannerIndex} className={index === bannerIndex ? 'active' : ''} onClick={() => setBannerIndex(index)} />)}</div>}</div><aside className="hero-side"><Countdown competition={data?.competition} onEnter={onEnter} />{showAuth ? <AuthPanel units={units} onAuthenticated={onAuthenticated} /> : <div className="landing-message logged-competition"><h3>{data?.competition?.name || 'Cuộc thi trực tuyến'}</h3></div>}</aside></div></section>
    <section className="content-section" id="lich-thi"><h2>Lịch trình cuộc thi</h2><ResourceState resource={dashboard}>{showCompetitionInformation ? data?.rounds?.length ? <ol className="timeline">{data.rounds.map((round, index) => <li key={round.id}><span className="round-number">{round.roundNumber || index + 1}</span><div><h3>{round.name || `Vòng thi ${round.roundNumber || index + 1}`}</h3><p>{formatDate(round.startAt)} → {formatDate(round.endAt)}</p></div></li>)}</ol> : <p className="empty-state">Chưa có lịch trình được công bố.</p> : <p className="empty-state">Không có cuộc thi đang diễn ra.</p>}</ResourceState></section>
    {data?.roundCandidates?.type && <section className="content-section">{data.roundCandidates.type === 'ranking' ? <><h2>Bảng xếp hạng {data.roundCandidates.roundName || `vòng ${data.roundCandidates.roundNumber}`}</h2><p className="section-note">Kết quả chính thức của vòng cuối cuộc thi.</p>{data.roundCandidates.items.length ? <Table headings={['Hạng', 'Họ và tên', 'Đơn vị', 'Điểm', 'Thời gian']}><>{data.roundCandidates.items.map(item => <tr key={item.roundRank}><td>{item.roundRank}</td><td>{item.fullName}</td><td>{item.unitName || '—'}</td><td>{Number(item.score).toLocaleString('vi-VN')} / 100</td><td>{item.durationSeconds == null ? '—' : `${Math.floor(item.durationSeconds / 60)} phút ${item.durationSeconds % 60} giây`}</td></tr>)}</></Table> : <p className="empty-state">Chưa có kết quả hợp lệ để xếp hạng.</p>}</> : <><h2>{data.roundCandidates.type === 'advanced' ? `Danh sách thí sinh vượt qua ${data.roundCandidates.roundName || `vòng ${data.roundCandidates.roundNumber}`}` : `Danh sách thí sinh vòng ${data.roundCandidates.roundName || data.roundCandidates.roundNumber}`}</h2><p className="section-note">{data.roundCandidates.type === 'advanced' ? 'Danh sách Top N đã được hệ thống chốt.' : 'Danh sách thí sinh đã đăng ký cuộc thi.'}</p>{data.roundCandidates.items.length ? <Table headings={['STT', 'Họ và tên', 'Email', 'Số điện thoại', 'Đơn vị', 'Trực thuộc']}><>{data.roundCandidates.items.map((item, index) => <tr key={item.id}><td>{index + 1}</td><td>{item.fullName}</td><td>{item.email || '—'}</td><td>{item.phone || '—'}</td><td>{item.unitName || '—'}</td><td>{item.organizationName || '—'}</td></tr>)}</></Table> : <p className="empty-state">Chưa có thí sinh đủ điều kiện.</p>}</>}</section>}
    <section className="content-section"><h2>Thống kê cuộc thi</h2><ResourceState resource={dashboard}>{showCompetitionInformation ? <div className="stat-cards"><div><strong>{Number(data?.statistics?.totalRegistrations || 0).toLocaleString('vi-VN')}</strong><span>Số lượng đăng ký</span></div><div><strong>{Number(data?.statistics?.totalTests || 0).toLocaleString('vi-VN')}</strong><span>Số lượt thi</span></div></div> : <p className="empty-state">Không có cuộc thi đang diễn ra.</p>}</ResourceState></section>
    <section className="content-section news-section" id="tin-tuc"><h2>Tin tức</h2>{news.length ? <div className="news-grid">{news.map((item, index) => <a className="news-card" href={assetUrl(item.url)} key={item.url} target="_blank" rel="noreferrer"><span>Tin {index + 1}</span><strong>{item.title}</strong><small>Xem tài liệu ↗</small></a>)}</div> : <p className="empty-state">Chưa có tin tức được công bố.</p>}</section>
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
      {user && <nav className="tab-nav primary-tabs" aria-label="Điều hướng tài khoản">{!forced && <>{user.role === 'candidate' ? <button className={selected === 'candidate' ? 'active' : ''} aria-pressed={selected === 'candidate'} onClick={() => setView('candidate')}>Làm bài, kết quả</button> : <button className={selected === 'manage' ? 'active' : ''} aria-pressed={selected === 'manage'} onClick={() => setView('manage')}>Quản lý</button>}{allowedReports && <button className={selected === 'reports' ? 'active' : ''} aria-pressed={selected === 'reports'} onClick={() => setView('reports')}>Thống kê</button>}</>}<button className={selected === 'account' ? 'active' : ''} aria-pressed={selected === 'account'} onClick={() => setView('account')}>Tài khoản</button><button className="logout-button" disabled={session.loading} onClick={logout}>Đăng xuất</button></nav>}
      <Notice text={notice} /><Notice text={session.error} error /><Notice text={site.error} error />
      {forced ? <PasswordForm token={session.token} required onChanged={changePassword} /> : <>
        {selected === 'home' && <PublicHome refresh={refresh} site={data} units={units.data?.data || []} onAuthenticated={authenticate} showAuth={!user} onEnter={() => setView(user?.role === 'candidate' ? 'candidate' : user ? 'manage' : 'account')} />}
        {selected === 'account' && <div id="auth-panel">{user ? <><section className="login-card"><h2>Thông tin tài khoản</h2><p><strong>{user.hoten}</strong> · {roleNames[user.role]}</p><p>{user.dienthoai} · {user.email}</p><p>Đơn vị: {user.donvi?.ten || user.unitName || units.data?.data?.find(unit => String(unit.id) === String(user.donviID))?.ten || 'Chưa chọn đơn vị'}</p></section><PasswordForm token={session.token} onChanged={changePassword} /></> : session.loading ? <p className="empty-state" role="status">Đang kiểm tra phiên đăng nhập…</p> : session.token ? <section className="login-card"><p>Chưa thể xác minh phiên đăng nhập.</p><div className="actions"><button onClick={session.retry}>Thử lại</button><button className="secondary" onClick={logout}>Đăng xuất trên thiết bị này</button></div></section> : <AuthPanel units={units.data?.data || []} unitsError={units.error} onAuthenticated={authenticate} />}</div>}
        {user?.role === 'candidate' && <div hidden={selected !== 'candidate'}><CandidateWorkspace key={user.id} user={user} token={session.token} /></div>}
        {user && user.role !== 'candidate' && selected === 'manage' && <ManageWorkspace key={user.id} user={user} token={session.token} units={units.data?.data || []} onSiteChanged={() => setRefresh(value => value + 1)} />}
        {user && allowedReports && selected === 'reports' && <Reports token={session.token} role={user.role} />}
      </>}
    </div><footer><div className="container"><strong>Tỉnh Đoàn Vĩnh Long</strong><p>Cổng thông tin thi trực tuyến · © {new Date().getFullYear()}</p></div></footer>
  </main>;
}
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
