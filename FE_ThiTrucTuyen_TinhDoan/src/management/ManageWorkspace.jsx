import { useEffect, useRef, useState } from 'react';
import { api, assetUrl, downloadFile } from '../shared/api';
import { CompetitionSelect, DateFilters, Notice, Pagination, ResourceState, Table, formatDate, queryString, roleNames, statusNames, useAction, useResource } from '../shared/ui';

// Không gian quản trị dùng chung cho quản trị viên và giảng viên theo quyền được cấp.
const permissionNames = { questions: 'Ngân hàng câu hỏi', exams: 'Tạo đề thi', candidates: 'Danh sách thí sinh', reports: 'Thống kê, xuất báo cáo' };
const difficultyNames = { easy: 'Dễ', medium: 'Trung bình', hard: 'Khó' };
const blankQuestion = { roundId: '', competitionId: '', content: '', optionA: '', optionB: '', optionC: '', optionD: '', correctAnswer: 'A', difficulty: 'medium', points: 1 };
const blankCompetition = { name: '', description: '', maxAttempts: 1, startAt: '', endAt: '', status: 'draft' };
const localDate = value => { if (!value) return ''; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const formatRoundDuration = value => {
  const seconds = Number(value || 0);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
// Khi nh?p, hai ch? s? ??u l? ph?t; d?u hai ch?m xu?t hi?n ngay sau ?? ?? nh?p gi?y.
const formatRoundDurationTyping = value => {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 4);
  if (!digits) return '';
  if (digits.length === 1) return digits;
  if (digits.length === 2) return `${digits}:`;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
};
// Khi r?i ? nh?p, c?c ph?n ch?a g? ???c ho?n thi?n b?ng 00 ?? g?i ??ng ??nh d?ng ph?t:gi?y.
const completeRoundDuration = value => {
  const [minutes = '', seconds = ''] = String(value || '').split(':');
  const minuteText = String(minutes).replace(/\D/g, '').slice(0, 2);
  const secondText = String(seconds).replace(/\D/g, '').slice(0, 2);
  if (!minuteText) return '';
  return `${minuteText.padStart(2, '0')}:${secondText.padEnd(2, '0')}`;
};
const parseRoundDuration = value => {
  const match = String(value || '').trim().match(/^(\d{1,3}):([0-5]\d)$/);
  if (!match) throw new Error('Thời lượng phải có định dạng phút:giây, ví dụ 30:00.');
  const seconds = Number(match[1]) * 60 + Number(match[2]);
  if (seconds < 1 || seconds > 36_000) throw new Error('Thời lượng vòng thi phải từ 00:01 đến 600:00.');
  return seconds;
};
const ensureScheduleLongerSeconds = (startAt, endAt, durationSeconds, label) => {
  if (Date.parse(endAt) - Date.parse(startAt) <= Number(durationSeconds) * 1_000) throw new Error(`Thời gian diễn ra ${label} phải lớn hơn thời lượng làm bài.`);
};
// Không cho phép lưu lịch có khoảng diễn ra không đủ để hoàn thành một lượt làm bài.
const ensureScheduleLonger = (startAt, endAt, durationMinutes, label) => {
  if (Date.parse(endAt) - Date.parse(startAt) <= Number(durationMinutes) * 60_000) throw new Error(`Thời gian diễn ra ${label} phải lớn hơn thời lượng làm bài.`);
};
// So sánh các giá trị nhập cùng múi giờ thiết bị để tránh ràng buộc datetime-local bị lệch khi API trả về UTC.
const ensureRoundInsideCompetition = (roundStart, roundEnd, competitionStart, competitionEnd) => {
  if (Date.parse(roundStart) < Date.parse(competitionStart) || Date.parse(roundEnd) > Date.parse(competitionEnd)) throw new Error('Thời gian vòng thi phải nằm trong thời gian của kỳ thi.');
};
// V?ng sau ch? ???c b?t ??u khi v?ng li?n tr??c ?? k?t th?c; s?a l?ch c?ng kh?ng ???c ch?ng l?n v?ng k? ti?p.
const ensureRoundSequence = (roundStart, roundEnd, roundNumber, rounds, currentRoundId) => {
  const others = rounds.filter(item => String(item.id) !== String(currentRoundId));
  const previous = others.filter(item => Number(item.roundNumber) < Number(roundNumber)).sort((left, right) => Number(right.roundNumber) - Number(left.roundNumber))[0];
  const next = others.filter(item => Number(item.roundNumber) > Number(roundNumber)).sort((left, right) => Number(left.roundNumber) - Number(right.roundNumber))[0];
  if (previous && Date.parse(roundStart) <= Date.parse(previous.endAt)) throw new Error('V\u00f2ng sau ph\u1ea3i b\u1eaft \u0111\u1ea7u sau khi v\u00f2ng tr\u01b0\u1edbc k\u1ebft th\u00fac.');
  if (next && Date.parse(roundEnd) >= Date.parse(next.startAt)) throw new Error('V\u00f2ng n\u00e0y ph\u1ea3i k\u1ebft th\u00fac tr\u01b0\u1edbc khi v\u00f2ng ti\u1ebfp theo b\u1eaft \u0111\u1ea7u.');
};

// Tách ngày, giờ và phút để luôn hiển thị giờ 24 giờ, không phụ thuộc lựa chọn SA/CH của trình duyệt.
function DateTime24Input({ value, onChange, required = false, min, max }) {
  const [date = '', time = ''] = String(value || '').split('T');
  const [hour = '', minute = ''] = time.split(':');
  // Khi chọn ngày trước, đặt tạm 00:00 để giá trị không bị xóa khỏi ô ngày.
  const update = (nextDate = date, nextHour = hour, nextMinute = minute) => onChange(nextDate ? `${nextDate}T${nextHour || '00'}:${nextMinute || '00'}` : '');
  return <span className="datetime-24"><input aria-label="Ngày" type="date" value={date} min={min ? localDate(min).slice(0, 10) : undefined} max={max ? localDate(max).slice(0, 10) : undefined} onChange={event => update(event.target.value)} required={required} /><select aria-label="Giờ" value={hour} onChange={event => update(date, event.target.value)} required={required}><option value="">Giờ</option>{Array.from({ length: 24 }, (_, item) => String(item).padStart(2, '0')).map(item => <option key={item} value={item}>{item}</option>)}</select><span aria-hidden="true">:</span><select aria-label="Phút" value={minute} onChange={event => update(date, hour, event.target.value)} required={required}><option value="">Phút</option>{Array.from({ length: 60 }, (_, item) => String(item).padStart(2, '0')).map(item => <option key={item} value={item}>{item}</option>)}</select></span>;
}
const numericIds = values => values.map(Number);
function RoundSelect({token,competitionId,value,onChange}) {
  // Mỗi thao tác với ngân hàng câu hỏi và đề thi phải chọn một vòng cụ thể.
  const resource=useResource(competitionId?`/manage/competitions/${competitionId}/rounds`:null,token);
  const items=(resource.data?.items||[]).filter(item=>item.enabled);
  const unavailable = !competitionId || resource.loading || Boolean(resource.error) || !items.length;
  const placeholder = !competitionId ? 'Chọn kỳ thi trước' : resource.loading ? 'Đang tải vòng thi…' : resource.error ? 'Không tải được vòng thi' : items.length ? 'Chọn vòng thi' : 'Kỳ thi chưa có vòng được cấu hình';
  return <label>Vòng thi<select name="roundId" value={value||''} onChange={event=>onChange(event.target.value)} required={items.length>0} disabled={unavailable}><option value="">{placeholder}</option>{items.map(item=><option key={item.id} value={item.id}>{item.roundNumber}. {item.name}</option>)}</select>{competitionId&&!resource.loading&&!resource.error&&!items.length&&<span className="form-note">Chưa có vòng thi phù hợp với kỳ thi đã chọn.</span>}{resource.error&&<span role="alert">{resource.error}</span>}</label>;
}

// Hiển thị kỳ thi và vòng đang cấu hình để các màn hình sau không yêu cầu chọn lại.
function ConfigurationTrail({ configuration }) {
  if (!configuration) return null;
  return <div className="configuration-trail" role="status"><strong>{configuration.competitionName}</strong>{configuration.roundId && <><span>›</span><span>Vòng thứ {configuration.roundNumber}: {configuration.roundName}</span></>}</div>;
}

// Chuyển giữa các vòng của cùng một kỳ thi mà không bắt người dùng chọn lại kỳ thi.
function ConfigurationRoundNavigation({ token, configuration, onConfigure, target }) {
  const rounds = useResource(configuration ? `/manage/competitions/${configuration.competitionId}/rounds` : null, token);
  const items = rounds.data?.items || [];
  if (!configuration || !items.length) return null;
  const currentIndex = items.findIndex(item => String(item.id) === String(configuration.roundId));
  const choose = round => onConfigure({ id: configuration.competitionId, name: configuration.competitionName }, round, target);
  return <div className="round-switcher" aria-label="Chuyển vòng thi"><span>Đang cập nhật:</span><div>{items.map(round => <button type="button" key={round.id} className={String(round.id) === String(configuration.roundId) ? 'active' : ''} onClick={() => choose(round)}>Vòng {round.roundNumber}: {round.name}</button>)}</div>{currentIndex > 0 && <button type="button" className="secondary" onClick={() => choose(items[currentIndex - 1])}>← Vòng trước</button>}{currentIndex >= 0 && currentIndex < items.length - 1 && <button type="button" className="secondary" onClick={() => choose(items[currentIndex + 1])}>Vòng tiếp theo →</button>}</div>;
}

// Thẻ vòng gom lịch, giới hạn và thao tác cấu hình vào một nơi dễ quét hơn bảng nhiều cột.
function RoundCards({ rounds, onEdit, onRankings, onConfigure, onDelete }) {
  return <div className="round-card-list">{rounds.map(round => <article className="round-card" key={round.id}><div className="round-card-heading"><div><p className="round-order">Vòng thứ {round.roundNumber}</p><h4>{round.name}</h4></div><span className={`round-state ${round.finalizedAt ? 'complete' : ''}`}>{round.finalizedAt ? 'Đã chốt' : 'Đang cấu hình'}</span></div><dl className="round-meta"><div><dt>Lịch thi</dt><dd>{formatDate(round.startAt)}<br />{formatDate(round.endAt)}</dd></div><div><dt>Thời lượng</dt><dd>{formatRoundDuration(round.durationSeconds ?? Number(round.durationMinutes) * 60)}</dd></div><div><dt>Điều kiện</dt><dd>{Number(round.advanceCount) ? `Top ${round.advanceCount}` : 'Không giới hạn Top'}</dd></div></dl><div className="round-card-actions"><button type="button" onClick={() => onConfigure(round, 'questions')}>Câu hỏi</button><button type="button" onClick={() => onConfigure(round, 'exams')}>Tạo đề</button><button type="button" className="secondary" onClick={() => onEdit(round)}>Sửa</button><button type="button" className="secondary" onClick={() => onRankings(round)}>Xếp hạng</button><button type="button" className="danger" onClick={() => onDelete(round)}>Xóa</button></div></article>)}</div>;
}

// Mỗi thẻ tổng quan tự đọc số câu hỏi và đề của chính vòng đó để hướng người dùng đến bước còn thiếu.
function SetupRoundCard({ token, competition, round, onChoose, onEdit, onDelete }) {
  const questions = useResource(`/manage/questions?${queryString({ competitionId: competition.id, roundId: round.id, page: 1, pageSize: 1 })}`, token);
  const exams = useResource(`/manage/exams?${queryString({ competitionId: competition.id, roundId: round.id })}`, token);
  const questionCount = Number(questions.data?.total || 0), examCount = exams.data?.items?.length || 0;
  const loading = questions.loading || exams.loading;
  const next = !questionCount ? 'questions' : !examCount ? 'exams' : null;
  return <article className="setup-round-card"><div><p className="round-order">Vòng thứ {round.roundNumber}</p><h4>{round.name}</h4><p>{formatDate(round.startAt)} → {formatDate(round.endAt)}</p><dl className="setup-round-details"><div><dt>Thời lượng thi</dt><dd>{formatRoundDuration(round.durationSeconds ?? Number(round.durationMinutes) * 60)}</dd></div><div><dt>Đi tiếp</dt><dd>{Number(round.advanceCount) ? `Top ${round.advanceCount} thí sinh` : 'Không giới hạn Top'}</dd></div></dl></div><div className="setup-checks"><span className={questionCount ? 'done' : ''}>{loading ? 'Đang kiểm tra câu hỏi…' : questionCount ? `✓ ${questionCount} câu hỏi` : '! Chưa có câu hỏi'}</span><span className={examCount ? 'done' : ''}>{loading ? 'Đang kiểm tra đề…' : examCount ? `✓ ${examCount} đề thi` : '! Chưa có đề thi'}</span></div><div className="actions">{next ? <button onClick={() => onChoose(round, next)}>{next === 'questions' ? 'Thêm câu hỏi' : 'Tạo đề'}</button> : <button className="secondary" onClick={() => onChoose(round, 'questions')}>Câu hỏi</button>}<button className="secondary" onClick={() => onChoose(round, 'exams')}>Tạo đề</button><button className="secondary" onClick={() => onEdit(round)}>Sửa vòng</button><button className="danger" onClick={() => onDelete(round)}>{'X\u00f3a v\u00f2ng'}</button></div></article>;
}

// Biểu mẫu dùng ngay trong trình thiết lập để không điều hướng sang một màn hình quản lý khác.
function SetupRoundEditor({ token, competition, round, nextNumber, rounds, onSaved, onCancel }) {
  const [form, setForm] = useState(() => {
    // V?ng ??u ti?n m?c ??nh b?t ??u c?ng l?c k? thi, nh?ng qu?n tr? vi?n v?n c? th? ch?nh s?a.
    const defaultStartAt = !round && nextNumber === 1 ? localDate(competition.startAt) : '';
    return { name: round?.name || '', duration: formatRoundDuration(round?.durationSeconds ?? Number(round?.durationMinutes || 30) * 60), advanceCount: round?.advanceCount || 0, roundNumber: round?.roundNumber || nextNumber, startAt: localDate(round?.startAt) || defaultStartAt, endAt: localDate(round?.endAt) };
  });
  const action = useAction();
  // Cap nhat truc tiep truong dang nhap; khong dung state cua man hinh tao de thi o day.
  const change = event => setForm({ ...form, [event.target.name]: event.target.value });
  const submit = event => { event.preventDefault(); action.run(async () => { const durationSeconds = parseRoundDuration(form.duration); ensureScheduleLongerSeconds(form.startAt, form.endAt, durationSeconds, 'vòng thi'); ensureRoundInsideCompetition(form.startAt, form.endAt, competition.startAt, competition.endAt); ensureRoundSequence(form.startAt, form.endAt, form.roundNumber, rounds, round?.id); await api(`/manage/competitions/${competition.id}/rounds${round ? `/${round.id}` : ''}`, { token, method: round ? 'PUT' : 'POST', body: { ...form, durationSeconds, advanceCount: Number(form.advanceCount), roundNumber: Number(form.roundNumber), startAt: new Date(form.startAt).toISOString(), endAt: new Date(form.endAt).toISOString() } }); onSaved(); }, round ? 'Đã cập nhật vòng thi.' : 'Vòng thi đã được tạo, hãy cập nhật ngân hàng câu hỏi và tạo đề thi cho vòng.'); };
  return <form className="form-grid setup-editor" onSubmit={submit}><h3 className="span-all">{round ? `Sửa vòng thứ ${round.roundNumber}` : `Tạo vòng thứ ${nextNumber}`}</h3><label>Tên vòng thi<input name="name" value={form.name} onChange={change} required maxLength={255} /></label><label>{'Th\u1eddi l\u01b0\u1ee3ng (ph\u00fat:gi\u00e2y)'}<input name="duration" inputMode="numeric" pattern="[0-9]{2}:[0-5][0-9]" placeholder="30:00" value={form.duration} onChange={event => setForm({ ...form, duration: formatRoundDurationTyping(event.target.value) })} onBlur={event => setForm({ ...form, duration: completeRoundDuration(event.target.value) })} required /></label><label>Top thí sinh qua vòng<input name="advanceCount" type="number" min="0" value={form.advanceCount} onChange={change} required /></label><label>Bắt đầu vòng<DateTime24Input value={form.startAt} min={competition.startAt} max={competition.endAt} onChange={value => setForm({ ...form, startAt: value })} required /></label><label>Kết thúc vòng<DateTime24Input value={form.endAt} min={competition.startAt} max={competition.endAt} onChange={value => setForm({ ...form, endAt: value })} required /></label><div className="actions span-all"><button disabled={action.busy}>{round ? 'Lưu vòng thi' : 'Tạo vòng thi'}</button><button type="button" className="secondary" onClick={onCancel}>Hủy</button></div><Notice {...action} /></form>;
}

// Cho phép chỉnh thông tin kỳ thi tại bước đầu, không phải quay lại danh sách.
function CompetitionInfoEditor({ token, competition, onSaved, onCancel }) {
  const [form, setForm] = useState(() => ({ name: competition.name, description: competition.description || '', maxAttempts: competition.maxAttempts, startAt: localDate(competition.startAt), endAt: localDate(competition.endAt), status: competition.status }));
  const action = useAction();
  const change = event => setForm({ ...form, [event.target.name]: event.target.value });
  const submit = event => { event.preventDefault(); action.run(async () => { await api(`/manage/competitions/${competition.id}`, { token, method: 'PUT', body: { ...form, maxAttempts: Number(form.maxAttempts), startAt: new Date(form.startAt).toISOString(), endAt: new Date(form.endAt).toISOString() } }); onSaved(); }, 'Đã cập nhật thông tin kỳ thi.'); };
  return <form className="form-grid setup-editor" onSubmit={submit}><h3 className="span-all">Sửa thông tin kỳ thi</h3><label>Tên kỳ thi<input name="name" value={form.name} onChange={change} required maxLength={255} /></label><label>Số lượt làm bài / vòng<input name="maxAttempts" type="number" min="1" value={form.maxAttempts} onChange={change} required /></label><label>Trạng thái<select name="status" value={form.status} onChange={change}><option value="draft">Bản nháp</option><option value="published">Thông báo kỳ thi</option><option value="paused">Tạm đóng</option><option value="closed">Đóng</option></select></label><label>Bắt đầu kỳ thi<DateTime24Input value={form.startAt} onChange={value => setForm({ ...form, startAt: value })} required /></label><label>Kết thúc kỳ thi<DateTime24Input value={form.endAt} onChange={value => setForm({ ...form, endAt: value })} required /></label><label className="span-all">Mô tả<textarea name="description" rows="3" value={form.description} onChange={change} /></label><div className="actions span-all"><button disabled={action.busy}>Lưu thông tin kỳ thi</button><button type="button" className="secondary" onClick={onCancel}>Hủy</button></div><Notice {...action} /></form>;
}

// Trình hướng dẫn gom các bước cấu hình về một luồng thay vì buộc quản trị viên nhớ nhiều tab.
function CompetitionSetup({ token, competitions, configuration, onConfigure, onBack, onCompetitionChanged }) {
  const [step, setStep] = useState(configuration?.target || 'rounds');
  const [roundRefresh, setRoundRefresh] = useState(0);
  const [editingRound, setEditingRound] = useState(undefined);
  const [editingCompetition, setEditingCompetition] = useState(false);
  const publishAction = useAction();
  const roundAction = useAction();
  const rounds = useResource(configuration ? `/manage/competitions/${configuration.competitionId}/rounds` : null, token, roundRefresh);
  const competition = competitions.find(item => String(item.id) === String(configuration?.competitionId));
  useEffect(() => { if (configuration?.target) setStep(configuration.target); }, [configuration?.target, configuration?.roundId]);
  if (!configuration || !competition) return <section className="content-section"><p className="empty-state">Hãy chọn một kỳ thi và vòng thi để bắt đầu cấu hình.</p></section>;
  const steps = [['info', 'Thông tin kỳ thi'], ['rounds', 'Vòng thi'], ['questions', 'Câu hỏi'], ['exams', 'Đề thi'], ['ready', 'Sẵn sàng']];
  const chooseRound = (round, target) => onConfigure(competition, round, target);
  const selectedRound = rounds.data?.items?.find(item => String(item.id) === String(configuration.roundId));
  const showRoundEditor = editingRound !== undefined;
  const saveRound = () => { setEditingRound(undefined); setRoundRefresh(value => value + 1); };
  const deleteRound = round => {
    if (!window.confirm(`X\u00f3a v\u00f2ng th\u1ee9 ${round.roundNumber}: ${round.name}?`)) return;
    roundAction.run(async () => {
      await api(`/manage/competitions/${competition.id}/rounds/${round.id}`, { token, method: 'DELETE' });
      if (String(configuration.roundId) === String(round.id)) onConfigure(competition, null, 'rounds');
      setRoundRefresh(value => value + 1);
    }, '\u0110\u00e3 x\u00f3a v\u00f2ng thi.');
  };
  const publish = () => publishAction.run(async () => {
    const roundData = await api(`/manage/competitions/${competition.id}/rounds`, { token });
    if (!roundData.items?.length) throw new Error('Chưa có vòng thi. Hãy tạo ít nhất một vòng trước khi công bố.');
    for (const round of roundData.items) {
      const exams = await api(`/manage/exams?competitionId=${competition.id}&roundId=${round.id}`, { token });
      if (!exams.items?.length) throw new Error(`Vòng thứ ${round.roundNumber} chưa có đề thi. Hãy tạo đề trước khi công bố.`);
    }
    await api(`/manage/competitions/${competition.id}`, { token, method: 'PUT', body: { name: competition.name, description: competition.description || '', maxAttempts: competition.maxAttempts, startAt: competition.startAt, endAt: competition.endAt, status: 'published' } });
    onCompetitionChanged();
  }, 'Đã thông báo kỳ thi. Thí sinh có thể xem và đăng ký theo lịch thi.');
  return <section className="content-section setup-workspace"><div className="section-heading"><div><h2>Thiết lập kỳ thi</h2><ConfigurationTrail configuration={configuration} /></div><button className="secondary" onClick={onBack}>Quay lại danh sách kỳ thi</button></div><nav className="setup-steps" aria-label="Các bước cấu hình">{steps.map(([key, label], index) => <button key={key} className={step === key ? 'active' : ''} aria-current={step === key ? 'step' : undefined} onClick={() => setStep(key)}><span>{index + 1}</span>{label}</button>)}</nav>{step === 'info' && <div className="setup-intro"><h3>{competition.name}</h3><p>{competition.description || 'Chưa có mô tả kỳ thi.'}</p><dl><div><dt>Lịch kỳ thi</dt><dd>{formatDate(competition.startAt)} → {formatDate(competition.endAt)}</dd></div><div><dt>Lượt thi</dt><dd>{competition.maxAttempts} lượt mỗi vòng</dd></div></dl>{editingCompetition ? <CompetitionInfoEditor token={token} competition={competition} onSaved={() => { setEditingCompetition(false); onCompetitionChanged(); }} onCancel={() => setEditingCompetition(false)} /> : <div className="actions"><button onClick={() => setEditingCompetition(true)}>Sửa thông tin kỳ thi</button><button className="secondary" onClick={() => setStep('rounds')}>Tiếp tục cấu hình vòng thi</button></div>}</div>}{step === 'rounds' && <><div className="setup-step-heading"><div><h3>Vòng thi</h3><p>Hệ thống gợi ý bước cần hoàn thành tiếp theo cho từng vòng.</p></div><button type="button" onClick={() => setEditingRound(null)}>Thêm vòng thi</button></div>{showRoundEditor && <SetupRoundEditor key={editingRound?.id || 'new'} token={token} competition={competition} round={editingRound} nextNumber={Math.max(0, ...(rounds.data?.items || []).map(item => Number(item.roundNumber))) + 1} rounds={rounds.data?.items || []} onSaved={saveRound} onCancel={() => setEditingRound(undefined)} />}<ResourceState resource={rounds} empty={!rounds.data?.items?.length}><div className="setup-round-list">{rounds.data?.items?.map(round => <SetupRoundCard key={round.id} token={token} competition={competition} round={round} onChoose={chooseRound} onEdit={setEditingRound} onDelete={deleteRound} />)}</div></ResourceState><Notice {...roundAction} /></>}{step === 'questions' && <>{selectedRound ? <Questions token={token} competitions={competitions} configuration={configuration} onConfigure={onConfigure} /> : <p className="empty-state">Vui lòng chọn một vòng thi.</p>}</>}{step === 'exams' && <>{selectedRound ? <ExamBuilder token={token} competitions={competitions} configuration={configuration} onConfigure={onConfigure} /> : <p className="empty-state">Vui lòng chọn một vòng thi.</p>}</>}{step === 'ready' && <div className="setup-intro"><h3>Kiểm tra trước khi thông báo kỳ thi</h3><p>Hãy bảo đảm mỗi vòng đã có câu hỏi và ít nhất một đề thi được xuất bản. Sau đó thông báo kỳ thi trong phần quản lý kỳ thi.</p><div className="actions"><button className="secondary" onClick={() => setStep('rounds')}>Kiểm tra các vòng thi</button>{['draft', 'paused'].includes(competition.status) && <button disabled={publishAction.busy} onClick={publish}>Thông báo kỳ thi</button>}</div><Notice {...publishAction} /></div>}</section>;
}

// Bộ chọn độ khó dùng lại cho lọc câu hỏi và tạo đề.
function Difficulty({ value, onChange, all = false }) { return <label>Độ khó<select value={value} onChange={event => onChange(event.target.value)}>{all && <option value="">Tất cả</option>}{Object.entries(difficultyNames).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>; }

export default function ManageWorkspace({ user, token, units, onSiteChanged, onOpenReports }) {
  // Danh sách tab được tạo từ vai trò và các quyền mà tài khoản hiện tại được cấp.
  const isAdmin = user.role === 'admin';
  const allowed = permission => isAdmin || user.permissions?.includes(permission);
  // Ngữ cảnh được giữ khi đi từ một vòng sang ngân hàng câu hỏi hoặc tạo đề.
  const [configuration, setConfiguration] = useState(null);
  // Admin đi theo luồng cấu hình; chỉ tài khoản được phân quyền riêng mới thấy lối tắt độc lập.
  const tabs = [isAdmin && ['competitions', 'Kỳ thi, lịch thi'], configuration && ['setup', 'Thiết lập kỳ thi'], !isAdmin && allowed('questions') && ['questions', 'Ngân hàng câu hỏi'], !isAdmin && allowed('exams') && ['exams', 'Tạo đề thi'], allowed('candidates') && ['candidates', 'Thí sinh'], isAdmin && ['users', 'Tài khoản, phân quyền'], isAdmin && ['site', 'Giao diện, tài liệu'], isAdmin && ['units', 'Đơn vị']].filter(Boolean);
  const [tab, setTab] = useState(tabs[0]?.[0] || '');
  const [refresh, setRefresh] = useState(0);
  const competitions = useResource('/manage/competitions', token, refresh);
  const items = competitions.data?.items || [];
  const selected = tabs.some(([key]) => key === tab) ? tab : tabs[0]?.[0];
  const openConfiguration = (competition, round, target) => {
    // Có thể mở từ kỳ thi khi chưa chọn vòng; chỉ các bước câu hỏi và đề thi mới cần roundId.
    setConfiguration({ competitionId: String(competition.id), competitionName: competition.name, roundId: round ? String(round.id) : '', roundName: round?.name || '', roundNumber: round?.roundNumber || null, target });
    setTab('setup');
  };
  const props = { token, competitions: items, units, configuration, onConfigure: openConfiguration, onCompetitionChanged: () => setRefresh(value => value + 1), onViewReports: onOpenReports };
  return <section className="workspace"><nav className="tab-nav" aria-label="Chức năng quản lý">{tabs.map(([key, label]) => <button className={selected === key ? 'active' : ''} aria-pressed={selected === key} key={key} onClick={() => setTab(key)}>{label}</button>)}</nav>
    {!tabs.length && <p className="empty-state">Bạn chưa được cấp quyền quản lý. Vui lòng liên hệ quản trị viên.</p>}
    <Notice text={competitions.error} error />
    {selected === 'competitions' && <Competitions {...props} resource={competitions} onChanged={() => setRefresh(value => value + 1)} />}
    {selected === 'setup' && <CompetitionSetup {...props} onBack={() => setTab('competitions')} />}
    {selected === 'questions' && <Questions {...props} />}
    {selected === 'exams' && <ExamBuilder {...props} />}
    {selected === 'candidates' && <Candidates {...props} />}
    {selected === 'users' && <Users {...props} currentUser={user} />}
    {selected === 'site' && <SiteEditor token={token} onChanged={onSiteChanged} />}
    {selected === 'units' && <Units token={token} />}
  </section>;
}

function Competitions({ token, competitions, resource, onChanged, onConfigure, onViewReports }) {
  // Quản lý kỳ thi và các vòng thuộc kỳ thi đang được chọn.
  const [form, setForm] = useState(blankCompetition);
  const [id, setId] = useState(null);
  const [editingStatus, setEditingStatus] = useState('draft');
  // Khi kỳ thi đã được thông báo, biểu mẫu chỉ cho phép đổi trạng thái để quay về bản nháp.
  // Chỉ dùng biểu mẫu trạng thái khi quản trị viên bấm nút đổi trạng thái riêng.
  const statusOnly = Boolean(id && editingStatus === 'status-only');
  const [filters, setFilters] = useState({ from: '', to: '', q: '' });
  const [competitionTab, setCompetitionTab] = useState('current');
  const [competitionPage, setCompetitionPage] = useState(1);
  const [rankingPage, setRankingPage] = useState(1);
  // Tách biểu mẫu tạo kỳ thi khỏi khu vực theo dõi danh sách và lịch thi.
  const [competitionView, setCompetitionView] = useState('create');
  const [scrollTargetId, setScrollTargetId] = useState(null);
  const [createdCompetition, setCreatedCompetition] = useState(null);
  // Kỳ thi đã kết thúc cần xác nhận bằng chữ trước khi xóa toàn bộ dữ liệu liên quan.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const action = useAction();
    const [rounds, setRounds] = useState([]);
    const [ranking,setRanking]=useState(null);
    const [roundForm, setRoundForm] = useState({ name: '', durationMinutes: 30, advanceCount: 0, roundNumber: 1, startAt: '', endAt: '' });
    const [roundId, setRoundId] = useState(null);
  const change = event => setForm({ ...form, [event.target.name]: event.target.value });
  const reset = () => { setId(null); setEditingStatus('draft'); setForm(blankCompetition); };
  const returnToList = (competitionId, status = form.status, endAt = form.endAt) => {
    // Kỳ thi vừa đóng được chuyển sang tab đã kết thúc trước khi cuộn đến bản ghi của nó.
    setCompetitionTab(status === 'closed' || (endAt && Date.parse(endAt) <= Date.now()) ? 'ended' : 'current');
    setCompetitionPage(1);
    setCompetitionView('list');
    setScrollTargetId(String(competitionId));
    reset();
  };
  useEffect(() => {
    if (!scrollTargetId || competitionView !== 'list') return;
    const row = document.getElementById(`competition-row-${scrollTargetId}`);
    if (!row) return;
    const frame = requestAnimationFrame(() => row.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    setScrollTargetId(null);
    return () => cancelAnimationFrame(frame);
  }, [scrollTargetId, competitionView, competitions]);
    const resetRound = () => {
      // Ch? v?ng ??u ti?n k? th?a th?i ?i?m b?t ??u c?a k? thi; c?c v?ng sau do qu?n tr? vi?n ch?n.
      const isFirstRound = rounds.length === 0;
      setRoundId(null);
      setRoundForm({ name: '', durationMinutes: 30, advanceCount: 0, roundNumber: rounds.length + 1, startAt: isFirstRound ? localDate(form.startAt) : '', endAt: '' });
    };
  async function submit(event) {
    event.preventDefault();
    const creating = !id;
    const editedId = id;
    const nextStatus = form.status;
    const nextEndAt = form.endAt;
    await action.run(async () => {
      const result = await api(`/manage/competitions${id ? `/${id}` : ''}`, { token, method: id ? 'PUT' : 'POST', body: { ...form, status: creating ? 'draft' : form.status, maxAttempts: Number(form.maxAttempts), startAt: form.startAt ? new Date(form.startAt).toISOString() : null, endAt: form.endAt ? new Date(form.endAt).toISOString() : null } });
      reset(); onChanged();
      // Sau khi tạo, chuyển sang danh sách để quản trị viên mở ngay phần quản lý vòng.
      if (creating) setCreatedCompetition(result.item);
      else returnToList(editedId, nextStatus, nextEndAt);
    }, id ? (statusOnly ? 'Đã cập nhật trạng thái kỳ thi.' : 'Đã cập nhật kỳ thi và lịch thi.') : '');
  }
  // Giữ kỳ thi đã đóng hoặc hết lịch ở tab riêng; tab này luôn ưu tiên kỳ thi vừa kết thúc.
  // Bản nháp luôn ở khu vực đang quản lý để tiếp tục cấu hình, dù lịch dự kiến đã qua.
  const ended = item => item.status !== 'draft' && (item.status === 'closed' || (item.endAt && Date.parse(item.endAt) <= Date.now()));
  const filtered = competitions.filter(item => (!filters.q || item.name.toLocaleLowerCase('vi').includes(filters.q.toLocaleLowerCase('vi'))) && (!filters.from || Date.parse(item.endAt) >= Date.parse(`${filters.from}T00:00:00`)) && (!filters.to || Date.parse(item.startAt) <= Date.parse(`${filters.to}T23:59:59`)));
  const visible = filtered.filter(item => competitionTab === 'ended' ? ended(item) : !ended(item))
    .sort((left, right) => competitionTab === 'ended' ? Date.parse(right.endAt || 0) - Date.parse(left.endAt || 0) : 0);
  const pageSize = 10;
  const visiblePage = visible.slice((competitionPage - 1) * pageSize, competitionPage * pageSize);
  async function loadRounds(competitionId, competitionStartAt = form.startAt) {
    const payload = await api(`/manage/competitions/${competitionId}/rounds`, { token });
    const items = payload.items;
    const isFirstRound = items.length === 0;
    setRounds(items);
    setRanking(null);
    setRoundId(null);
    // Khi ch?a c? v?ng n?o, ?i?n s?n gi? m? k? thi ?? t?o v?ng 1 nhanh h?n.
    setRoundForm({ name: '', durationMinutes: 30, advanceCount: 0, roundNumber: Math.max(0, ...items.map(item => Number(item.roundNumber))) + 1, startAt: isFirstRound ? localDate(competitionStartAt) : '', endAt: '' });
  }
  async function saveRound(event) {
    event.preventDefault();
    await action.run(async () => {
      ensureScheduleLonger(roundForm.startAt, roundForm.endAt, roundForm.durationMinutes, 'vòng thi');
      ensureRoundInsideCompetition(roundForm.startAt, roundForm.endAt, form.startAt, form.endAt);
      ensureRoundSequence(roundForm.startAt, roundForm.endAt, roundForm.roundNumber, rounds, roundId);
      const path = `/manage/competitions/${id}/rounds${roundId ? `/${roundId}` : ''}`;
      await api(path, { token, method: roundId ? 'PUT' : 'POST', body: { ...roundForm, name: roundForm.name.trim(), advanceCount: Number(roundForm.advanceCount), durationMinutes: Number(roundForm.durationMinutes), roundNumber: Number(roundForm.roundNumber), startAt: new Date(roundForm.startAt).toISOString(), endAt: new Date(roundForm.endAt).toISOString() } });
      await loadRounds(id);
    }, roundId ? 'Đã cập nhật vòng thi.' : 'Vòng thi đã được tạo, hãy cập nhật ngân hàng câu hỏi và tạo đề thi cho vòng.');
  }
  async function removeCompetition(item, confirmation) {
    // Mọi trạng thái đều cần nhập chữ xác nhận vì thao tác xóa không thể khôi phục.
    if (String(confirmation || '').trim().toLocaleLowerCase('vi') !== 'xoa') return;
    await action.run(async () => {
      await api(`/manage/competitions/${item.id}`, { token, method: 'DELETE', body: { confirmation } });
      if (String(id) === String(item.id)) reset();
      setDeleteTarget(null);
      setDeleteConfirmation('');
      onChanged();
    }, 'Đã xóa kỳ thi và toàn bộ dữ liệu liên quan.');
  }
  return <section className="content-section"><nav className="tab-nav competition-tabs" aria-label="Quản lý kỳ thi"><button type="button" className={competitionView === 'create' ? 'active' : ''} aria-pressed={competitionView === 'create'} onClick={() => { setCompetitionView('create'); reset(); }}>Tạo kỳ thi</button><button type="button" className={competitionView === 'list' ? 'active' : ''} aria-pressed={competitionView === 'list'} onClick={() => setCompetitionView('list')}>Danh sách và lịch thi</button></nav><Notice {...action} />{createdCompetition && <div className="notice-modal-backdrop" role="presentation"><section className="notice-modal success-message" role="dialog" aria-modal="true" aria-labelledby="created-competition-title"><h2 id="created-competition-title">Đã tạo xong kỳ thi</h2><p>Bạn có muốn tiếp tục cấu hình kỳ thi ngay bây giờ không?</p><div className="actions"><button onClick={() => { const item = createdCompetition; setCreatedCompetition(null); onConfigure(item, null, 'info'); }}>Tiếp tục cấu hình</button><button className="secondary" onClick={() => { const item = createdCompetition; setCreatedCompetition(null); returnToList(item.id, item.status, item.endAt); }}>Để sau</button></div></section></div>}{deleteTarget && <div className="notice-modal-backdrop" role="presentation"><section className="notice-modal danger-confirmation" role="dialog" aria-modal="true" aria-labelledby="delete-ended-competition-title"><h2 id="delete-ended-competition-title">Xác nhận xóa kỳ thi</h2><p>Toàn bộ vòng thi, câu hỏi, đề thi, lượt thi, kết quả và đăng ký của “{deleteTarget.name}” sẽ bị xóa vĩnh viễn.</p><label>Nhập <strong>xoa</strong> để xác nhận<input autoFocus value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} placeholder="xoa" /></label><div className="actions"><button className="danger" disabled={action.busy || deleteConfirmation.trim().toLocaleLowerCase('vi') !== 'xoa'} onClick={() => removeCompetition(deleteTarget, deleteConfirmation)}>Xóa kỳ thi</button><button type="button" className="secondary" disabled={action.busy} onClick={() => { setDeleteTarget(null); setDeleteConfirmation(''); }}>Hủy</button></div></section></div>}{competitionView === 'create' && <><h2>{id ? 'Chỉnh sửa kỳ thi' : 'Tạo kỳ thi và lịch thi'}</h2><form onSubmit={submit}><fieldset className={`form-grid ${statusOnly ? 'status-only' : ''}`} disabled={action.busy}>
    <label className="span-all">Tên kỳ thi<input name="name" value={form.name} onChange={change} maxLength={255} required /></label><label className="span-all">Mô tả<textarea name="description" value={form.description} onChange={change} rows={3} /></label>
    <label>Số lượt thi tối đa mỗi vòng<input name="maxAttempts" type="number" min={1} max={100} value={form.maxAttempts} onChange={change} required /></label>
    <label>Bắt đầu<DateTime24Input value={form.startAt} onChange={value => setForm({ ...form, startAt: value })} required /></label><label>Kết thúc<DateTime24Input value={form.endAt} onChange={value => setForm({ ...form, endAt: value })} required /></label>{id ? <label className="competition-status">Trạng thái<select name="status" value={form.status} onChange={change}><option value="draft">Bản nháp</option><option value="published">Thông báo kỳ thi</option><option value="paused">Tạm đóng</option><option value="closed">Đóng kỳ thi</option></select></label> : <label>Trạng thái<input value="Bản nháp" readOnly /></label>}<p className="form-note">Lịch nhập theo múi giờ của thiết bị, chọn giờ theo định dạng 24 giờ. Thí sinh chỉ được làm trong khoảng thời gian đã thông báo.</p>
    <div className="actions span-all"><button>{action.busy ? 'Đang lưu…' : id ? (statusOnly ? 'Lưu trạng thái' : 'Lưu thay đổi') : 'Tạo kỳ thi'}</button>{id && <button type="button" className="secondary" onClick={() => returnToList(id)}>Hủy chỉnh sửa</button>}</div>
  </fieldset></form></>}{competitionView === 'list' && <><h2>Danh sách và lịch thi</h2><div className="form-grid filters"><label>Tìm tên kỳ thi<input value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} /></label><DateFilters value={filters} onChange={setFilters} /></div><nav className="tab-nav competition-tabs" aria-label="Nhóm kỳ thi"><button type="button" className={competitionTab === 'current' ? 'active' : ''} aria-pressed={competitionTab === 'current'} onClick={() => { setCompetitionTab('current'); setCompetitionPage(1); }}>Kỳ thi đang quản lý</button><button type="button" className={competitionTab === 'ended' ? 'active' : ''} aria-pressed={competitionTab === 'ended'} onClick={() => { setCompetitionTab('ended'); setCompetitionPage(1); }}>Kỳ thi đã kết thúc</button></nav>
    <ResourceState resource={resource} empty={!visible.length}><Table headings={['Kỳ thi', 'Lịch thi', 'Giới hạn', 'Trạng thái', 'Thao tác']}>{visiblePage.map(item => <tr id={`competition-row-${item.id}`} key={item.id}><td>{item.name}</td><td>{formatDate(item.startAt)}<br />{formatDate(item.endAt)}</td><td>{item.maxAttempts} lượt</td><td>{ended(item) ? 'Đã kết thúc' : statusNames[item.status] || item.status}</td><td><div className="table-actions">{['published', 'closed'].includes(item.status) && <button className="secondary" disabled={action.busy} onClick={() => action.run(async () => { await api('/manage/site/pin-competition', { token, method: 'PUT', body: { competitionId: item.id } }); onChanged(); }, 'Đã ghim kỳ thi lên trang chủ.')}>Ghim trang chủ</button>}{!ended(item) && ['published', 'paused'].includes(item.status) && <button className="secondary" onClick={() => { setId(item.id); setEditingStatus('status-only'); setForm({ ...item, startAt: localDate(item.startAt), endAt: localDate(item.endAt), description: item.description || '' }); setCompetitionView('create'); action.clear(); }}>Đổi trạng thái</button>}{!ended(item) && ['draft', 'paused'].includes(item.status) && <><button onClick={() => onConfigure(item, null, 'info')}>Cấu hình kỳ thi</button><button className="danger" disabled={action.busy} onClick={() => { setDeleteTarget(item); setDeleteConfirmation(''); }}>Xóa kỳ thi</button></>}{ended(item) && <><button className="secondary" onClick={() => onViewReports(item.id)}>Xem thống kê</button><button className="danger" disabled={action.busy} onClick={() => { setDeleteTarget(item); setDeleteConfirmation(''); }}>Xóa kỳ thi</button></>}</div></td></tr>)}</Table><Pagination total={visible.length} pageSize={pageSize} page={competitionPage} onChange={setCompetitionPage} /></ResourceState>
    {id && <div className="round-manager"><div className="section-heading"><div><h3>Vòng thi của kỳ thi</h3><p className="section-note">Thí sinh đi tiếp khi đạt mức điểm yêu cầu và thuộc Top N của vòng. Top N bằng 0 nghĩa là không giới hạn số lượng.</p></div><button type="button" className="secondary" onClick={resetRound}>Thêm vòng</button></div><form className="form-grid filters" onSubmit={saveRound}><p className="form-note">Vòng thứ {roundForm.roundNumber}</p><label>Tên vòng thi<input name="name" maxLength={255} placeholder="Ví dụ: Vòng sơ loại" value={roundForm.name} onChange={event=>setRoundForm({...roundForm,name:event.target.value})} required /></label><label>Thời lượng (phút)<input type="number" min="1" max="600" value={roundForm.durationMinutes} onChange={event=>setRoundForm({...roundForm,durationMinutes:event.target.value})} required /></label><label>Top thí sinh qua vòng (0 = không giới hạn)<input name="advanceCount" type="number" min="0" max="1000000" step="1" value={roundForm.advanceCount} onChange={event=>setRoundForm({...roundForm,advanceCount:event.target.value})} required /></label><label>Bắt đầu vòng<DateTime24Input value={roundForm.startAt} min={form.startAt} max={form.endAt} onChange={value => setRoundForm({ ...roundForm, startAt: value })} required /></label><label>Kết thúc vòng<DateTime24Input value={roundForm.endAt} min={form.startAt} max={form.endAt} onChange={value => setRoundForm({ ...roundForm, endAt: value })} required /></label><div className="actions"><button>{roundId ? 'Lưu vòng' : 'Thêm vòng'}</button>{roundId && <button type="button" className="secondary" onClick={resetRound}>Hủy</button>}</div></form><RoundCards rounds={rounds} onEdit={round => { setRoundId(round.id); setRoundForm({ name: round.name, durationMinutes: round.durationMinutes, advanceCount: round.advanceCount, roundNumber: round.roundNumber, startAt: localDate(round.startAt), endAt: localDate(round.endAt) }); }} onRankings={round => action.run(async () => { const data = await api(`/manage/competitions/${id}/rounds/${round.id}/rankings`, { token }); setRanking({ name: round.name, finalized: data.finalized, items: data.items }); setRankingPage(1); }, '')} onConfigure={(round, target) => onConfigure({ id, name: form.name }, round, target)} onDelete={round => action.run(async () => { await api(`/manage/competitions/${id}/rounds/${round.id}`, { token, method: 'DELETE' }); await loadRounds(id); }, 'Đã xóa vòng thi.')} />{ranking&&<div><h4>Xếp hạng: {ranking.name}{ranking.finalized ? '' : ' (tạm tính)'}</h4><Table headings={['Hạng','Thí sinh','Điểm','Thời gian (giây)','Đi tiếp']}>{ranking.items.slice((rankingPage - 1) * pageSize, rankingPage * pageSize).map(item=><tr key={item.id}><td>{item.roundRank}</td><td>{item.hoten}</td><td>{item.score}</td><td>{item.durationSeconds ?? '—'}</td><td>{ranking.finalized ? (Number(item.advanced) ? 'Được vào vòng tiếp theo' : 'Không được vào vòng tiếp theo') : 'Chưa có kết quả'}</td></tr>)}</Table><Pagination total={ranking.items.length} pageSize={pageSize} page={rankingPage} onChange={setRankingPage} />{!ranking.items.length&&<p>Vòng chưa chốt hoặc chưa có kết quả hợp lệ.</p>}</div>}</div>}</>}
  </section>;
}

function Questions({ token, competitions, configuration, onConfigure }) {
  // Quản lý câu hỏi theo kỳ thi, vòng thi và độ khó.
  const [filters, setFilters] = useState({ competitionId: '', q: '', difficulty: '' });
  const [query, setQuery] = useState(null);
  const [page, setPage] = useState(1);
  const [form, setForm] = useState(blankQuestion);
  const [id, setId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [file, setFile] = useState(null);
  const [importCompetition, setImportCompetition] = useState('');
  const [importRound,setImportRound]=useState('');
  const [refresh, setRefresh] = useState(0);
  const action = useAction();
  const resource = useResource(query ? `/manage/questions?${queryString({ ...query, page, pageSize: 10 })}` : null, token, refresh);
  useEffect(() => {
    if (!configuration) return;
    const selected = { competitionId: configuration.competitionId, roundId: configuration.roundId, q: '', difficulty: '' };
    setFilters(selected); setQuery(selected); setPage(1);
    setForm(current => ({ ...current, competitionId: configuration.competitionId, roundId: configuration.roundId }));
    setImportCompetition(configuration.competitionId); setImportRound(configuration.roundId);
  }, [configuration?.competitionId, configuration?.roundId]);
  const change = event => setForm({ ...form, [event.target.name]: event.target.value });
  const reload = () => setRefresh(value => value + 1);
  async function editQuestion(questionId) {
    // Luôn nạp bản ghi đầy đủ từ server để không dùng dữ liệu rút gọn của bảng tìm kiếm.
    await action.run(async () => {
      const payload = await api(`/manage/questions/${questionId}`, { token });
      setId(questionId);
      setDetail(null);
      setForm({ ...blankQuestion, ...payload.item, competitionId: String(payload.item.competitionId), roundId: String(payload.item.roundId) });
      // Form nằm sau danh sách; cuộn đến form để quản trị viên thấy ngay câu hỏi đang sửa.
      requestAnimationFrame(() => document.getElementById('question-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }, 'Đã mở câu hỏi để chỉnh sửa.');
  }
  async function submit(event) {
    event.preventDefault(); await action.run(async () => { await api(`/manage/questions${id ? `/${id}` : ''}`, { token, method: id ? 'PUT' : 'POST', body: { ...form, competitionId: Number(form.competitionId) } }); setId(null); setForm({ ...blankQuestion, competitionId: form.competitionId, roundId: form.roundId }); setDetail(null); reload(); });
  }
  // Đặt nhập Excel trước biểu mẫu thủ công để ưu tiên cách thêm số lượng lớn câu hỏi.
  const excelImport = <><h3>Nhập câu hỏi từ Excel</h3><p className="section-note">Dùng mẫu .xlsx có cột STT và tiêu đề tiếng Việt, tối đa 500 câu hỏi. Nếu có dòng không hợp lệ, toàn bộ tệp sẽ chưa được lưu.</p><form onSubmit={event => { event.preventDefault(); action.run(async () => { const body = new FormData(); body.append('file', file); const payload = await api(`/manage/questions/import?competitionId=${importCompetition}&roundId=${importRound}`, { token, body }); reload(); return payload; }, 'Đã nhập các câu hỏi từ tệp Excel.'); }}><fieldset disabled={action.busy} className="form-grid"><CompetitionSelect required items={competitions} value={importCompetition} onChange={value=>{setImportCompetition(value);setImportRound('');}} /><RoundSelect token={token} competitionId={importCompetition} value={importRound} onChange={setImportRound} /><label>Tệp Excel<input type="file" accept=".xlsx" onChange={event => setFile(event.target.files?.[0] || null)} required /></label><div className="actions span-all"><button disabled={!file || !importCompetition}>Nhập câu hỏi</button><button type="button" className="secondary" onClick={() => action.run(() => downloadFile('/manage/questions/template', token, 'mau-ngan-hang-cau-hoi.xlsx'), 'Đã tải mẫu Excel.')}>Tải mẫu Excel</button></div></fieldset></form></>;
  const configured = Boolean(configuration);
  const roundNavigation = configured && <ConfigurationRoundNavigation token={token} configuration={configuration} onConfigure={onConfigure} target="questions" />;
  return <section className="content-section"><h2>Ngân hàng câu hỏi</h2><ConfigurationTrail configuration={configuration} />{roundNavigation}{excelImport}<form className="form-grid filters" onSubmit={event => { event.preventDefault(); setQuery({ ...filters }); setPage(1); }}>{!configured && <><CompetitionSelect items={competitions} value={filters.competitionId} onChange={value => setFilters({ ...filters, competitionId: value, roundId: '' })} /><RoundSelect token={token} competitionId={filters.competitionId} value={filters.roundId} onChange={value=>setFilters({...filters,roundId:value})} all /></>}<label>Nội dung<input value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} /></label><Difficulty all value={filters.difficulty} onChange={value => setFilters({ ...filters, difficulty: value })} /><button>Tìm kiếm</button></form>
    {!query ? <p className="empty-state">Chọn điều kiện và bấm “Tìm kiếm” để xem câu hỏi.</p> : <><ResourceState resource={resource} empty={!resource.data?.items?.length}><Table headings={['Nội dung', 'Độ khó', 'Số điểm', 'Đáp án', 'Thao tác']}>{resource.data?.items?.map(item => <tr key={item.id}><td className="long-cell">{item.content}</td><td>{difficultyNames[item.difficulty]}</td><td>{item.points}</td><td>{item.correctAnswer}</td><td><div className="table-actions"><button className="secondary" disabled={action.busy} onClick={() => action.run(async () => { const payload = await api(`/manage/questions/${item.id}`, { token }); setDetail(payload.item); }, '')}>Xem</button><button className="secondary" disabled={action.busy} onClick={() => editQuestion(item.id)}>Sửa câu hỏi</button><button className="danger" disabled={action.busy} onClick={() => { if (window.confirm('Xóa câu hỏi khỏi ngân hàng? Các đề đã tạo vẫn giữ nội dung tại thời điểm tạo.')) action.run(async () => { await api(`/manage/questions/${item.id}`, { token, method: 'DELETE' }); setDetail(null); reload(); }, 'Đã xóa câu hỏi khỏi ngân hàng.'); }}>Xóa</button></div></td></tr>)}</Table></ResourceState>
      <Pagination data={resource.data} page={page} onChange={setPage} /></>}
    {detail && <aside className="detail-panel"><div className="section-heading"><h3>Chi tiết câu hỏi #{detail.id}</h3><button className="secondary" onClick={() => setDetail(null)}>Đóng chi tiết</button></div><p className="question-content">{detail.content}</p>{['A', 'B', 'C', 'D'].map(letter => <p key={letter}><strong>{letter}.</strong> {detail[`option${letter}`]} {detail.correctAnswer === letter && <span className="badge">Đáp án đúng</span>}</p>)}<p>{difficultyNames[detail.difficulty]} {'\u00b7'} {detail.points} {'\u0111i\u1ec3m'}</p></aside>}
    <h3 id="question-editor">{id ? `Sửa câu hỏi #${id}` : 'Thêm câu hỏi'}</h3><form onSubmit={submit}><fieldset disabled={action.busy} className="form-grid"><CompetitionSelect required items={competitions} value={form.competitionId} onChange={value => setForm({ ...form, competitionId: value, roundId: '' })} /><RoundSelect token={token} competitionId={form.competitionId} value={form.roundId} onChange={value=>setForm({...form,roundId:value})} /><Difficulty value={form.difficulty} onChange={value => setForm({ ...form, difficulty: value })} /><label>{'S\u1ed1 \u0111i\u1ec3m'}<input name="points" type="number" min="0.01" max="1000000" step="0.01" value={form.points} onChange={change} required /></label><label>Đáp án đúng<select name="correctAnswer" value={form.correctAnswer} onChange={change}>{['A', 'B', 'C', 'D'].map(letter => <option key={letter}>{letter}</option>)}</select></label><label className="span-all">Nội dung câu hỏi<textarea name="content" value={form.content} onChange={change} rows={3} required /></label>{['A', 'B', 'C', 'D'].map(letter => <label key={letter}>Lựa chọn {letter}<textarea name={`option${letter}`} value={form[`option${letter}`]} onChange={change} rows={2} required /></label>)}<div className="actions span-all"><button>{id ? 'Lưu câu hỏi' : 'Thêm câu hỏi'}</button>{id && <button type="button" className="secondary" onClick={() => { setId(null); setForm(blankQuestion); }}>Hủy chỉnh sửa</button>}</div></fieldset></form><Notice {...action} />
  </section>;
}

function ExamBuilder({ token, competitions, configuration, onConfigure }) {
  // Xem trước danh sách câu hỏi trước khi lưu các đề thi vào hệ thống.
  const [form, setForm] = useState({ roundId: '', competitionId: '', count: 10, hardCount: 0, mediumCount: 0, quantity: 1 });
  const [preview, setPreview] = useState([]);
  const [previewCompetition, setPreviewCompetition] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [previewPage, setPreviewPage] = useState(1);
  const [previewQuestionPages, setPreviewQuestionPages] = useState({});
  const [examPage, setExamPage] = useState(1);
  const action = useAction();
  const resource = useResource(form.competitionId ? `/manage/exams?competitionId=${form.competitionId}&roundId=${form.roundId}` : null, token, refresh);
  useEffect(() => {
    if (!configuration) return;
    setForm(current => ({ ...current, competitionId: configuration.competitionId, roundId: configuration.roundId }));
    setPreview([]); setPreviewPage(1); setPreviewQuestionPages({}); setExamPage(1);
  }, [configuration?.competitionId, configuration?.roundId]);
  const change = (key, value) => { setForm({ ...form, [key]: value, ...(key === 'competitionId' ? { roundId: '' } : {}) }); setPreview([]); setPreviewPage(1); setPreviewQuestionPages({}); setExamPage(1); };
  async function removeExam(item) {
    // Xóa đề không xóa ngân hàng câu hỏi; backend sẽ từ chối nếu vòng thi đã có lượt làm bài.
    if (!window.confirm(`Xóa đề mã “${item.code}”? Ngân hàng câu hỏi sẽ được giữ nguyên.`)) return;
    await action.run(async () => { await api(`/manage/exams/${item.id}`, { token, method: 'DELETE' }); setRefresh(value => value + 1); }, 'Đã xóa đề thi.');
  }
  // B?n xem tr??c v? danh s?ch ?? ??u gi?i h?n 10 d?ng m?i trang.
  const pageSize = 10;
  const pageItems = (items, page) => items.slice((page - 1) * pageSize, page * pageSize);
  const configured = Boolean(configuration);
  const roundNavigation = configured && <ConfigurationRoundNavigation token={token} configuration={configuration} onConfigure={onConfigure} target="exams" />;
  return <section className="content-section"><h2>Tạo đề thi từ ngân hàng</h2><ConfigurationTrail configuration={configuration} />{roundNavigation}<details className="automatic-exam-builder" open><summary>Tạo đề tự động theo số lượng và độ khó</summary><form onSubmit={event => { event.preventDefault(); action.run(async () => { const payload = await api('/manage/exams/preview', { token, body: { ...form, competitionId: Number(form.competitionId), count: Number(form.count), quantity: Number(form.quantity) } }); setPreview(payload.items); setPreviewCompetition(form.competitionId); }, 'Đã tạo bản xem trước. Kiểm tra nội dung và xác nhận lưu.'); }}><fieldset className="form-grid" disabled={action.busy}><CompetitionSelect required items={competitions} value={form.competitionId} onChange={value => change('competitionId', value)} /><RoundSelect token={token} competitionId={form.competitionId} value={form.roundId} onChange={value=>change('roundId',value)} /><label>Số câu / đề<input type="number" min={1} max={500} value={form.count} onChange={event => change('count', event.target.value)} required /></label><label>Số đề cần tạo<input type="number" min={1} max={20} value={form.quantity} onChange={event => change('quantity', event.target.value)} required /></label><label>Số câu khó<input type="number" min="0" max={form.count} value={form.hardCount} onChange={event => change('hardCount', event.target.value)} required /></label><label>Số câu trung bình<input type="number" min="0" max={form.count} value={form.mediumCount} onChange={event => change('mediumCount', event.target.value)} required /></label><div className="actions"><button>Tạo bản xem trước</button></div></fieldset></form></details><Notice {...action} />
    {preview.length > 0 && <div className="preview-list">{pageItems(preview, previewPage).map((exam, offset) => { const index = (previewPage - 1) * pageSize + offset; const questionPage = previewQuestionPages[index] || 1; return <details key={index} open={index === 0}><summary>{'\u0110\u1ec1 '} {index + 1} {'\u00b7'} {exam.questions.length} {' c\u00e2u h\u1ecfi'}</summary><ol start={(questionPage - 1) * pageSize + 1}>{pageItems(exam.questions, questionPage).map(question => <li key={question.id}><p className="question-content">{question.content}</p>{['A', 'B', 'C', 'D'].map(letter => <p key={letter}>{letter}. {question[`option${letter}`]} {question.correctAnswer === letter && <strong>{'\u2713'}</strong>}</p>)}</li>)}</ol><Pagination total={exam.questions.length} pageSize={pageSize} page={questionPage} onChange={value => setPreviewQuestionPages(current => ({ ...current, [index]: value }))} /></details>; })}<Pagination total={preview.length} pageSize={pageSize} page={previewPage} onChange={setPreviewPage} /><div className="actions"><button disabled={action.busy} onClick={() => action.run(async () => { await api('/manage/exams', { token, body: { competitionId: Number(previewCompetition), roundId: form.roundId, items: preview.map(exam => ({ questionIds: exam.questions.map(question => Number(question.id)) })) } }); setPreview([]); setPreviewPage(1); setPreviewQuestionPages({}); setExamPage(1); setRefresh(value => value + 1); }, 'Đã lưu và xuất bản các đề thi.')}>Xác nhận lưu {preview.length} đề thi</button><button className="secondary" disabled={action.busy} onClick={() => setPreview([])}>Bỏ bản xem trước</button></div></div>}
    <h3>Đề đã tạo</h3>{!form.competitionId ? <p className="empty-state">Chọn kỳ thi để xem các đề đã tạo.</p> : <ResourceState resource={resource} empty={!resource.data?.items?.length}><Table headings={['Mã đề', 'Số câu', 'Trạng thái', 'Thao tác']}>{pageItems(resource.data?.items || [], examPage).map(item => <tr key={item.id}><td>{item.code}</td><td>{item.questionCount}</td><td>{item.isPublished ? 'Đã xuất bản' : 'Bản nháp'}</td><td><button className="danger" disabled={action.busy} onClick={() => removeExam(item)}>Xóa đề</button></td></tr>)}</Table><Pagination total={(resource.data?.items || []).length} pageSize={pageSize} page={examPage} onChange={setExamPage} /></ResourceState>}
  </section>;
}

function Candidates({ token, competitions, units }) {
  // Danh sách thí sinh được tải theo bộ lọc và phân trang từ backend.
  const [filters, setFilters] = useState({ competitionId: '', q: '', unitId: '' });
  const [query, setQuery] = useState(filters);
  const [page, setPage] = useState(1);
  const resource = useResource(`/manage/candidates?${queryString({ ...query, page })}`, token);
  return <section className="content-section"><h2>Danh sách thí sinh</h2><form className="form-grid filters" onSubmit={event => { event.preventDefault(); setQuery({ ...filters }); setPage(1); }}><CompetitionSelect items={competitions} value={filters.competitionId} onChange={value => setFilters({ ...filters, competitionId: value })} /><label>Tên, điện thoại hoặc email<input value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} /></label><label>Đơn vị<select value={filters.unitId} onChange={event => setFilters({ ...filters, unitId: event.target.value })}><option value="">Tất cả đơn vị</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.ten}</option>)}</select></label><button>Tìm kiếm</button></form><ResourceState resource={resource} empty={!resource.data?.items?.length}><Table headings={['Họ và tên', 'Liên hệ', 'Đơn vị', 'Kỳ thi', 'Đăng ký']}>{resource.data?.items?.map((item, index) => <tr key={`${item.id}-${index}`}><td>{item.hoten}</td><td>{item.dienthoai}<br />{item.email}</td><td>{item.unitName || '—'}</td><td>{item.competitionName || 'Chưa đăng ký kỳ thi'}</td><td>{formatDate(item.registeredAt)}</td></tr>)}</Table></ResourceState><Pagination data={resource.data} page={page} onChange={setPage} /></section>;
}

function AccessFields({ form, setForm, competitions, creating }) {
  // Các trường này chỉ cấp quyền chi tiết khi tài khoản có vai trò giảng viên.
  const toggle = (key, value) => setForm({ ...form, [key]: form[key].includes(value) ? form[key].filter(item => item !== value) : [...form[key], value] });
  return <><label>Vai trò<select value={form.role} onChange={event => setForm({ ...form, role: event.target.value })}><option value="candidate">Thí sinh</option><option value="teacher">Giảng viên</option>{!creating && <option value="admin">Quản trị viên</option>}</select></label>{!creating && <label className="checkbox-label"><input type="checkbox" checked={form.is_active} onChange={event => setForm({ ...form, is_active: event.target.checked })} />Tài khoản được hoạt động</label>}
    {form.role === 'teacher' && <><fieldset className="checkbox-group span-all"><legend>Quyền chức năng</legend>{Object.entries(permissionNames).map(([key, label]) => <label key={key}><input type="checkbox" checked={form.permissions.includes(key)} onChange={() => toggle('permissions', key)} />{label}</label>)}</fieldset><fieldset className="checkbox-group span-all"><legend>Kỳ thi được phân công</legend>{competitions.length ? competitions.map(item => <label key={item.id}><input type="checkbox" checked={form.competitionIds.includes(String(item.id))} onChange={() => toggle('competitionIds', String(item.id))} />{item.name}</label>) : <p>Hãy tạo kỳ thi trước khi phân công.</p>}</fieldset></>}
  </>;
}

function Users({ token, competitions, units, currentUser }) {
  // Quản trị viên cấp tài khoản, phân quyền và xử lý yêu cầu quên mật khẩu tại đây.
  const initial = { hoten: '', chucVu: 'Đoàn viên', dienthoai: '', email: '', donviID: '', role: 'teacher', permissions: [], competitionIds: [], is_active: true };
  const [form, setForm] = useState(initial);
  const [editing, setEditing] = useState(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [temporary, setTemporary] = useState(null);
  const [bulkFile, setBulkFile] = useState(null);
  const [bulkResult, setBulkResult] = useState(null);
  // Hộp thoại chỉ mở khi tác vụ nhập Excel đã hoàn tất để quản trị viên quyết định xuất tệp kết quả.
  const [bulkExportPrompt, setBulkExportPrompt] = useState(null);
  const importRunning = ['pending', 'running'].includes(bulkResult?.status);
  const action = useAction();
  const users = useResource(`/manage/users?${queryString({ q: query, page, pageSize: 10 })}`, token, refresh);
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
  function importCandidates(event) {
    event.preventDefault();
    action.run(async () => {
      const body = new FormData(); body.append('file', bulkFile);
      const payload = await api('/manage/users/candidates/import', { token, body });
      setBulkExportPrompt(null);
      setBulkResult({ ...payload.job, jobId: payload.job.id });
      setBulkFile(null);
    }, 'Tệp đang được xử lý nền. Bạn có thể tiếp tục thao tác các chức năng khác.');
  }
  useEffect(() => {
    if (!bulkResult?.jobId || !['pending', 'running'].includes(bulkResult.status)) return undefined;
    let active = true;
    const poll = async () => { try { const payload = await api('/manage/users/candidates/import/status', { token }); if (!active || !payload.job || payload.job.id !== bulkResult.jobId) return; const next = { ...payload.job, jobId: payload.job.id }; setBulkResult(next); if (payload.job.status === 'completed') { reload(); setBulkExportPrompt(current => current || next); } } catch { /* Lần hỏi tiếp theo sẽ tự thử lại. */ } };
    poll(); const timer = setInterval(poll, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [bulkResult?.jobId, bulkResult?.status, token]);
  function resetPassword(user, requestId) {
    if (!window.confirm(`Đã xác minh danh tính của ${user.hoten}? Tạo mật khẩu tạm thời sẽ thu hồi mọi phiên đăng nhập của tài khoản này.`)) return;
    setTemporary(null); action.run(async () => { const payload = await api(`/manage/users/${user.userId || user.id}/reset-password`, { token, body: requestId ? { requestId } : {} }); setTemporary({ name: user.hoten, password: payload.temporaryPassword });
      // Hiển thị ngay mật khẩu chỉ có một lần để quản trị viên không bỏ sót sau khi danh sách tải lại.
      window.alert(`Mật khẩu tạm thời của ${user.hoten}:\n${payload.temporaryPassword}\n\nHãy bàn giao an toàn và yêu cầu người dùng đổi mật khẩu khi đăng nhập.`);
      reload(); }, 'Đã đặt mật khẩu tạm thời. Người dùng bắt buộc đổi mật khẩu khi đăng nhập.');
  }
  return <section className="content-section"><h2>Tài khoản và phân quyền</h2><h3>Nhập tài khoản thí sinh từ Excel</h3><p className="section-note">Tệp gồm: STT, Họ và tên, Chức vụ, Đơn vị, Số điện thoại, Email. Chỉ tạo tài khoản thí sinh.</p><form onSubmit={importCandidates}><fieldset className="form-grid" disabled={action.busy}><label>Tệp Excel<input type="file" accept=".xlsx" onChange={event => setBulkFile(event.target.files?.[0] || null)} required /></label><div className="actions"><button disabled={!bulkFile}>Nhập tài khoản</button><button type="button" className="secondary" onClick={() => action.run(() => downloadFile('/manage/users/candidates/template', token, 'mau-tai-khoan-thi-sinh.xlsx'), 'Đã tải mẫu Excel.')}>Tải mẫu Excel</button></div></fieldset></form>{bulkExportPrompt && <div className="notice-modal-backdrop" role="presentation"><section className="notice-modal success-message" role="dialog" aria-modal="true" aria-labelledby="candidate-import-result-title"><h2 id="candidate-import-result-title">Nhập tài khoản hoàn tất</h2><p>Đã tạo thành công <strong>{bulkExportPrompt.added}</strong> tài khoản; bỏ qua <strong>{bulkExportPrompt.skipped?.length || 0}</strong> dòng.</p>{bulkExportPrompt.skipped?.length > 0 && <ul>{bulkExportPrompt.skipped.map(item => <li key={item.row}>Dòng {item.row}: {item.errors.join('; ')}</li>)}</ul>}<p>Bạn có muốn xuất file danh sách tài khoản vừa nhập không?</p><div className="actions"><button disabled={action.busy} onClick={() => action.run(async () => { await downloadFile('/manage/users/candidates/export', token, 'danh-sach-tai-khoan-thi-sinh.xlsx'); setBulkExportPrompt(null); }, 'Đã tải danh sách tài khoản vừa nhập.')}>Xuất file tài khoản</button><button type="button" className="secondary" disabled={action.busy} onClick={() => setBulkExportPrompt(null)}>Không xuất</button></div></section></div>}{bulkResult && <div className="temporary-secret"><p>Đã tạo {bulkResult.added} tài khoản. Bỏ qua {bulkResult.skipped?.length || 0} dòng.</p>{bulkResult.skipped?.length > 0 && <ul>{bulkResult.skipped.map(item => <li key={item.row}>Dòng {item.row}: {item.errors.join('; ')}</li>)}</ul>}{bulkResult.credentials?.length > 0 && <Table headings={['Họ tên', 'Chức vụ', 'Đơn vị', 'Số điện thoại', 'Email', 'Mật khẩu tạm']}><>{bulkResult.credentials.map(item => <tr key={item.email}><td>{item.hoten}</td><td>{item.chucVu}</td><td>{item.unitName}</td><td>{item.dienthoai}</td><td>{item.email}</td><td><code>{item.password}</code></td></tr>)}</></Table>}</div>}
<form className="form-grid filters" onSubmit={event => { event.preventDefault(); setQuery(q); setPage(1); }}><label>Tìm tài khoản<input value={q} onChange={event => setQ(event.target.value)} placeholder="Tên, số điện thoại hoặc email" /></label><button>Tìm kiếm</button></form><ResourceState resource={users} empty={!users.data?.items?.length}><Table headings={['Tài khoản', 'Vai trò', 'Quyền', 'Trạng thái', 'Thao tác']}>{users.data?.items?.map(item => <tr key={item.id}><td><strong>{item.hoten}</strong>{String(item.id) === String(currentUser.id) && ' (bạn)'}<br />{item.chucVu || 'Đoàn viên'}<br />{item.dienthoai}<br />{item.email}</td><td>{roleNames[item.role]}</td><td>{item.role === 'admin' ? 'Toàn quyền' : item.permissions?.map(key => permissionNames[key]).join(', ') || '—'}</td><td>{Number(item.is_active) ? 'Hoạt động' : 'Đã khóa'}{Number(item.must_change_password) ? ' · Cần đổi mật khẩu' : ''}</td><td><div className="table-actions"><button className="secondary" disabled={action.busy} onClick={() => { setEditing(item); setForm({ ...initial, ...item, permissions: item.permissions || [], competitionIds: (item.competitionIds || []).map(String), is_active: Boolean(Number(item.is_active)) }); setTemporary(null); }}>Phân quyền</button>{String(item.id) !== String(currentUser.id) && <button className="secondary" disabled={action.busy} onClick={() => resetPassword(item)}>Đặt lại mật khẩu</button>}</div></td></tr>)}</Table></ResourceState>
    <Pagination data={users.data} page={page} onChange={setPage} />
    <h3>{editing ? `Phân quyền: ${editing.hoten}` : 'Cấp tài khoản mới'}</h3><form onSubmit={submit}><fieldset className="form-grid" disabled={action.busy}>{!editing && <>{[['hoten', 'Họ và tên', 'text'], ['chucVu', 'Chức vụ', 'text'], ['dienthoai', 'Số điện thoại', 'tel'], ['email', 'Email', 'email']].map(([key, label, type]) => <label key={key}>{label}<input type={type} value={form[key]} onChange={event => setForm({ ...form, [key]: event.target.value })} required maxLength={key === 'dienthoai' ? 30 : key === 'chucVu' ? 100 : 255} /></label>)}<label>Đơn vị<select value={form.donviID || ''} onChange={event => setForm({ ...form, donviID: event.target.value })}><option value="">Chưa chọn đơn vị</option>{units.map(unit => <option value={unit.id} key={unit.id}>{unit.ten}</option>)}</select></label></>}
      <AccessFields form={form} setForm={setForm} competitions={competitions} creating={!editing} /><div className="actions span-all"><button>{editing ? 'Lưu phân quyền' : 'Cấp tài khoản'}</button>{editing && <button type="button" className="secondary" onClick={() => { setEditing(null); setForm(initial); }}>Hủy chỉnh sửa</button>}</div></fieldset></form>
    {temporary && <div className="temporary-secret" role="status"><h3>Mật khẩu tạm thời của {temporary.name}</h3><p>Chỉ hiển thị tại đây trong thao tác này. Giao trực tiếp cho người dùng sau khi xác minh danh tính.</p><code>{temporary.password}</code><div className="actions"><button onClick={() => setTemporary(null)}>Đã ghi nhận, ẩn mật khẩu</button></div></div>}
    <h3>Yêu cầu hỗ trợ quên mật khẩu</h3><ResourceState resource={requests} empty={!requests.data?.items?.length}><Table headings={['Người yêu cầu', 'Liên hệ', 'Ngày gửi', 'Trạng thái', 'Xử lý']}>{requests.data?.items?.map(item => <tr key={item.id}><td>{item.hoten}</td><td>{item.dienthoai}<br />{item.email}</td><td>{formatDate(item.createdAt)}</td><td>{item.status === 'pending' ? 'Chờ xác minh' : 'Đã xử lý'}</td><td>{item.status === 'pending' && <button disabled={action.busy} onClick={() => resetPassword(item, item.id)}>Xác minh và cấp mật khẩu</button>}</td></tr>)}</Table></ResourceState>
  </section>;
}

function SiteEditor({ token, onChanged }) {
  // Tep vua tai chi duoc cong bo sau khi quan tri vien bam ap dung.
  const resource = useResource('/site', token);
  const newsListRef = useRef(null);
  const newestNewsInputRef = useRef(null);
  const pendingNewsUrlRef = useRef('');
  const [form, setForm] = useState(null);
  const [siteTab, setSiteTab] = useState('home');
  const action = useAction();
  const defaultFooter = { organizationLabel: '\u0110\u01a1n v\u1ecb t\u1ed5 ch\u1ee9c', organizationName: 'T\u1ec9nh \u0110o\u00e0n V\u0129nh Long', address: '169/2, \u0111\u01b0\u1eddng Ph\u1ea1m H\u00f9ng, Ph\u01b0\u1eddng Long Ch\u00e2u, t\u1ec9nh V\u0129nh Long', contactLabel: 'Li\u00ean h\u1ec7', email: 'tuyengiao.tinhdoanvinhlong@gmail.com', website: 'tinhdoanvinhlong.vn' };
  const data = form || resource.data?.item || { title: '', description: '', bannerUrl: '', newsUrl: '', newsTitle: '', banners: [], news: [], footer: { organizationLabel: '\u0110\u01a1n v\u1ecb t\u1ed5 ch\u1ee9c', organizationName: 'T\u1ec9nh \u0110o\u00e0n V\u0129nh Long', address: '169/2, \u0111\u01b0\u1eddng Ph\u1ea1m H\u00f9ng, Ph\u01b0\u1eddng Long Ch\u00e2u, t\u1ec9nh V\u0129nh Long', contactLabel: 'Li\u00ean h\u1ec7', email: 'tuyengiao.tinhdoanvinhlong@gmail.com', website: 'tinhdoanvinhlong.vn' } };
  // Luôn có dữ liệu mặc định để admin thấy ngay nội dung footer hiện tại.
  const footer = { ...defaultFooter, ...(data.footer || {}) };
  const change = (key, value) => setForm({ ...data, [key]: value });

  // Sau khi giao dien ve den tep moi, dua nguoi dung den o dat tieu de va dat con tro nhap lieu.
  useEffect(() => {
    if (!pendingNewsUrlRef.current || !newestNewsInputRef.current) return;
    pendingNewsUrlRef.current = '';
    requestAnimationFrame(() => {
      newsListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      newestNewsInputRef.current?.focus();
    });
  }, [data.news]);

  async function upload(file, kind) {
    if (!file) return;
    await action.run(async () => {
      const maximumBytes = kind === 'news' ? 25 * 1024 * 1024 : 5 * 1024 * 1024;
      if (file.size > maximumBytes) throw new Error(`Tệp phải có dung lượng tối đa ${kind === 'news' ? 25 : 5} MB.`);
      const body = new FormData();
      body.append('file', file);
      body.append('kind', kind);
      const payload = await api('/manage/assets', { token, body });
      setForm(current => {
        const next = { ...(current || data) };
        const key = kind === 'banner' ? 'banners' : 'news';
        next[key] = [...(next[key] || []), { url: payload.item.url, title: payload.item.name, fileName: payload.item.name }];
        return next;
      });
      if (kind === 'news') {
        pendingNewsUrlRef.current = payload.item.url;
      }
    }, 'Đã tải tệp lên. Bấm Áp dụng để cập nhật trang công khai.');
  }

  return <section className="content-section">
    <h2>Giao diện và tài liệu công bố</h2>
    <nav className="tab-nav" aria-label={"N\u1ed9i dung giao di\u1ec7n"}><button type="button" className={siteTab === 'home' ? 'active' : ''} onClick={() => setSiteTab('home')}>{'Trang ch\u1ee7'}</button><button type="button" className={siteTab === 'footer' ? 'active' : ''} onClick={() => setSiteTab('footer')}>{'Th\u00f4ng tin footer'}</button></nav>
    <ResourceState resource={resource}>
      <form onSubmit={event => {
        event.preventDefault();
        action.run(async () => {
          await api('/manage/site', { token, method: 'PUT', body: { ...data, footer } });
          onChanged();
        }, 'Đã áp dụng giao diện và tài liệu công khai.');
      }}>
        {siteTab === 'home' && <>
        <fieldset className="form-grid" disabled={action.busy}>
          <label className="span-all">Tiêu đề cổng thi<input value={data.title || ''} onChange={event => change('title', event.target.value)} maxLength={255} required /></label>
          <label className="span-all">Nội dung giới thiệu<textarea value={data.description || ''} onChange={event => change('description', event.target.value)} rows={3} /></label>
          <label>Ảnh banner (tối đa 5 MB)<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => upload(event.target.files?.[0], 'banner')} /></label>
          <label>Tệp tin tức / thể lệ (tối đa 25 MB)<input type="file" accept=".pdf,.txt,.docx" onChange={event => upload(event.target.files?.[0], 'news')} /></label>
          {data.bannerUrl && <div className="span-all"><img className="banner-preview" src={assetUrl(data.bannerUrl)} alt="Xem trước banner sẽ áp dụng" /><button type="button" className="text-button" onClick={() => change('bannerUrl', '')}>Gỡ banner</button></div>}
          {data.newsUrl && <div className="span-all"><a href={assetUrl(data.newsUrl)} target="_blank" rel="noreferrer">Xem tài liệu đã chọn</a> <button type="button" className="text-button" onClick={() => setForm({ ...data, newsUrl: '', newsTitle: '' })}>Gỡ tài liệu</button></div>}
          <div className="span-all home-content-list">
            <h3>Banner trang chủ</h3>
            {(data.banners || []).map((item, index) => <div className="home-content-item" key={item.url}><img className="banner-preview" src={assetUrl(item.url)} alt="Xem trước banner" /><input aria-label={`Tiêu đề banner ${index + 1}`} value={item.title} maxLength={255} onChange={event => change('banners', data.banners.map((value, position) => position === index ? { ...value, title: event.target.value } : value))} /><button type="button" className="text-button" onClick={() => change('banners', data.banners.filter((_, position) => position !== index))}>Xóa banner</button></div>)}
            {!(data.banners || []).length && <p className="section-note">Chưa có banner mới. Chọn ảnh ở trên để thêm.</p>}
            <div ref={newsListRef} id="published-news">
              <h3>{'Tin t\u1ee9c \u0111ang c\u00f4ng b\u1ed1'}</h3>
              {(data.news || []).map((item, index) => {
                const fileName = item.fileName || 'T\u1ec7p tin t\u1ee9c';
                return <div className="home-content-item news-content-item" key={item.url}>
                  <a className="news-file-name" href={assetUrl(item.url)} target="_blank" rel="noreferrer">{'T\u1ec7p: '}{fileName}</a>
                  <label className="news-title-field">{'Ti\u00eau \u0111\u1ec1 tin t\u1ee9c'}<input ref={item.url === pendingNewsUrlRef.current ? newestNewsInputRef : undefined} value={item.title} maxLength={255} onChange={event => change('news', data.news.map((value, position) => position === index ? { ...value, title: event.target.value } : value))} /></label>
                  <button type="button" className="text-button" onClick={() => change('news', data.news.filter((_, position) => position !== index))}>{'X\u00f3a tin t\u1ee9c'}</button>
                </div>;
              })}
              {!(data.news || []).length && <p className="section-note">{'Ch\u01b0a c\u00f3 tin t\u1ee9c m\u1edbi. Ch\u1ecdn t\u1ec7p \u1edf tr\u00ean \u0111\u1ec3 th\u00eam.'}</p>}
            </div>
          </div>
          <div className="actions span-all"><button>Áp dụng lên trang công khai</button><button type="button" className="secondary" onClick={() => setForm(null)}>Bỏ thay đổi chưa áp dụng</button></div>
        </fieldset>
        </>}
        {siteTab === 'footer' && <fieldset className="form-grid" disabled={action.busy}><label>{'Nh\u00e3n \u0111\u01a1n v\u1ecb t\u1ed5 ch\u1ee9c'}<input value={footer.organizationLabel || ''} onChange={event => change('footer', { ...footer, organizationLabel: event.target.value })} maxLength={255} required /></label><label>{'T\u00ean \u0111\u01a1n v\u1ecb t\u1ed5 ch\u1ee9c'}<input value={footer.organizationName || ''} onChange={event => change('footer', { ...footer, organizationName: event.target.value })} maxLength={255} required /></label><label className="span-all">{'\u0110\u1ecba ch\u1ec9'}<input value={footer.address || ''} onChange={event => change('footer', { ...footer, address: event.target.value })} maxLength={500} required /></label><label>{'Nh\u00e3n li\u00ean h\u1ec7'}<input value={footer.contactLabel || ''} onChange={event => change('footer', { ...footer, contactLabel: event.target.value })} maxLength={255} required /></label><label>{'Email li\u00ean h\u1ec7'}<input type="email" value={footer.email || ''} onChange={event => change('footer', { ...footer, email: event.target.value })} maxLength={254} required /></label><label className="span-all">{'Website'}<input value={footer.website || ''} onChange={event => change('footer', { ...footer, website: event.target.value })} placeholder="tinhdoanvinhlong.vn" maxLength={255} required /></label><div className="actions span-all"><button>{'C\u1eadp nh\u1eadt footer'}</button><button type="button" className="secondary" onClick={() => setForm(null)}>{'B\u1ecf thay \u0111\u1ed5i ch\u01b0a \u00e1p d\u1ee5ng'}</button></div></fieldset>}
      </form>
    </ResourceState>
    <Notice {...action} />
  </section>;
}

function Units({ token }) {
  // Danh mục đơn vị dùng cho đăng ký tài khoản và thống kê báo cáo.
  const [form, setForm] = useState({ ten: '', organizationName: '' });
  const [file, setFile] = useState(null);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  // Danh sách quản trị tải mười đơn vị mỗi trang, không ảnh hưởng danh mục đầy đủ của biểu mẫu đăng ký.
  const resource = useResource(`/manage/units?${queryString({ page, pageSize: 10 })}`, token, refresh);
  const action = useAction();
  return <section className="content-section"><h2>Đơn vị đăng ký</h2><p className="section-note">Thêm đơn vị thực tế của ban tổ chức. Danh mục này dùng khi đăng ký tài khoản và thống kê.</p><form onSubmit={event => { event.preventDefault(); action.run(async () => { await api('/manage/units', { token, body: form }); setForm({ ten: '', organizationName: '' }); setPage(1); setRefresh(value => value + 1); }, 'Đã thêm đơn vị.'); }}><fieldset className="form-grid" disabled={action.busy}><label>Tên đơn vị<input value={form.ten} onChange={event => setForm({ ...form, ten: event.target.value })} required maxLength={255} /></label><label>Đoàn cơ sở<input value={form.organizationName} onChange={event => setForm({ ...form, organizationName: event.target.value })} maxLength={255} /></label><div className="actions"><button>Thêm đơn vị</button></div></fieldset></form><h3>{'Nh\u1eadp \u0111\u01a1n v\u1ecb t\u1eeb Excel'}</h3><p className="section-note">{'T\u1ec7p g\u1ed3m c\u1ed9t STT v\u00e0 \u0110\u01a1n v\u1ecb, t\u1ed1i \u0111a 500 d\u00f2ng. C\u00e1c \u0111\u01a1n v\u1ecb nh\u1eadp t\u1eeb t\u1ec7p s\u1ebd thu\u1ed9c T\u1ec9nh \u0111o\u00e0n V\u0129nh Long. T\u00ean \u0111\u01a1n v\u1ecb tr\u00f9ng s\u1ebd \u0111\u01b0\u1ee3c b\u1ecf qua.'}</p><form onSubmit={event => { event.preventDefault(); action.run(async () => { const makeBody = confirmed => { const body = new FormData(); body.append('file', file); if (confirmed) body.append('createOrganizations', 'true'); return body; }; const preview = await api('/manage/units/import', { token, body: makeBody(false) }); if (preview.needsOrganizationConfirmation) { const names = preview.organizations.join(', '); if (!window.confirm(`\u0110o\u00e0n c\u01a1 s\u1edf ch\u01b0a c\u00f3 s\u1eb5n: ${names}. B\u1ea1n c\u00f3 mu\u1ed1n t\u1ea1o c\u00e1c \u0111o\u00e0n c\u01a1 s\u1edf n\u00e0y kh\u00f4ng?`)) return; await api('/manage/units/import', { token, body: makeBody(true) }); } setFile(null); setPage(1); setRefresh(value => value + 1); }, 'Đã nhập danh sách đơn vị. Các tên bị trùng đã được bỏ qua.'); }}><fieldset className="form-grid" disabled={action.busy}><label>Tệp Excel<input type="file" accept=".xlsx" onChange={event => setFile(event.target.files?.[0] || null)} required /></label><div className="actions"><button disabled={!file}>Nhập đơn vị</button><button type="button" className="secondary" onClick={() => action.run(() => downloadFile('/manage/units/template', token, 'mau-danh-sach-don-vi.xlsx'), 'Đã tải mẫu Excel.')}>Tải mẫu Excel</button></div></fieldset></form><Notice {...action} /><ResourceState resource={resource} empty={!resource.data?.items?.length}><Table headings={['Đơn vị', 'Đoàn cơ sở']}>{resource.data?.items?.map(item => <tr key={item.id}><td>{item.ten}</td><td>{item.organizationName || '—'}</td></tr>)}</Table></ResourceState><Pagination data={resource.data} page={page} onChange={setPage} /></section>;
}

