import { useEffect, useState } from 'react';
import { downloadFile } from '../shared/api';
import { DateFilters, Notice, ResourceState, Table, formatDate, queryString, useAction, useResource } from '../shared/ui';

// Frontend chỉ hiển thị số liệu đã được backend tổng hợp và phân loại theo điểm chuẩn.
export default function Reports({ token, role, initialCompetitionId = '' }) {
  const candidate = role === 'candidate';
  const [tab, setTab] = useState('statistics');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ competitionId: '', roundId: '', organizationId: '', from: '', to: '', q: '', top: 'all' });
  const [query, setQuery] = useState(filters);
  const [competitionSearch, setCompetitionSearch] = useState('');
  useEffect(() => {
    if (!initialCompetitionId) return;
    const next = { ...filters, competitionId: String(initialCompetitionId), roundId: '' };
    setFilters(next); setQuery(next); setPage(1); setTab('statistics');
  }, [initialCompetitionId]);
  const competitions = useResource(candidate ? '/candidate/competitions' : '/manage/competitions', token);
  useEffect(() => {
    const selected = (competitions.data?.items || []).find(item => String(item.id) === String(filters.competitionId));
    if (selected && selected.name !== competitionSearch) setCompetitionSearch(selected.name);
  }, [competitions.data?.items, filters.competitionId, competitionSearch]);
  const path = queryString(query);
  const report = useResource(`/reports?${path}`, token);
  const lookup = useResource(tab === 'results' && query.competitionId ? `/reports/results?${path}` : null, token);
  const roundOptions = useResource(!candidate && filters.competitionId ? `/manage/competitions/${filters.competitionId}/rounds` : null, token);
  const action = useAction();
  const organizations = report.data?.organizations || [];
  const rounds = roundOptions.data?.items || report.data?.rounds || [];
  const rows = report.data?.rows || [];
  const value = item => item == null ? '—' : Number(item).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
  const average = item => item == null ? '—' : Number(item).toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const duration = seconds => seconds == null ? '\u2014' : `${Math.floor(Number(seconds) / 60)} ph\u00fat ${Number(seconds) % 60} gi\u00e2y`;
  const lookupHeadings = ['STT', 'H\u1ecd v\u00e0 t\u00ean', '\u0110\u01a1n v\u1ecb', 'Email', '\u0110i\u1ec7n tho\u1ea1i', '\u0110i\u1ec3m', 'Th\u1eddi gian l\u00e0m b\u00e0i', 'Th\u1eddi gian n\u1ed9p b\u00e0i'];
  const statisticsHeadings = ['STT', '\u0110\u01a1n v\u1ecb / v\u00f2ng thi', 'S\u1ed1 th\u00ed sinh tham gia', 'S\u1ed1 l\u01b0\u1ee3t thi', '\u0110i\u1ec3m trung b\u00ecnh'];
  let roundNumber = 0, unitNumber = 0;
  const displayRows = rows.map(item => {
    if (item.type === 'total' || item.type === 'competition') return { ...item, sequence: '' };
    if (item.type === 'round') { roundNumber += 1; unitNumber = 0; return { ...item, sequence: String(roundNumber) }; }
    unitNumber += 1;
    return { ...item, sequence: `${roundNumber}.${unitNumber}` };
  });
  const pageSize = 10;
  // Giu dung so dong Top tren giao dien ngay ca khi backend dang khoi dong lai chua nhan ma moi.
  const topLimit = query.top && query.top !== 'all' ? Number(query.top) : null;
  const lookupItems = lookup.data?.items || [];
  const currentItems = tab === 'statistics' ? displayRows : (topLimit && Number.isSafeInteger(topLimit) && topLimit > 0 ? lookupItems.slice(0, topLimit) : lookupItems);
  const pages = Math.max(1, Math.ceil(currentItems.length / pageSize));
  const visibleItems = currentItems.slice((page - 1) * pageSize, page * pageSize);
  const pager = currentItems.length > pageSize && <div className="pagination"><span>{currentItems.length} bản ghi · Trang {page}/{pages}</span><button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Trang trước</button><button type="button" className="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Trang sau</button></div>;
  const chooseCompetitionByName = value => {
    setCompetitionSearch(value);
    const normalized = value.trim().toLocaleLowerCase('vi');
    const item = (competitions.data?.items || []).find(competition => competition.name.trim().toLocaleLowerCase('vi') === normalized);
    setFilters(current => ({ ...current, competitionId: item ? String(item.id) : '', roundId: '' }));
  };
  const filterForm = <form className="form-grid filters" onSubmit={event => { event.preventDefault(); setPage(1); setQuery({ ...filters }); }}><label>Kỳ thi<input list="report-competition-options" value={competitionSearch} onChange={event => chooseCompetitionByName(event.target.value)} placeholder="Nhập tên kỳ thi để tìm" autoComplete="off" /><datalist id="report-competition-options">{(competitions.data?.items || []).filter(item => !competitionSearch || item.name.toLocaleLowerCase('vi').includes(competitionSearch.toLocaleLowerCase('vi'))).map(item => <option key={item.id} value={item.name} />)}</datalist></label>
    {!candidate && <><label>Vòng thi<select value={filters.roundId} onChange={event => setFilters({ ...filters, roundId: event.target.value })} disabled={!filters.competitionId}><option value="">Tất cả vòng thi</option>{rounds.map(item => <option key={item.id} value={item.id}>{item.name || `Vòng ${item.roundNumber}`}</option>)}</select></label><label>Đoàn cơ sở<select value={filters.organizationId} onChange={event => setFilters({ ...filters, organizationId: event.target.value })}><option value="">Tất cả đoàn cơ sở</option>{organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}
    {tab === 'results' && <><label>{'H\u1ecd v\u00e0 t\u00ean'}<input value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} maxLength={255} /></label><label>{'Top hi\u1ec3n th\u1ecb'}<input type="number" min="1" step="1" placeholder={'T\u1ea5t c\u1ea3'} value={filters.top === 'all' ? '' : filters.top} onChange={event => { const top = event.target.value || 'all'; setFilters({ ...filters, top }); setQuery(current => ({ ...current, top })); setPage(1); }} /></label></>}<DateFilters value={filters} onChange={setFilters} /><button>Xem {tab === 'results' ? 'kết quả' : 'thống kê'}</button></form>;
  return <section className="content-section"><h2>{candidate ? 'Thống kê của bạn' : 'Thống kê cuộc thi'}</h2>{!candidate && <nav className="tab-nav competition-tabs"><button className={tab === 'statistics' ? 'active' : ''} onClick={() => { setTab('statistics'); setPage(1); }}>Thống kê</button><button className={tab === 'results' ? 'active' : ''} onClick={() => { setTab('results'); setPage(1); }}>Tra cứu kết quả</button></nav>}{filterForm}<Notice text={competitions.error} error />
    {tab === 'statistics' ? <ResourceState resource={report}>{candidate ? <div className="stat-cards report-stats">{[['registrations', 'Lượt đăng ký'], ['attempts', 'Lượt thi'], ['completed', 'Bài đã chấm'], ['averageScore', 'Điểm trung bình ']].map(([key, label]) => <div key={key}><strong>{key === 'averageScore' ? average(report.data?.summary?.[key]) : value(report.data?.summary?.[key])}</strong><span>{label}</span></div>)}</div> : <Table headings={statisticsHeadings}><>{visibleItems.map(item => <tr key={`${item.type}-${item.unitId ?? item.label}`}><td>{item.sequence}</td><td>{item.type === 'unit' ? item.label : <strong>{item.label}</strong>}</td><td>{value(item.participants)}</td><td>{value(item.attempts)}</td><td>{average(item.averageScore)}</td></tr>)}</></Table>}</ResourceState> : !query.competitionId ? <p className="empty-state">Chọn kỳ thi để tra cứu kết quả.</p> : <ResourceState resource={lookup} empty={!lookup.data?.items?.length}><Table headings={lookupHeadings}><>{visibleItems.map((item, index) => <tr key={item.id}><td>{(page - 1) * pageSize + index + 1}</td><td>{item.fullName}</td><td>{item.unitName}</td><td>{item.email || '\u2014'}</td><td>{item.phone || '\u2014'}</td><td>{value(item.score)}</td><td>{duration(item.durationSeconds)}</td><td>{formatDate(item.finishedAt)}</td></tr>)}</></Table></ResourceState>}{pager}
    {!candidate && <div className="actions"><button disabled={(tab === 'results' && !query.competitionId) || action.busy || (tab === 'statistics' ? report.loading || Boolean(report.error) : lookup.loading || Boolean(lookup.error))} onClick={() => action.run(() => downloadFile(tab === 'statistics' ? `/reports/export?${path}` : `/reports/results/export?${path}`, token, tab === 'statistics' ? 'thong-ke-cuoc-thi.xlsx' : 'tra-cuu-ket-qua.xlsx'), 'Đã tải báo cáo Excel theo bộ lọc đang hiển thị.')}>Xuất báo cáo Excel</button></div>}<Notice {...action} />
  </section>;
}
