import { useState } from 'react';
import { api, assetUrl, downloadFile } from './api';
import { CompetitionSelect, DateFilters, Notice, Pagination, ResourceState, Table, formatDate, queryString, roleNames, statusNames, useAction, useResource } from './ui';

const permissionNames = { questions: 'Ngân hàng câu hỏi', exams: 'Tạo đề thi', candidates: 'Danh sách thí sinh', reports: 'Thống kê, xuất báo cáo' };
const difficultyNames = { easy: 'Dễ', medium: 'Trung bình', hard: 'Khó' };
const blankQuestion = { competitionId: '', content: '', optionA: '', optionB: '', optionC: '', optionD: '', correctAnswer: 'A', topic: 'Chung', difficulty: 'medium' };
const blankCompetition = { name: '', description: '', durationMinutes: 30, maxAttempts: 1, startAt: '', endAt: '', status: 'draft' };
const localDate = value => { if (!value) return ''; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const numericIds = values => values.map(Number);
function Difficulty({ value, onChange, all = false }) { return <label>Độ khó<select value={value} onChange={event => onChange(event.target.value)}>{all && <option value="">Tất cả</option>}{Object.entries(difficultyNames).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>; }

export default function ManageWorkspace({ user, token, units, onSiteChanged }) {
  const isAdmin = user.role === 'admin';
  const allowed = permission => isAdmin || user.permissions?.includes(permission);
  const tabs = [isAdmin && ['competitions', 'Kỳ thi, lịch thi'], allowed('questions') && ['questions', 'Ngân hàng câu hỏi'], allowed('exams') && ['exams', 'Tạo đề thi'], allowed('candidates') && ['candidates', 'Thí sinh'], isAdmin && ['users', 'Tài khoản, phân quyền'], isAdmin && ['site', 'Giao diện, tài liệu'], isAdmin && ['units', 'Đơn vị']].filter(Boolean);
  const [tab, setTab] = useState(tabs[0]?.[0] || '');
  const [refresh, setRefresh] = useState(0);
  const competitions = useResource('/manage/competitions', token, refresh);
  const items = competitions.data?.items || [];
  const selected = tabs.some(([key]) => key === tab) ? tab : tabs[0]?.[0];
  const props = { token, competitions: items, units };
  return <section className="workspace"><nav className="tab-nav" aria-label="Chức năng quản lý">{tabs.map(([key, label]) => <button className={selected === key ? 'active' : ''} aria-pressed={selected === key} key={key} onClick={() => setTab(key)}>{label}</button>)}</nav>
    {!tabs.length && <p className="empty-state">Bạn chưa được cấp quyền quản lý. Vui lòng liên hệ quản trị viên.</p>}
    <Notice text={competitions.error} error />
    {selected === 'competitions' && <Competitions {...props} resource={competitions} onChanged={() => setRefresh(value => value + 1)} />}
    {selected === 'questions' && <Questions {...props} />}
    {selected === 'exams' && <ExamBuilder {...props} />}
    {selected === 'candidates' && <Candidates {...props} />}
    {selected === 'users' && <Users {...props} currentUser={user} />}
    {selected === 'site' && <SiteEditor token={token} onChanged={onSiteChanged} />}
    {selected === 'units' && <Units token={token} />}
  </section>;
}

function Competitions({ token, competitions, resource, onChanged }) {
  const [form, setForm] = useState(blankCompetition);
  const [id, setId] = useState(null);
  const [filters, setFilters] = useState({ from: '', to: '', q: '' });
  const action = useAction();
    const [rounds, setRounds] = useState([]);
    const [roundForm, setRoundForm] = useState({ roundNumber: 1, startAt: '', endAt: '' });
    const [roundId, setRoundId] = useState(null);
  const change = event => setForm({ ...form, [event.target.name]: event.target.value });
  const reset = () => { setId(null); setForm(blankCompetition); };
    const resetRound = () => { setRoundId(null); setRoundForm({ roundNumber: rounds.length + 1, startAt: '', endAt: '' }); };
  async function submit(event) {
    event.preventDefault();
    await action.run(async () => {
      await api(`/manage/competitions${id ? `/${id}` : ''}`, { token, method: id ? 'PUT' : 'POST', body: { ...form, durationMinutes: Number(form.durationMinutes), maxAttempts: Number(form.maxAttempts), startAt: form.startAt ? new Date(form.startAt).toISOString() : null, endAt: form.endAt ? new Date(form.endAt).toISOString() : null } });
      reset(); onChanged();
    }, id ? 'Đã cập nhật kỳ thi và lịch thi.' : 'Đã tạo kỳ thi. Hãy thêm câu hỏi và tạo đề trước khi cho thí sinh làm bài.');
  }
  const visible = competitions.filter(item => (!filters.q || item.name.toLocaleLowerCase('vi').includes(filters.q.toLocaleLowerCase('vi'))) && (!filters.from || Date.parse(item.endAt) >= Date.parse(`${filters.from}T00:00:00`)) && (!filters.to || Date.parse(item.startAt) <= Date.parse(`${filters.to}T23:59:59`)));
  async function loadRounds(competitionId) { const payload = await api(`/manage/competitions/${competitionId}/rounds`, { token }); setRounds(payload.items); resetRound(); }
  async function saveRound(event) { event.preventDefault(); await action.run(async () => { const path = `/manage/competitions/${id}/rounds${roundId ? `/${roundId}` : ''}`; await api(path, { token, method: roundId ? 'PUT' : 'POST', body: { ...roundForm, roundNumber: Number(roundForm.roundNumber), startAt: new Date(roundForm.startAt).toISOString(), endAt: new Date(roundForm.endAt).toISOString() } }); await loadRounds(id); }, roundId ? 'Đã cập nhật vòng thi.' : 'Đã thêm vòng thi.'); }
  return <section className="content-section"><h2>{id ? 'Chỉnh sửa kỳ thi' : 'Tạo kỳ thi và lịch thi'}</h2><form onSubmit={submit}><fieldset className="form-grid" disabled={action.busy}>
    <label className="span-all">Tên kỳ thi<input name="name" value={form.name} onChange={change} maxLength={255} required /></label><label className="span-all">Mô tả<textarea name="description" value={form.description} onChange={change} rows={3} /></label>
    <label>Thời gian làm bài (phút)<input name="durationMinutes" type="number" min={1} max={1440} value={form.durationMinutes} onChange={change} required /></label><label>Số lượt thi tối đa<input name="maxAttempts" type="number" min={1} max={100} value={form.maxAttempts} onChange={change} required /></label>
    <label>Bắt đầu<input name="startAt" type="datetime-local" value={form.startAt} onChange={change} required /></label><label>Kết thúc<input name="endAt" type="datetime-local" min={form.startAt || undefined} value={form.endAt} onChange={change} required /></label><label>Trạng thái<select name="status" value={form.status} onChange={change}><option value="draft">Bản nháp</option><option value="published">Công bố</option><option value="closed">Đóng kỳ thi</option></select></label><p className="form-note">Lịch nhập theo múi giờ của thiết bị. Thí sinh chỉ được làm trong khoảng thời gian đã công bố.</p>
    <div className="actions span-all"><button>{action.busy ? 'Đang lưu…' : id ? 'Lưu thay đổi' : 'Tạo kỳ thi'}</button>{id && <button type="button" className="secondary" onClick={reset}>Hủy chỉnh sửa</button>}</div>
  </fieldset></form><Notice {...action} /><h3>Danh sách và lịch thi</h3><div className="form-grid filters"><label>Tìm tên kỳ thi<input value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} /></label><DateFilters value={filters} onChange={setFilters} /></div>
    <ResourceState resource={resource} empty={!visible.length}><Table headings={['Kỳ thi', 'Lịch thi', 'Giới hạn', 'Trạng thái', 'Thao tác']}>{visible.map(item => <tr key={item.id}><td>{item.name}</td><td>{formatDate(item.startAt)}<br />{formatDate(item.endAt)}</td><td>{item.durationMinutes} phút · {item.maxAttempts} lượt</td><td>{statusNames[item.status] || item.status}</td><td><div className="table-actions"><button className="secondary" onClick={() => { setId(item.id); setForm({ ...item, startAt: localDate(item.startAt), endAt: localDate(item.endAt), description: item.description || '' }); action.clear(); }}>Sửa</button><button className="secondary" onClick={() => { setId(item.id); setForm({ ...item, startAt: localDate(item.startAt), endAt: localDate(item.endAt), description: item.description || '' }); action.run(() => loadRounds(item.id), ''); }}>Quản lý vòng</button></div></td></tr>)}</Table></ResourceState>
    {id && <div className="round-manager"><div className="section-heading"><div><h3>Vòng thi của kỳ thi</h3><p className="section-note">Mỗi vòng có thể kéo dài một ngày hoặc nhiều ngày và phải nằm trong lịch kỳ thi.</p></div><button type="button" className="secondary" onClick={resetRound}>Thêm vòng</button></div><form className="form-grid filters" onSubmit={saveRound}><label>Số vòng<input type="number" min="1" value={roundForm.roundNumber} onChange={event => setRoundForm({ ...roundForm, roundNumber: event.target.value })} required /></label><label>Bắt đầu vòng<input type="datetime-local" value={roundForm.startAt} onChange={event => setRoundForm({ ...roundForm, startAt: event.target.value })} required /></label><label>Kết thúc vòng<input type="datetime-local" min={roundForm.startAt || undefined} value={roundForm.endAt} onChange={event => setRoundForm({ ...roundForm, endAt: event.target.value })} required /></label><div className="actions"><button>{roundId ? 'Lưu vòng' : 'Thêm vòng'}</button>{roundId && <button type="button" className="secondary" onClick={resetRound}>Hủy</button>}</div></form><Table headings={['Vòng', 'Bắt đầu', 'Kết thúc', 'Thao tác']}>{rounds.map(round => <tr key={round.id}><td>{round.roundNumber}</td><td>{formatDate(round.startAt)}</td><td>{formatDate(round.endAt)}</td><td><div className="table-actions"><button type="button" className="secondary" onClick={() => { setRoundId(round.id); setRoundForm({ roundNumber: round.roundNumber, startAt: localDate(round.startAt), endAt: localDate(round.endAt) }); }}>Sửa</button><button type="button" className="danger" onClick={() => action.run(async () => { await api(`/manage/competitions/${id}/rounds/${round.id}`, { token, method: 'DELETE' }); await loadRounds(id); }, 'Đã xóa vòng thi.')}>Xóa</button></div></td></tr>)}</Table></div>}
  </section>;
}

function Questions({ token, competitions }) {
  const [filters, setFilters] = useState({ competitionId: '', q: '', topic: '', difficulty: '' });
  const [query, setQuery] = useState(filters);
  const [page, setPage] = useState(1);
  const [form, setForm] = useState(blankQuestion);
  const [id, setId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [file, setFile] = useState(null);
  const [importCompetition, setImportCompetition] = useState('');
  const [refresh, setRefresh] = useState(0);
  const action = useAction();
  const resource = useResource(`/manage/questions?${queryString({ ...query, page })}`, token, refresh);
  const change = event => setForm({ ...form, [event.target.name]: event.target.value });
  const reload = () => setRefresh(value => value + 1);
  async function submit(event) {
    event.preventDefault(); await action.run(async () => { await api(`/manage/questions${id ? `/${id}` : ''}`, { token, method: id ? 'PUT' : 'POST', body: { ...form, competitionId: Number(form.competitionId) } }); setId(null); setForm({ ...blankQuestion, competitionId: form.competitionId }); setDetail(null); reload(); });
  }
  return <section className="content-section"><h2>Ngân hàng câu hỏi</h2><form className="form-grid filters" onSubmit={event => { event.preventDefault(); setQuery({ ...filters }); setPage(1); }}><CompetitionSelect items={competitions} value={filters.competitionId} onChange={value => setFilters({ ...filters, competitionId: value })} /><label>Nội dung<input value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} /></label><label>Chủ đề<input value={filters.topic} onChange={event => setFilters({ ...filters, topic: event.target.value })} maxLength={120} /></label><Difficulty all value={filters.difficulty} onChange={value => setFilters({ ...filters, difficulty: value })} /><button>Tìm kiếm</button></form>
    <ResourceState resource={resource} empty={!resource.data?.items?.length}><Table headings={['Nội dung', 'Chủ đề', 'Độ khó', 'Đáp án', 'Thao tác']}>{resource.data?.items?.map(item => <tr key={item.id}><td className="long-cell">{item.content}</td><td>{item.topic}</td><td>{difficultyNames[item.difficulty]}</td><td>{item.correctAnswer}</td><td><div className="table-actions"><button className="secondary" disabled={action.busy} onClick={() => action.run(async () => { const payload = await api(`/manage/questions/${item.id}`, { token }); setDetail(payload.item); }, '')}>Xem</button><button className="secondary" disabled={action.busy} onClick={() => action.run(async () => { const payload = await api(`/manage/questions/${item.id}`, { token }); setId(item.id); setForm({ ...blankQuestion, ...payload.item, competitionId: String(payload.item.competitionId ?? payload.item.competition_id ?? '') }); }, '')}>Sửa</button><button className="danger" disabled={action.busy} onClick={() => { if (window.confirm('Xóa câu hỏi khỏi ngân hàng? Các đề đã tạo vẫn giữ nội dung tại thời điểm tạo.')) action.run(async () => { await api(`/manage/questions/${item.id}`, { token, method: 'DELETE' }); setDetail(null); reload(); }, 'Đã xóa câu hỏi khỏi ngân hàng.'); }}>Xóa</button></div></td></tr>)}</Table></ResourceState>
    <Pagination data={resource.data} page={page} onChange={setPage} />
    {detail && <aside className="detail-panel"><div className="section-heading"><h3>Chi tiết câu hỏi #{detail.id}</h3><button className="secondary" onClick={() => setDetail(null)}>Đóng chi tiết</button></div><p className="question-content">{detail.content}</p>{['A', 'B', 'C', 'D'].map(letter => <p key={letter}><strong>{letter}.</strong> {detail[`option${letter}`]} {detail.correctAnswer === letter && <span className="badge">Đáp án đúng</span>}</p>)}<p>{detail.topic} · {difficultyNames[detail.difficulty]}</p></aside>}
    <h3>{id ? `Sửa câu hỏi #${id}` : 'Thêm câu hỏi'}</h3><form onSubmit={submit}><fieldset disabled={action.busy} className="form-grid"><CompetitionSelect required items={competitions} value={form.competitionId} onChange={value => setForm({ ...form, competitionId: value })} /><label>Chủ đề<input name="topic" value={form.topic} onChange={change} required maxLength={120} /></label><Difficulty value={form.difficulty} onChange={value => setForm({ ...form, difficulty: value })} /><label>Đáp án đúng<select name="correctAnswer" value={form.correctAnswer} onChange={change}>{['A', 'B', 'C', 'D'].map(letter => <option key={letter}>{letter}</option>)}</select></label><label className="span-all">Nội dung câu hỏi<textarea name="content" value={form.content} onChange={change} rows={3} required /></label>{['A', 'B', 'C', 'D'].map(letter => <label key={letter}>Lựa chọn {letter}<textarea name={`option${letter}`} value={form[`option${letter}`]} onChange={change} rows={2} required /></label>)}<div className="actions span-all"><button>{id ? 'Lưu câu hỏi' : 'Thêm câu hỏi'}</button>{id && <button type="button" className="secondary" onClick={() => { setId(null); setForm(blankQuestion); }}>Hủy chỉnh sửa</button>}</div></fieldset></form>
    <h3>Nhập câu hỏi từ Excel</h3><p className="section-note">Dùng mẫu .xlsx, tối đa 500 câu hỏi. Nếu có dòng không hợp lệ, toàn bộ tệp sẽ chưa được lưu.</p><form onSubmit={event => { event.preventDefault(); action.run(async () => { const body = new FormData(); body.append('file', file); const payload = await api(`/manage/questions/import?competitionId=${importCompetition}`, { token, body }); reload(); return payload; }, 'Đã nhập các câu hỏi từ tệp Excel.'); }}><fieldset disabled={action.busy} className="form-grid"><CompetitionSelect required items={competitions} value={importCompetition} onChange={setImportCompetition} /><label>Tệp Excel<input type="file" accept=".xlsx" onChange={event => setFile(event.target.files?.[0] || null)} required /></label><div className="actions span-all"><button disabled={!file || !importCompetition}>Nhập câu hỏi</button><button type="button" className="secondary" onClick={() => action.run(() => downloadFile('/manage/questions/template', token, 'mau-ngan-hang-cau-hoi.xlsx'), 'Đã tải mẫu Excel.')}>Tải mẫu Excel</button></div></fieldset></form><Notice {...action} />
  </section>;
}

function ExamBuilder({ token, competitions }) {
  const [form, setForm] = useState({ competitionId: '', count: 10, topic: '', difficulty: '', quantity: 1 });
  const [preview, setPreview] = useState([]);
  const [previewCompetition, setPreviewCompetition] = useState('');
  const [refresh, setRefresh] = useState(0);
  const action = useAction();
  const resource = useResource(form.competitionId ? `/manage/exams?competitionId=${form.competitionId}` : null, token, refresh);
  const change = (key, value) => { setForm({ ...form, [key]: value }); setPreview([]); };
  return <section className="content-section"><h2>Tạo đề thi từ ngân hàng</h2><p className="section-note">Chọn tiêu chí, xem trước câu hỏi rồi xác nhận lưu. Mỗi lượt làm bài sẽ được hệ thống chọn ngẫu nhiên một đề đã tạo.</p><form onSubmit={event => { event.preventDefault(); action.run(async () => { const payload = await api('/manage/exams/preview', { token, body: { ...form, competitionId: Number(form.competitionId), count: Number(form.count), quantity: Number(form.quantity) } }); setPreview(payload.items); setPreviewCompetition(form.competitionId); }, 'Đã tạo bản xem trước. Kiểm tra nội dung và xác nhận lưu.'); }}><fieldset className="form-grid" disabled={action.busy}><CompetitionSelect required items={competitions} value={form.competitionId} onChange={value => change('competitionId', value)} /><label>Số câu / đề<input type="number" min={1} max={500} value={form.count} onChange={event => change('count', event.target.value)} required /></label><label>Số đề cần tạo<input type="number" min={1} max={20} value={form.quantity} onChange={event => change('quantity', event.target.value)} required /></label><label>Chủ đề (để trống lấy tất cả)<input value={form.topic} onChange={event => change('topic', event.target.value)} maxLength={120} /></label><Difficulty all value={form.difficulty} onChange={value => change('difficulty', value)} /><div className="actions"><button>Tạo bản xem trước</button></div></fieldset></form><Notice {...action} />
    {preview.length > 0 && <div className="preview-list">{preview.map((exam, index) => <details key={index} open={index === 0}><summary>Đề {index + 1} · {exam.questions.length} câu hỏi</summary><label>Tên đề<input value={exam.name} onChange={event => setPreview(preview.map((item, position) => position === index ? { ...item, name: event.target.value } : item))} maxLength={255} required /></label><ol>{exam.questions.map(question => <li key={question.id}><p className="question-content">{question.content}</p>{['A', 'B', 'C', 'D'].map(letter => <p key={letter}>{letter}. {question[`option${letter}`]} {question.correctAnswer === letter && <strong>✓</strong>}</p>)}</li>)}</ol></details>)}<div className="actions"><button disabled={action.busy || preview.some(item => !item.name.trim())} onClick={() => action.run(async () => { await api('/manage/exams', { token, body: { competitionId: Number(previewCompetition), items: preview.map(exam => ({ name: exam.name, questionIds: exam.questions.map(question => Number(question.id)) })) } }); setPreview([]); setRefresh(value => value + 1); }, 'Đã lưu và xuất bản các đề thi.')}>Xác nhận lưu {preview.length} đề thi</button><button className="secondary" disabled={action.busy} onClick={() => setPreview([])}>Bỏ bản xem trước</button></div></div>}
    <h3>Đề đã tạo</h3>{!form.competitionId ? <p className="empty-state">Chọn kỳ thi để xem các đề đã tạo.</p> : <ResourceState resource={resource} empty={!resource.data?.items?.length}><Table headings={['Mã đề', 'Tên đề', 'Số câu', 'Trạng thái']}>{resource.data?.items?.map(item => <tr key={item.id}><td>{item.code}</td><td>{item.name}</td><td>{item.questionCount}</td><td>{item.isPublished ? 'Đã xuất bản' : 'Bản nháp'}</td></tr>)}</Table></ResourceState>}
  </section>;
}

function Candidates({ token, competitions, units }) {
  const [filters, setFilters] = useState({ competitionId: '', q: '', unitId: '' });
  const [query, setQuery] = useState(filters);
  const [page, setPage] = useState(1);
  const resource = useResource(`/manage/candidates?${queryString({ ...query, page })}`, token);
  return <section className="content-section"><h2>Danh sách thí sinh</h2><form className="form-grid filters" onSubmit={event => { event.preventDefault(); setQuery({ ...filters }); setPage(1); }}><CompetitionSelect items={competitions} value={filters.competitionId} onChange={value => setFilters({ ...filters, competitionId: value })} /><label>Tên, điện thoại hoặc email<input value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} /></label><label>Đơn vị<select value={filters.unitId} onChange={event => setFilters({ ...filters, unitId: event.target.value })}><option value="">Tất cả đơn vị</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.ten}</option>)}</select></label><button>Tìm kiếm</button></form><ResourceState resource={resource} empty={!resource.data?.items?.length}><Table headings={['Họ và tên', 'Liên hệ', 'Đơn vị', 'Kỳ thi', 'Đăng ký']}>{resource.data?.items?.map((item, index) => <tr key={`${item.id}-${index}`}><td>{item.hoten}</td><td>{item.dienthoai}<br />{item.email}</td><td>{item.unitName || '—'}</td><td>{item.competitionName || 'Chưa đăng ký kỳ thi'}</td><td>{formatDate(item.registeredAt)}</td></tr>)}</Table></ResourceState><Pagination data={resource.data} page={page} onChange={setPage} /></section>;
}

