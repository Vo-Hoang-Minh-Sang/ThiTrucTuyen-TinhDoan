import { useState } from 'react';
import { downloadFile } from './api';
import { CompetitionSelect, DateFilters, Notice, ResourceState, Table, queryString, useAction, useResource } from './ui';

export default function Reports({ token, role }) {
  const [filters, setFilters] = useState({ competitionId: '', from: '', to: '' });
  const [query, setQuery] = useState(filters);
  const competitions = useResource(role === 'candidate' ? '/candidate/competitions' : '/manage/competitions', token);
  const path = queryString(query);
  const resource = useResource(`/reports?${path}`, token);
  const action = useAction();
  const summary = resource.data?.summary;
  const units = resource.data?.units || [];
  return <section className="content-section"><h2>Thống kê cuộc thi</h2><p className="section-note">Số đăng ký kỳ thi, lượt bắt đầu làm bài và kết quả đã chấm theo phạm vi được xem.</p><form className="form-grid filters" onSubmit={event => { event.preventDefault(); setQuery({ ...filters }); }}><CompetitionSelect items={competitions.data?.items || []} value={filters.competitionId} onChange={value => setFilters({ ...filters, competitionId: value })} /><DateFilters value={filters} onChange={setFilters} /><button>Xem thống kê</button></form><Notice text={competitions.error} error />
    <ResourceState resource={resource}><div className="stat-cards report-stats">{[['registrations', 'Lượt đăng ký'], ['attempts', 'Lượt thi'], ['completed', 'Bài đã chấm'], ['averageScore', 'Điểm trung bình / 100']].map(([key, label]) => <div key={key}><strong>{summary?.[key] == null ? '—' : Number(summary[key]).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}</strong><span>{label}</span></div>)}</div><h3>Chi tiết theo đơn vị</h3>{units.length ? <Table headings={['Đơn vị', 'Đăng ký', 'Lượt thi', 'Đã chấm', 'Điểm trung bình']}>{units.map(unit => <tr key={unit.id ?? 'none'}><td>{unit.name || 'Chưa chọn đơn vị'}</td><td>{unit.registrations}</td><td>{unit.attempts}</td><td>{unit.completed}</td><td>{unit.averageScore == null ? '—' : Number(unit.averageScore).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}</td></tr>)}</Table> : <p className="empty-state">Chưa có dữ liệu theo đơn vị.</p>}</ResourceState>
    {role !== 'candidate' && <div className="actions"><button disabled={action.busy || resource.loading || Boolean(resource.error)} onClick={() => action.run(() => downloadFile(`/reports/export?${path}`, token, 'thong-ke-cuoc-thi.xlsx'), 'Đã tải báo cáo Excel theo bộ lọc đang hiển thị.')}>Xuất báo cáo Excel</button></div>}<Notice {...action} />
  </section>;
}
