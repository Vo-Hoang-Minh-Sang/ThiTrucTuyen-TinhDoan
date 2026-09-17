import { useState } from 'react';
import { downloadFile } from '../shared/api';
import { CompetitionSelect, DateFilters, Notice, ResourceState, Table, formatDate, queryString, useAction, useResource } from '../shared/ui';

// Frontend chỉ hiển thị số liệu đã được backend tổng hợp và phân loại theo điểm chuẩn.
export default function Reports({ token, role }) {
  const candidate = role === 'candidate';
  const [tab, setTab] = useState('statistics');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ competitionId: '', roundId: '', organizationId: '', from: '', to: '', q: '', status: 'all' });
  const [query, setQuery] = useState(filters);
  const competitions = useResource(candidate ? '/candidate/competitions' : '/manage/competitions', token);
  const path = queryString(query);
  const report = useResource(`/reports?${path}`, token);
  const lookup = useResource(tab === 'results' && query.competitionId ? `/reports/results?${path}` : null, token);
  const action = useAction();
  const organizations = report.data?.organizations || [];
  const rounds = report.data?.rounds || [];
  const rows = report.data?.rows || [];
  const value = item => item == null ? '—' : Number(item).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
  let roundNumber = 0, unitNumber = 0;
  const displayRows = rows.map(item => {
    if (item.type === 'total' || item.type === 'competition') return { ...item, sequence: '' };
    if (item.type === 'round') { roundNumber += 1; unitNumber = 0; return { ...item, sequence: String(roundNumber) }; }
    unitNumber += 1;
    return { ...item, sequence: `${roundNumber}.${unitNumber}` };
  });
  const pageSize = 10;
  const currentItems = tab === 'statistics' ? displayRows : (lookup.data?.items || []);
  const pages = Math.max(1, Math.ceil(currentItems.length / pageSize));
  const visibleItems = currentItems.slice((page - 1) * pageSize, page * pageSize);
  const pager = currentItems.length > pageSize && <div className="pagination"><span>{currentItems.length} bản ghi · Trang {page}/{pages}</span><button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Trang trước</button><button type="button" className="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Trang sau</button></div>;
  const changeCompetition = value => setFilters({ ...filters, competitionId: value, roundId: '' });
  const filterForm = <form className="form-grid filters" onSubmit={event => { event.preventDefault(); setPage(1); setQuery({ ...filters }); }}><CompetitionSelect items={competitions.data?.items || []} value={filters.competitionId} onChange={changeCompetition} />
    {!candidate && <><label>Vòng thi<select value={filters.roundId} onChange={event => setFilters({ ...filters, roundId: event.target.value })} disabled={!filters.competitionId}><option value="">Tất cả vòng thi</option>{rounds.map(item => <option key={item.id} value={item.id}>{item.name || `Vòng ${item.roundNumber}`}</option>)}</select></label><label>Đoàn cơ sở<select value={filters.organizationId} onChange={event => setFilters({ ...filters, organizationId: event.target.value })}><option value="">Tất cả đoàn cơ sở</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}
    {tab === 'results' && <><label>Họ và tên<input value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} maxLength={255} /></label><label>Trạng thái<select value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })}><option value="all">Tất cả</option><option value="passed">Đạt</option><option value="failed">Không đạt</option></select></label></>}<DateFilters value={filters} onChange={setFilters} /><button>Xem {tab === 'results' ? 'kết quả' : 'thống kê'}</button></form>;
  return <section className="content-section"><h2>{candidate ? 'Thống kê của bạn' : 'Thống kê cuộc thi'}</h2>{!candidate && <nav className="tab-nav competition-tabs"><button className={tab === 'statistics' ? 'active' : ''} onClick={() => { setTab('statistics'); setPage(1); }}>Thống kê</button><button className={tab === 'results' ? 'active' : ''} onClick={() => { setTab('results'); setPage(1); }}>Tra cứu kết quả</button></nav>}{filterForm}<Notice text={competitions.error} error />
    {tab === 'statistics' ? <ResourceState resource={report}>{candidate ? <div className="stat-cards report-stats">{[['registrations', 'Lượt đăng ký'], ['attempts', 'Lượt thi'], ['completed', 'Bài đã chấm'], ['averageScore', 'Điểm trung bình / 100']].map(([key, label]) => <div key={key}><strong>{value(report.data?.summary?.[key])}</strong><span>{label}</span></div>)}</div> : <Table headings={['STT', 'Đơn vị / vòng thi', 'Số thí sinh tham gia', 'Số lượt thi', 'Đạt', 'Không đạt', 'Điểm trung bình']}><>{visibleItems.map(item => <tr key={`${item.type}-${item.unitId ?? item.label}`}><td>{item.sequence}</td><td>{item.type === 'unit' ? item.label : <strong>{item.label}</strong>}</td><td>{value(item.participants)}</td><td>{value(item.attempts)}</td><td>{value(item.passed)}</td><td>{value(item.failed)}</td><td>{value(item.averageScore)}</td></tr>)}</></Table>}</ResourceState> : !query.competitionId ? <p className="empty-state">Chọn kỳ thi để tra cứu kết quả.</p> : <ResourceState resource={lookup} empty={!lookup.data?.items?.length}><Table headings={['STT', 'Họ và tên', 'Đơn vị thi', 'Thời gian nộp bài', 'Trạng thái', 'Điểm thi']}><>{visibleItems.map((item, index) => <tr key={item.id}><td>{(page - 1) * pageSize + index + 1}</td><td>{item.fullName}</td><td>{item.unitName}</td><td>{formatDate(item.finishedAt)}</td><td>{item.status === 'passed' ? 'Đạt' : 'Không đạt'}</td><td>{value(item.score)}</td></tr>)}</></Table></ResourceState>}{pager}
    {!candidate && <div className="actions"><button disabled={(tab === 'results' && !query.competitionId) || action.busy || (tab === 'statistics' ? report.loading || Boolean(report.error) : lookup.loading || Boolean(lookup.error))} onClick={() => action.run(() => downloadFile(tab === 'statistics' ? `/reports/export?${path}` : `/reports/results/export?${path}`, token, tab === 'statistics' ? 'thong-ke-cuoc-thi.xlsx' : 'tra-cuu-ket-qua.xlsx'), 'Đã tải báo cáo Excel theo bộ lọc đang hiển thị.')}>Xuất báo cáo Excel</button></div>}<Notice {...action} />
  </section>;
}