function AccessFields({ form, setForm, competitions, creating }) {
  const toggle = (key, value) => setForm({ ...form, [key]: form[key].includes(value) ? form[key].filter(item => item !== value) : [...form[key], value] });
  return <><label>Vai trò<select value={form.role} onChange={event => setForm({ ...form, role: event.target.value })}><option value="candidate">Thí sinh</option><option value="teacher">Giảng viên</option>{!creating && <option value="admin">Quản trị viên</option>}</select></label>{!creating && <label className="checkbox-label"><input type="checkbox" checked={form.is_active} onChange={event => setForm({ ...form, is_active: event.target.checked })} />Tài khoản được hoạt động</label>}
    {form.role === 'teacher' && <><fieldset className="checkbox-group span-all"><legend>Quyền chức năng</legend>{Object.entries(permissionNames).map(([key, label]) => <label key={key}><input type="checkbox" checked={form.permissions.includes(key)} onChange={() => toggle('permissions', key)} />{label}</label>)}</fieldset><fieldset className="checkbox-group span-all"><legend>Kỳ thi được phân công</legend>{competitions.length ? competitions.map(item => <label key={item.id}><input type="checkbox" checked={form.competitionIds.includes(String(item.id))} onChange={() => toggle('competitionIds', String(item.id))} />{item.name}</label>) : <p>Hãy tạo kỳ thi trước khi phân công.</p>}</fieldset></>}
  </>;
}

