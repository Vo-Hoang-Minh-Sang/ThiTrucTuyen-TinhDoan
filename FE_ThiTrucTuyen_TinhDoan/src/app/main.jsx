import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AuthPanel, { PasswordForm } from '../auth/AuthPanel';
import CandidateWorkspace from '../candidate/CandidateWorkspace';
import ManageWorkspace from '../management/ManageWorkspace';
import Reports from '../management/Reports';
import useSession from '../auth/useSession';
import { assetUrl } from '../shared/api';
import { Notice, Pagination, ResourceState, Table, formatDate, roleNames, useResource } from '../shared/ui';
import '../shared/styles.css';

const DEFAULT_FOOTER = { organizationLabel: '\u0110\u01a1n v\u1ecb t\u1ed5 ch\u1ee9c', organizationName: 'T\u1ec9nh \u0110o\u00e0n V\u0129nh Long', address: '169/2, \u0111\u01b0\u1eddng Ph\u1ea1m H\u00f9ng, Ph\u01b0\u1eddng Long Ch\u00e2u, t\u1ec9nh V\u0129nh Long', contactLabel: 'Li\u00ean h\u1ec7', email: 'tuyengiao.tinhdoanvinhlong@gmail.com', website: 'tinhdoanvinhlong.vn' };

// URL hash lưu màn hình đang mở để nút Quay lại/Tiến tới của trình duyệt hoạt động với giao diện một trang.
function readRoute(state = window.history.state) {
  if (state?.view) return state;
  const [view, tab] = window.location.hash.replace(/^#\/?/, '').split('/');
  if (view === 'candidate') return { view, candidateTab: ['competitions', 'exams', 'results'].includes(tab) ? tab : 'competitions' };
  return { view: ['account', 'manage', 'reports'].includes(view) ? view : 'home' };
}

function routeHash(view, candidateTab) {
  return view === 'candidate' ? `#/candidate/${['competitions', 'exams', 'results'].includes(candidateTab) ? candidateTab : 'competitions'}` : `#/${view}`;
}

// Trang công khai dùng dữ liệu thật; dữ liệu tài khoản và đáp án nằm trong khu vực riêng.
function Countdown({ competition, onEnter, enterLabel }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const start = competition?.startDate ? Date.parse(competition.startDate) : NaN;
  const end = competition?.endDate ? Date.parse(competition.endDate) : NaN;
  const target = Number.isFinite(start) && now < start ? start : end;
  const total = Number.isFinite(target) ? Math.max(0, target - now) : 0;
  const days = Math.floor(total / 86400000), hours = Math.floor(total / 3600000) % 24, minutes = Math.floor(total / 60000) % 60, seconds = Math.floor(total / 1000) % 60;
  return <div className="countdown-block"><div className="countdown-panel"><div><strong>{String(days).padStart(2, '0')}</strong><span>Ngày</span></div><div><strong>{String(hours).padStart(2, '0')}</strong><span>Giờ</span></div><div><strong>{String(minutes).padStart(2, '0')}</strong><span>Phút</span></div><div><strong>{String(seconds).padStart(2, '0')}</strong><span>Giây</span></div></div><button type="button" className="start-button" onClick={onEnter}>{enterLabel}</button></div>;
}


// Bi?u tr?ng ?o?n hi?n th? tr?c ti?p b?ng SVG ?? s?c n?t ? m?i k?ch th??c m?n h?nh.
function YouthUnionLogo() {
  // Ảnh logo được đặt tại public/images/LOGODoan.png để Vite phục vụ trực tiếp ở mọi môi trường.
  return <span className="brand-mark"><img src="/images/LOGODoan.png" alt="Tỉnh Vĩnh Long" /><span className="brand-mark-label">Tỉnh Vĩnh Long</span></span>;
}

function PublicHome({ refresh, site, units, onAuthenticated, showAuth, onEnter, enterLabel }) {
  const dashboard = useResource('/dashboard', null, refresh);
  const [bannerIndex, setBannerIndex] = useState(0);
  // Danh sach cong khai phan trang tai trinh duyet, 20 thi sinh tren moi trang.
  const [candidatePage, setCandidatePage] = useState(1);
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
  const roundCandidateItems = data?.roundCandidates?.items || [];
  const roundCandidatePageSize = 20;
  const roundCandidateOffset = (candidatePage - 1) * roundCandidatePageSize;
  const roundCandidatePageItems = roundCandidateItems.slice(roundCandidateOffset, roundCandidateOffset + roundCandidatePageSize);
  useEffect(() => { setCandidatePage(1); }, [data?.roundCandidates?.type, data?.roundCandidates?.roundName, roundCandidateItems.length]);
  return <>
    <section className="reference-hero" id="hero-section"><div className="reference-hero-grid"><div className="hero-media">{banner ? <img src={assetUrl(banner.url)} alt={banner.title || 'Banner cuộc thi'} /> : <div className="home-hero-copy"><p>TỈNH ĐOÀN</p><h1>{site?.title || 'Cổng thi trực tuyến'}</h1><p>{site?.description || 'Theo dõi lịch thi, tham gia làm bài và tra cứu kết quả.'}</p></div>}{banners.length > 1 && <div className="hero-dots">{banners.map((item, index) => <button key={item.url} aria-label={`Xem banner ${index + 1}`} aria-pressed={index === bannerIndex} className={index === bannerIndex ? 'active' : ''} onClick={() => setBannerIndex(index)} />)}</div>}</div><aside className="hero-side"><Countdown competition={data?.competition} onEnter={onEnter} enterLabel={enterLabel} />{showAuth ? <AuthPanel units={units} onAuthenticated={onAuthenticated} /> : <div className="landing-message logged-competition"><h3>{data?.competition?.name || 'Cuộc thi trực tuyến'}</h3></div>}</aside></div></section>
    <section className="content-section" id="lich-thi"><h2>Lịch trình cuộc thi</h2><ResourceState resource={dashboard}>{showCompetitionInformation ? data?.rounds?.length ? <ol className="timeline">{data.rounds.map((round, index) => <li key={round.id}><span className="round-number">{round.roundNumber || index + 1}</span><div><h3>{round.name || `Vòng thi ${round.roundNumber || index + 1}`}</h3><p>{formatDate(round.startAt)} → {formatDate(round.endAt)}</p></div></li>)}</ol> : <p className="empty-state">Chưa có lịch trình được công bố.</p> : <p className="empty-state">Không có cuộc thi đang diễn ra.</p>}</ResourceState></section>
    {data?.roundCandidates?.type && <section className="content-section">{data.roundCandidates.type === 'ranking' ? <><h2>Bảng xếp hạng {data.roundCandidates.roundName || `vòng ${data.roundCandidates.roundNumber}`}</h2><p className="section-note">Kết quả chính thức của vòng cuối cuộc thi.</p>{data.roundCandidates.items.length ? <><Table headings={['Hạng', 'Họ và tên', 'Đơn vị', 'Điểm', 'Thời gian']}><>{roundCandidatePageItems.map(item => <tr key={item.roundRank}><td>{item.roundRank}</td><td>{item.fullName}</td><td>{item.unitName || '—'}</td><td>{Number(item.score).toLocaleString('vi-VN')} {'\u0111i\u1ec3m'}</td><td>{item.durationSeconds == null ? '—' : `${Math.floor(item.durationSeconds / 60)} phút ${item.durationSeconds % 60} giây`}</td></tr>)}</></Table><Pagination total={roundCandidateItems.length} pageSize={roundCandidatePageSize} page={candidatePage} onChange={setCandidatePage} /></> : <p className="empty-state">Chưa có kết quả hợp lệ để xếp hạng.</p>}</> : <><h2>{data.roundCandidates.type === 'advanced' ? `Danh sách thí sinh vượt qua ${data.roundCandidates.roundName || `vòng ${data.roundCandidates.roundNumber}`}` : `Danh sách thí sinh ${data.roundCandidates.roundName || data.roundCandidates.roundNumber}`}</h2><p className="section-note">{data.roundCandidates.type === 'advanced' ? 'Danh sách Top N đã được hệ thống chốt.' : 'Danh sách thí sinh đã đăng ký cuộc thi.'}</p>{data.roundCandidates.items.length ? <><Table headings={['STT', 'Họ và tên', 'Email', 'Đơn vị', 'Trực thuộc']}><>{roundCandidatePageItems.map((item, index) => <tr key={item.id}><td>{roundCandidateOffset + index + 1}</td><td>{item.fullName}</td><td>{item.email || '—'}</td><td>{item.unitName || '—'}</td><td>{item.organizationName || '—'}</td></tr>)}</></Table><Pagination total={roundCandidateItems.length} pageSize={roundCandidatePageSize} page={candidatePage} onChange={setCandidatePage} /></> : <p className="empty-state">Chưa có thí sinh đủ điều kiện.</p>}</>}</section>}
    <section className="content-section"><h2>Thống kê cuộc thi</h2><ResourceState resource={dashboard}>{showCompetitionInformation ? <div className="stat-cards"><div><strong>{Number(data?.statistics?.totalRegistrations || 0).toLocaleString('vi-VN')}</strong><span>Số lượng đăng ký</span></div><div><strong>{Number(data?.statistics?.totalTests || 0).toLocaleString('vi-VN')}</strong><span>Số lượt thi</span></div></div> : <p className="empty-state">Không có cuộc thi đang diễn ra.</p>}</ResourceState></section>
    <section className="content-section news-section" id="tin-tuc"><h2>Tin tức</h2>{news.length ? <div className="news-grid">{news.map((item, index) => <article className="news-card" key={item.url}><a className="news-preview" href={assetUrl(item.url)} target="_blank" rel="noreferrer"><span>{`Tin ${index + 1}`}</span><strong>{item.title}</strong><small>{'Xem tr\u1ef1c ti\u1ebfp \u2197'}</small></a><a className="news-download" href={assetUrl(`${item.url}?download=1`)} download>{'T\u1ea3i xu\u1ed1ng'}</a></article>)}</div> : <p className="empty-state">{'Ch\u01b0a c\u00f3 tin t\u1ee9c \u0111\u01b0\u1ee3c c\u00f4ng b\u1ed1.'}</p>}</section>
  </>;
}

export function App() {
  const session = useSession();
  const initialRoute = readRoute();
  const [view, setView] = useState(initialRoute.view);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [reportCompetitionId, setReportCompetitionId] = useState('');
  const [candidateTab, setCandidateTab] = useState(initialRoute.candidateTab || 'competitions');
  const [notice, setNotice] = useState('');
  const site = useResource('/site', null, refresh);
  const units = useResource('/units', null, refresh);
  const data = site.data?.item;
  const footer = { ...DEFAULT_FOOTER, ...(data?.footer || {}) };
  const user = session.user;
  const forced = Boolean(Number(user?.must_change_password));
  const allowedReports = user?.role === 'candidate' || user?.role === 'admin' || user?.permissions?.includes('reports');
  const navigate = (nextView, options = {}) => {
    const nextCandidateTab = options.candidateTab || candidateTab;
    const nextReportCompetitionId = options.reportCompetitionId ?? reportCompetitionId;
    setView(nextView);
    if (nextView === 'candidate') setCandidateTab(nextCandidateTab);
    if (options.reportCompetitionId != null) setReportCompetitionId(String(options.reportCompetitionId));
    const nextState = { view: nextView, candidateTab: nextCandidateTab, reportCompetitionId: nextReportCompetitionId };
    const hash = routeHash(nextView, nextCandidateTab);
    if (window.location.hash !== hash) window.history.pushState(nextState, '', hash);
  };
  useEffect(() => {
    // Khôi phục đúng màn hình và tab khi người dùng nhấn nút Quay lại hoặc Tiến tới.
    const onPopState = event => {
      const route = readRoute(event.state);
      setView(route.view);
      setCandidateTab(route.candidateTab || 'competitions');
      setReportCompetitionId(route.reportCompetitionId || '');
      setMenuOpen(false);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const changePassword = async () => { await session.logout(); setNotice('Đã đổi mật khẩu. Vui lòng đăng nhập lại bằng mật khẩu mới.'); navigate('account'); };
  const authenticate = payload => {
    session.authenticate(payload); setNotice('');
    const isCandidate = payload.user?.role === 'candidate';
    navigate(isCandidate ? 'candidate' : 'manage', { candidateTab: 'competitions' });
    // Ch? React hi?n th? danh s?ch r?i cu?n m??t ?? th? sinh th?y c?c k? thi ngay sau ??ng nh?p.
    if (isCandidate) setTimeout(() => document.querySelector('#candidate-competitions .exam-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };
  const logout = async () => { await session.logout(); navigate('account'); setNotice(''); };
  // Lịch thi nằm trên trang chủ; luôn chuyển trang trước rồi mới cuộn đến khu vực này.
  const openSchedule = () => { navigate('home'); setMenuOpen(false); setTimeout(() => document.getElementById('lich-thi')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0); };
  const selected = !user && !['home', 'account'].includes(view) ? 'account' : view;
  return <main>
    <header className="site-header"><div className="container header-inner"><a className="site-brand" href="#/home" onClick={event => { event.preventDefault(); navigate('home'); setMenuOpen(false); }}><YouthUnionLogo />Cổng thông tin thi trực tuyến</a><nav className={`site-nav${menuOpen ? ' is-open' : ''}`} aria-label="Điều hướng trang"><a href="#/home" onClick={event => { event.preventDefault(); navigate('home'); setMenuOpen(false); }}>Trang chủ</a>{user?.role === 'candidate' && !forced ? <button type="button" onClick={() => { navigate('candidate', { candidateTab: 'competitions' }); setMenuOpen(false); }}>Làm bài thi</button> : <a href="#lich-thi" onClick={event => { event.preventDefault(); openSchedule(); }}>Lịch thi</a>}{user && !forced && <>{user.role === 'candidate' ? <button type="button" onClick={() => { navigate('candidate', { candidateTab: 'results' }); setMenuOpen(false); }}>Kết quả</button> : <button type="button" onClick={() => { navigate('manage'); setMenuOpen(false); }}>Quản lý</button>}{allowedReports && <button type="button" onClick={() => { navigate('reports'); setMenuOpen(false); }}>Thống kê</button>}</>}{user ? <><button type="button" className="header-account" onClick={() => { navigate('account'); setMenuOpen(false); }}><strong>{user.hoten}</strong><span>{roleNames[user.role] || 'Tài khoản'}</span></button><button type="button" className="header-logout" disabled={session.loading} onClick={logout}>Đăng xuất</button></> : <a href="#/account" onClick={event => { event.preventDefault(); navigate('account'); setMenuOpen(false); }}>Đăng nhập</a>}</nav><button className="menu-toggle" aria-label="Mở menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)}>☰</button></div></header>
    <div className="container page-content" id="trang-chu">
      <Notice text={notice} /><Notice text={session.error} error /><Notice text={site.error} error />
      {forced ? <PasswordForm token={session.token} required onChanged={changePassword} /> : <>
        {selected === 'home' && <PublicHome refresh={refresh} site={data} units={units.data?.data || []} onAuthenticated={authenticate} showAuth={!user} onEnter={() => navigate(user?.role === 'candidate' ? 'candidate' : user ? 'manage' : 'account', { candidateTab: 'competitions' })} enterLabel={user?.role === 'admin' ? 'Quản lý kỳ thi' : '▶ Vào thi ngay'} />}
        {selected === 'account' && <div id="auth-panel">{user ? <><section className="login-card"><h2>Thông tin tài khoản</h2><p><strong>{user.hoten}</strong> · {roleNames[user.role]}</p><p>{user.dienthoai} · {user.email}</p><p>Đơn vị: {user.donvi?.ten || user.unitName || units.data?.data?.find(unit => String(unit.id) === String(user.donviID))?.ten || 'Chưa chọn đơn vị'}</p></section><PasswordForm token={session.token} onChanged={changePassword} /></> : session.loading ? <p className="empty-state" role="status">Đang kiểm tra phiên đăng nhập…</p> : session.token ? <section className="login-card"><p>Chưa thể xác minh phiên đăng nhập.</p><div className="actions"><button onClick={session.retry}>Thử lại</button><button className="secondary" onClick={logout}>Đăng xuất trên thiết bị này</button></div></section> : <AuthPanel units={units.data?.data || []} unitsError={units.error} onAuthenticated={authenticate} />}</div>}
        {user?.role === 'candidate' && <div hidden={selected !== 'candidate'}><CandidateWorkspace key={user.id} user={user} token={session.token} units={units.data?.data || []} initialTab={candidateTab} /></div>}
        {user && user.role !== 'candidate' && selected === 'manage' && <ManageWorkspace key={user.id} user={user} token={session.token} units={units.data?.data || []} onSiteChanged={() => setRefresh(value => value + 1)} onOpenReports={competitionId => navigate('reports', { reportCompetitionId: competitionId })} />}
        {user && allowedReports && selected === 'reports' && <Reports token={session.token} role={user.role} initialCompetitionId={reportCompetitionId} />}
      </>}
    </div><footer><div className="container footer-content"><div className="footer-column"><strong>{footer.organizationLabel}</strong><p className="footer-organization">{footer.organizationName}</p><p>{'\u0110\u1ecba ch\u1ec9: '}{footer.address}</p></div><div className="footer-column footer-contact"><strong>{footer.contactLabel}</strong><p>{'Email: '}<a href={`mailto:${footer.email}`}>{footer.email}</a></p><p>{'Website: '}<a href={footer.website.startsWith('http') ? footer.website : `https://${footer.website}`} target="_blank" rel="noreferrer">{footer.website}</a></p></div></div></footer>
  </main>;
}
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