function Users({ token, competitions, units, currentUser }) {
  const initial = { hoten: '', dienthoai: '', email: '', donviID: '', role: 'teacher', permissions: [], competitionIds: [], is_active: true };
  const [form, setForm] = useState(initial);
  const [editing, setEditing] = useState(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [temporary, setTemporary] = useState(null);
  const action = useAction();
  const users = useResource(`/manage/users?${queryString({ q: query, page })}`, token, refresh);
  const requests = useResource('/manage/password-requests', token, refresh);
  const reload = () => setRefresh(value => value + 1);
  async function submit(event) {
    event.preventDefault(); setTemporary(null);
    await action.run(async () => {
      const access = { role: form.role, permissions: form.role === 'teacher' ? form.permissions : [], competitionIds: form.role === 'teacher' ? numericIds(form.competitionIds) : [], is_active: form.is_active };
      const payload = await api(editing ? `/manage/users/${editing.id}/access` : '/manage/users', { token, method: editing ? 'PUT' : 'POST', body: editing ? access : { ...form, ...access, donviID: form.donviID ? Number(form.donviID) : null } });
      if (payload.temporaryPassword) setTemporary({ name: form.hoten || editing?.hoten, password: payload.temporaryPassword });
      setEditing(null); setForm(initial); reload();
    }, editing ? 'Đã lưu vai trò và quyền truy cập.' : 'Đã cấp tài khoản. Vui lòng bàn giao mật khẩu tạm thời cho đúng người nhận.');
  }
  function resetPassword(user, requestId) {
    if (!window.confirm(`Đã xác minh danh tính của ${user.hoten}? Tạo mật khẩu tạm thời sẽ thu hồi mọi phiên đăng nhập của tài khoản này.`)) return;
    setTemporary(null); action.run(async () => { const payload = await api(`/manage/users/${user.userId || user.id}/reset-password`, { token, body: requestId ? { requestId } : {} }); setTemporary({ name: user.hoten, password: payload.temporaryPassword }); reload(); }, 'Đã đặt mật khẩu tạm thời. Người dùng bắt buộc đổi mật khẩu khi đăng nhập.');
  }
  return <section className="content-section"><h2>Tài khoản và phân quyền</h2><form className="form-grid filters" onSubmit={event => { event.preventDefault(); setQuery(q); setPage(1); }}><label>Tìm tài khoản<input value={q} onChange={event => setQ(event.target.value)} placeholder="Tên, số điện thoại hoặc email" /></label><button>Tìm kiếm</button></form><ResourceState resource={users} empty={!users.data?.items?.length}><Table headings={['Tài khoản', 'Vai trò', 'Quyền', 'Trạng thái', 'Thao tác']}>{users.data?.items?.map(item => <tr key={item.id}><td><strong>{item.hoten}</strong>{String(item.id) === String(currentUser.id) && ' (bạn)'}<br />{item.dienthoai}<br />{item.email}</td><td>{roleNames[item.role]}</td><td>{item.role === 'admin' ? 'Toàn quyền' : item.permissions?.map(key => permissionNames[key]).join(', ') || '—'}</td><td>{Number(item.is_active) ? 'Hoạt động' : 'Đã khóa'}{Number(item.must_change_password) ? ' · Cần đổi mật khẩu' : ''}</td><td><div className="table-actions"><button className="secondary" disabled={action.busy} onClick={() => { setEditing(item); setForm({ ...initial, ...item, permissions: item.permissions || [], competitionIds: (item.competitionIds || []).map(String), is_active: Boolean(Number(item.is_active)) }); setTemporary(null); }}>Phân quyền</button><button className="secondary" disabled={action.busy} onClick={() => resetPassword(item)}>Đặt lại mật khẩu</button></div></td></tr>)}</Table></ResourceState>
    <Pagination data={users.data} page={page} onChange={setPage} />
    <h3>{editing ? `Phân quyền: ${editing.hoten}` : 'Cấp tài khoản mới'}</h3><form onSubmit={submit}><fieldset className="form-grid" disabled={action.busy}>{!editing && <>{[['hoten', 'Họ và tên', 'text'], ['dienthoai', 'Số điện thoại', 'tel'], ['email', 'Email', 'email']].map(([key, label, type]) => <label key={key}>{label}<input type={type} value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} required maxLength={key === 'dienthoai' ? 30 : 255} /></label>)}<label>Đơn vị<select value={form.donviID || ''} onChange={event => setForm({ ...form, donviID: event.target.value })}><option value="">Chưa chọn đơn vị</option>{units.map(unit => <option value={unit.id} key={unit.id}>{unit.ten}</option>)}</select></label></>}
      <AccessFields form={form} setForm={setForm} competitions={competitions} creating={!editing} /><div className="actions span-all"><button>{editing ? 'Lưu phân quyền' : 'Cấp tài khoản'}</button>{editing && <button type="button" className="secondary" onClick={() => { setEditing(null); setForm(initial); }}>Hủy chỉnh sửa</button>}</div></fieldset></form><Notice {...action} />
    {temporary && <div className="temporary-secret" role="status"><h3>Mật khẩu tạm thời của {temporary.name}</h3><p>Chỉ hiển thị tại đây trong thao tác này. Giao trực tiếp cho người dùng sau khi xác minh danh tính.</p><code>{temporary.password}</code><div className="actions"><button onClick={() => setTemporary(null)}>Đã ghi nhận, ẩn mật khẩu</button></div></div>}
    <h3>Yêu cầu hỗ trợ quên mật khẩu</h3><ResourceState resource={requests} empty={!requests.data?.items?.length}><Table headings={['Người yêu cầu', 'Liên hệ', 'Ngày gửi', 'Trạng thái', 'Xử lý']}>{requests.data?.items?.map(item => <tr key={item.id}><td>{item.hoten}</td><td>{item.dienthoai}<br />{item.email}</td><td>{formatDate(item.createdAt)}</td><td>{item.status === 'pending' ? 'Chờ xác minh' : 'Đã xử lý'}</td><td>{item.status === 'pending' && <button disabled={action.busy} onClick={() => resetPassword(item, item.id)}>Xác minh và cấp mật khẩu</button>}</td></tr>)}</Table></ResourceState>
  </section>;
}

function SiteEditor({ token, onChanged }) {
  const resource = useResource('/site', token);
  const [form, setForm] = useState(null);
  const action = useAction();
  const data = form || resource.data?.item || { title: '', description: '', bannerUrl: '', newsUrl: '', newsTitle: '' };
  const change = (key, value) => setForm({ ...data, [key]: value });
  async function upload(file, kind) {
    if (!file) return;
    await action.run(async () => { if (file.size > 5 * 1024 * 1024) throw new Error('Tệp phải có dung lượng tối đa 5 MB.'); const body = new FormData(); body.append('file', file); body.append('kind', kind); const payload = await api('/manage/assets', { token, body }); setForm(current => ({ ...(current || data), [kind === 'banner' ? 'bannerUrl' : 'newsUrl']: payload.item.url, ...(kind === 'news' ? { newsTitle: (current || data).newsTitle || payload.item.name } : {}) })); }, 'Đã tải tệp lên. Bấm Áp dụng để cập nhật trang công khai.');
  }
  return <section className="content-section"><h2>Giao diện và tài liệu công bố</h2><ResourceState resource={resource}><form onSubmit={event => { event.preventDefault(); action.run(async () => { await api('/manage/site', { token, method: 'PUT', body: data }); onChanged(); }, 'Đã áp dụng giao diện và tài liệu công khai.'); }}><fieldset className="form-grid" disabled={action.busy}><label className="span-all">Tiêu đề cổng thi<input value={data.title || ''} onChange={event => change('title', event.target.value)} maxLength={255} required /></label><label className="span-all">Nội dung giới thiệu<textarea value={data.description || ''} onChange={event => change('description', event.target.value)} rows={3} /></label><label>Ảnh banner (tối đa 5 MB)<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => upload(event.target.files?.[0], 'banner')} /></label><label>Tệp tin tức / thể lệ (tối đa 5 MB)<input type="file" accept=".pdf,.txt,.docx" onChange={event => upload(event.target.files?.[0], 'news')} /></label><label className="span-all">Tên tài liệu công bố<input value={data.newsTitle || ''} onChange={event => change('newsTitle', event.target.value)} maxLength={255} /></label>
      {data.bannerUrl && <div className="span-all"><img className="banner-preview" src={assetUrl(data.bannerUrl)} alt="Xem trước banner sẽ áp dụng" /><button type="button" className="text-button" onClick={() => change('bannerUrl', '')}>Gỡ banner</button></div>}{data.newsUrl && <div className="span-all"><a href={assetUrl(data.newsUrl)} target="_blank" rel="noreferrer">Xem tài liệu đã chọn</a> <button type="button" className="text-button" onClick={() => setForm({ ...data, newsUrl: '', newsTitle: '' })}>Gỡ tài liệu</button></div>}
      <div className="actions span-all"><button>Áp dụng lên trang công khai</button><button type="button" className="secondary" onClick={() => setForm(null)}>Bỏ thay đổi chưa áp dụng</button></div></fieldset></form></ResourceState><Notice {...action} /></section>;
}

function Units({ token }) {
  const [form, setForm] = useState({ ten: '', organizationName: '' });
  const [refresh, setRefresh] = useState(0);
  const resource = useResource('/manage/units', token, refresh);
  const action = useAction();
  return <section className="content-section"><h2>Đơn vị đăng ký</h2><p className="section-note">Thêm đơn vị thực tế của ban tổ chức. Danh mục này dùng khi đăng ký tài khoản và thống kê.</p><form onSubmit={event => { event.preventDefault(); action.run(async () => { await api('/manage/units', { token, body: form }); setForm({ ten: '', organizationName: '' }); setRefresh(value => value + 1); }, 'Đã thêm đơn vị.'); }}><fieldset className="form-grid" disabled={action.busy}><label>Tên đơn vị<input value={form.ten} onChange={event => setForm({ ...form, ten: event.target.value })} required maxLength={255} /></label><label>Đoàn cơ sở<input value={form.organizationName} onChange={event => setForm({ ...form, organizationName: event.target.value })} maxLength={255} /></label><div className="actions"><button>Thêm đơn vị</button></div></fieldset></form><Notice {...action} /><ResourceState resource={resource} empty={!resource.data?.items?.length}><Table headings={['Đơn vị', 'Đoàn cơ sở']}>{resource.data?.items?.map(item => <tr key={item.id}><td>{item.ten}</td><td>{item.organizationName || '—'}</td></tr>)}</Table></ResourceState></section>;
}
