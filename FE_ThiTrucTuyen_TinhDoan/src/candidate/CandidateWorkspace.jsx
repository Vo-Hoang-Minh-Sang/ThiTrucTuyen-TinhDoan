import { useEffect, useRef, useState } from 'react';
import { api } from '../shared/api';
import { activeKey, progressKey, readCache, recoverProgress, removeCache, remainingSeconds, writeCache } from './examProgress';
import { CompetitionSelect, DateFilters, Notice, ResourceState, Table, formatDate, queryString, useAction, useResource } from '../shared/ui';

const roundStates = new Set(['COMPLETED', 'AVAILABLE', 'LOCKED']);
// Mã trạng thái vẫn dùng để quyết định quyền làm bài; chỉ phần chữ hiển thị được Việt hóa cho thí sinh.
const roundStatus = (value, scheduleStatus) => {
  if (!roundStates.has(value)) return 'Chưa cập nhật trạng thái';
  if (scheduleStatus === 'upcoming') return 'Chưa diễn ra';
  if (scheduleStatus === 'ended' || value === 'COMPLETED') return 'Đã kết thúc';
  if (value === 'AVAILABLE') return 'Đang diễn ra';
  return 'Đóng';
};
const competitionStatus = value => ({ unscheduled: 'Chưa có lịch', upcoming: 'Chưa diễn ra', active: 'Đang diễn ra', ended: 'Đã kết thúc', closed: 'Đóng' }[value] || 'Chưa cập nhật trạng thái');
const officialScore = value => value == null ? 'Chưa có điểm' : `${Number(value).toLocaleString('vi-VN')} / 100`;
const officialDuration = value => value == null ? 'Chưa có thời gian chính thức' : `${Math.floor(value / 60)} phút ${value % 60} giây`;
// Chỉ thông báo đậu/rớt sau khi backend đã chốt xếp hạng của vòng.
const advancement = value => value === true ? 'Được vào vòng tiếp theo' : value === false ? 'Không được vào vòng tiếp theo' : 'Kết quả sẽ được công bố sau khi vòng thi kết thúc.';

export default function CandidateWorkspace({ user, token }) {
  const [selectedRounds,setSelectedRounds]=useState({});
  // Tách tra cứu kết quả khỏi danh sách kỳ thi để thí sinh tập trung vào từng tác vụ.
  const [workspaceTab, setWorkspaceTab] = useState('exams');
  const [competitionTab, setCompetitionTab] = useState('current');
  const [filters, setFilters] = useState({ from: '', to: '' });
  const [competitionId, setCompetitionId] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [session, setSession] = useState(null);
  const [restoring, setRestoring] = useState(true);
  const action = useAction();
  const competitions = useResource(`/candidate/competitions?${queryString(filters)}`, token, refresh);
  const results = useResource(`/candidate/results?${queryString({ competitionId })}`, token, refresh);
  const items = competitions.data?.items || [];
  // Kỳ thi đã đóng hoặc qua thời điểm kết thúc được tách riêng để danh sách đang diễn ra dễ theo dõi.
  const ended = item => item.status === 'closed' || item.status === 'ended' || (item.endAt && Date.parse(item.endAt) <= Date.now());
  const visibleItems = items.filter(item => competitionTab === 'ended' ? ended(item) : !ended(item))
    .sort((left, right) => competitionTab === 'ended' ? Date.parse(right.endAt || 0) - Date.parse(left.endAt || 0) : 0);
  useEffect(() => {
    const id = readCache(activeKey(user.id));
    if (!id) { setRestoring(false); return; }
    const controller = new AbortController();
    api(`/candidate/sessions/${encodeURIComponent(id)}`, { token, signal: controller.signal }).then(payload => { if (!controller.signal.aborted) setSession(payload.item); }).catch(error => { if (!controller.signal.aborted && [403, 404].includes(error.status)) removeCache(activeKey(user.id)); }).finally(() => { if (!controller.signal.aborted) setRestoring(false); });
    return () => controller.abort();
  }, [user.id, token]);
  async function start(item) {
    await action.run(async () => {
      if (!item.registered) throw new Error('Bạn cần đăng ký cuộc thi này trước khi làm bài.');
      // Không suy ra quyền bắt đầu từ lịch, số lượt hay eligible; dùng trạng thái backend yêu cầu.
      if (item.roundId && !item.activeSessionId && item.status !== 'AVAILABLE') throw new Error('Vòng thi hiện chưa mở để bắt đầu làm bài.');
      const payload = item.activeSessionId ? await api(`/candidate/sessions/${item.activeSessionId}`, { token }) : await api(`/candidate/competitions/${item.id}/start`, { token, body: {roundId:item.roundId} });
      writeCache(activeKey(user.id), payload.item.id); setSession(payload.item);
    }, '');
  }
  if (session) return <ExamRunner key={session.id} initial={session} userId={user.id} token={token} onExit={() => { setSession(null); removeCache(activeKey(user.id)); setRefresh(value => value + 1); }} />;
  return <><nav className="tab-nav competition-tabs" aria-label="Khu vực thí sinh"><button type="button" className={workspaceTab === 'exams' ? 'active' : ''} aria-pressed={workspaceTab === 'exams'} onClick={() => setWorkspaceTab('exams')}>Kỳ thi</button><button type="button" className={workspaceTab === 'results' ? 'active' : ''} aria-pressed={workspaceTab === 'results'} onClick={() => setWorkspaceTab('results')}>Kết quả</button></nav>
    {workspaceTab === 'exams' && <section className="content-section"><div className="section-heading"><div><h2>Kỳ thi của bạn</h2><p className="section-note">Đăng ký, xem lịch và tiếp tục bài thi đang làm.</p></div><button className="secondary" onClick={() => setRefresh(value => value + 1)}>Tải lại</button></div>
      <div className="form-grid filters"><DateFilters value={filters} onChange={setFilters} /></div><nav className="tab-nav competition-tabs" aria-label="Nhóm kỳ thi"><button type="button" className={competitionTab === 'current' ? 'active' : ''} aria-pressed={competitionTab === 'current'} onClick={() => setCompetitionTab('current')}>Kỳ thi đang mở</button><button type="button" className={competitionTab === 'ended' ? 'active' : ''} aria-pressed={competitionTab === 'ended'} onClick={() => setCompetitionTab('ended')}>Kỳ thi đã kết thúc</button></nav><Notice {...action} />
      {restoring && <p role="status">Đang kiểm tra bài thi đang làm…</p>}
      <ResourceState resource={competitions} empty={!visibleItems.length}><div className="exam-grid">{visibleItems.map(competition => { const round=competition.rounds?.find(r=>String(r.id)===String(selectedRounds[competition.id]||competition.currentRoundId)); const item={...competition,...(round?{...round,id:competition.id,roundId:round.id,name:competition.name,roundName:round.name}:{})}; return <article className="exam-card" key={item.id}>
        <span className="exam-status">{item.roundId ? roundStatus(item.status, item.scheduleStatus) : competitionStatus(item.status)}</span><h3>{item.name}</h3>{competition.currentRoundId && <p>Vòng hiện tại: {competition.rounds?.find(r=>String(r.id)===String(competition.currentRoundId))?.name || 'Chưa có tên vòng từ backend'}</p>}{competition.rounds?.length>0&&<label>Vòng thi<select value={item.roundId||''} onChange={event=>setSelectedRounds({...selectedRounds,[competition.id]:event.target.value})}>{competition.rounds.map(r=><option key={r.id} value={r.id}>{r.roundNumber}. {r.name}</option>)}</select></label>}<p>{item.description}</p>{item.eligibilityMessage&&<p>{item.eligibilityMessage}</p>}<p>{formatDate(item.startAt)} → {formatDate(item.endAt)}</p><p>{item.durationMinutes} phút / lượt · Tối đa {item.maxAttempts} lượt{item.roundId ? ' / vòng' : ''}</p><p><strong>Còn {item.attemptsRemaining} lượt{item.roundId ? ' của vòng' : ''}</strong> · Đã dùng {item.attemptsUsed}</p>
        <div className="actions">{!item.registered && <button disabled={action.busy} className="secondary" onClick={() => action.run(async () => { await api(`/candidate/competitions/${item.id}/register`, { token, body: {} }); setRefresh(value => value + 1); }, 'Đã đăng ký kỳ thi.')}>Đăng ký kỳ thi</button>}
          <button disabled={!item.registered || action.busy || restoring || (!item.activeSessionId && (item.roundId ? item.status !== 'AVAILABLE' : item.attemptsRemaining <= 0 || item.status !== 'active'))} onClick={() => start(item)}>{item.activeSessionId ? 'Tiếp tục làm bài' : 'Bắt đầu làm bài'}</button></div>
        {competition.rounds?.length > 0 && <details><summary>Chi tiết cuộc thi · Danh sách vòng</summary><Table headings={['Vòng', 'Lịch thi', 'Trạng thái', 'Thao tác']} label={`Các vòng của ${competition.name}`}>{competition.rounds.map(r=><tr key={r.id}><td>{r.roundNumber}. {r.name}</td><td>{formatDate(r.startAt)} → {formatDate(r.endAt)}</td><td>{roundStatus(r.status, r.scheduleStatus)}</td><td><button className="secondary" onClick={()=>setSelectedRounds({...selectedRounds,[competition.id]:r.id})}>Chọn vòng {r.roundNumber}</button></td></tr>)}</Table></details>}
        {item.roundId && !roundStates.has(item.status) && <p role="status">Hệ thống chưa cập nhật trạng thái vòng thi. Chức năng bắt đầu bài đang tạm đóng.</p>}
        <p className="section-note">{item.registered ? 'Đã đăng ký cuộc thi.' : 'Bạn cần đăng ký cuộc thi trước khi bắt đầu làm bài.'}</p>
      </article>;})}</div></ResourceState>
    </section>}{workspaceTab === 'results' && <section className="content-section"><h2>Tra cứu kết quả của bạn</h2><div className="form-grid filters"><CompetitionSelect items={items} value={competitionId} onChange={setCompetitionId} /></div><ResourceState resource={results} empty={!results.data?.items?.length}><Table headings={['Kỳ thi / vòng', 'Lượt', 'Điểm / 100', 'Bắt đầu', 'Nộp bài', 'Thời gian', 'Hạng', 'Đi tiếp']} label="Kết quả cá nhân">{results.data?.items?.map(item => <tr key={item.id}><td>{item.competitionName}<br />{item.roundName}</td><td>{item.attemptNumber}</td><td><strong>{officialScore(item.score)}</strong></td><td>{formatDate(item.startedAt)}</td><td>{formatDate(item.finishedAt)}</td><td>{officialDuration(item.durationSeconds)}</td><td>{item.roundRank??'—'}</td><td>{advancement(item.advanced)}</td></tr>)}</Table></ResourceState></section>}
  </>;
}

// Lưu tuần tự theo revision; chỉ máy chủ quyết định hạn nộp và điểm số.
export function ExamRunner({ initial, token, userId, onExit }) {
  const key = progressKey(userId, initial.id);
  const recovered = useRef(recoverProgress(initial, readCache(key)));
  const [session, setSession] = useState(initial);
  const [answers, setAnswers] = useState(() => recovered.current?.answers || initial.answers || {});
  const [index, setIndex] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(recovered.current ? 'Đã khôi phục lựa chọn chưa đồng bộ trên thiết bị này.' : '');
  const [saveStatus, setSaveStatus] = useState(recovered.current ? 'Chờ đồng bộ' : 'Đã đồng bộ');
  const current = useRef({ session: initial, answers: recovered.current?.answers || initial.answers || {}, dirty: Boolean(recovered.current), offset: Date.parse(initial.serverNow) - Date.now() });
  const pending = useRef(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const retryAt = useRef(0);
  const left = remainingSeconds(session.expiresAt, current.current.offset, now);
  const done = session.status !== 'in_progress';
  // Điểm và thời gian của màn hình nộp bài lấy trực tiếp từ phiên vừa được backend chấm.
  const officialResult = session;
  const unanswered = session.questions.map((question, position) => !answers[question.id] ? position + 1 : null).filter(Boolean);
  const question = session.questions[index];

  function persist() {
    const value = current.current;
    if (!writeCache(key, { answers: value.answers, revision: value.session.revision, dirty: value.dirty, updatedAt: Date.now() + value.offset })) setMessage('Trình duyệt không cho lưu trên thiết bị. Hãy giữ kết nối để đồng bộ bài thi.');
  }
  function accept(item, sentAnswers, force = false) {
    if (!mounted.current) return;
    const value = current.current;
    value.offset = Date.parse(item.serverNow) - Date.now();
    value.session = item;
    if (force || item.status !== 'in_progress' || JSON.stringify(value.answers) === JSON.stringify(sentAnswers)) {
      value.answers = item.answers || {}; value.dirty = false; setAnswers(value.answers);
    }
    setSession(item); setSaveStatus(value.dirty ? 'Chờ đồng bộ' : 'Đã đồng bộ');
    if (item.status !== 'in_progress') { removeCache(key); removeCache(activeKey(userId)); }
    else persist();
  }
  async function save() {
    if (pending.current) return pending.current;
    const value = current.current;
    if (!value.dirty || value.session.status !== 'in_progress' || remainingSeconds(value.session.expiresAt, value.offset) <= 0) return;
    const sentAnswers = { ...value.answers };
    setSaveStatus('Đang đồng bộ…');
    const promise = api(`/candidate/sessions/${initial.id}/answers`, { token, method: 'PUT', body: { answers: sentAnswers, revision: value.session.revision } }).then(payload => accept(payload.item, sentAnswers)).catch(error => {
      if (!mounted.current) return;
      if (error.status === 409 && error.payload?.item) {
        accept(error.payload.item, null, true); setMessage('Bài thi đã được cập nhật ở nơi khác. Đã tải phiên bản máy chủ; hãy kiểm tra lại lựa chọn trước khi tiếp tục.');
      } else { setSaveStatus('Chưa đồng bộ'); setMessage(error.message); }
    }).finally(() => { if (pending.current === promise) pending.current = null; });
    pending.current = promise;
    return promise;
  }
  async function submit(automatic = false) {
    if (submitting.current || current.current.session.status !== 'in_progress') return;
    if (!automatic && !window.confirm(unanswered.length ? `Bạn còn bỏ trống câu ${unanswered.join(', ')}. Xác nhận nộp bài?` : 'Xác nhận nộp bài? Sau khi nộp không thể thay đổi đáp án.')) return;
    submitting.current = true; setBusy(true); setMessage('');
    try {
      if (pending.current) await pending.current;
      if (current.current.session.status !== 'in_progress') return;
      const value = current.current;
      // Hết giờ không gửi đáp án trong bộ nhớ; máy chủ chấm bản đã nhận đúng hạn.
      const body = remainingSeconds(value.session.expiresAt, value.offset) <= 0 ? {} : { answers: value.answers, revision: value.session.revision };
      const payload = await api(`/candidate/sessions/${initial.id}/submit`, { token, body });
      accept(payload.item, null, true);
    } catch (error) {
      if (!mounted.current) return;
      if (error.status === 409 && error.payload?.item) accept(error.payload.item, null, true);
      setMessage(error.message); retryAt.current = Date.now() + 5000;
    } finally { submitting.current = false; if (mounted.current) setBusy(false); }
  }
  const commands = useRef({ save, submit }); commands.current = { save, submit };
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (current.current.session.status !== 'in_progress') return;
      if (remainingSeconds(current.current.session.expiresAt, current.current.offset) <= 0) {
        if (Date.now() >= retryAt.current) commands.current.submit(true);
      } else if (!submitting.current) commands.current.save();
    }, 1000);
    const beforeUnload = event => { if (current.current.session.status === 'in_progress') { event.preventDefault(); event.returnValue = ''; } };
    const online = () => { setMessage('Đã có kết nối. Đang kiểm tra đồng bộ bài thi…'); commands.current.save(); };
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('online', online);
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('online', online); };
  }, []);
  function choose(answer) {
    if (done || busy || remainingSeconds(current.current.session.expiresAt, current.current.offset) <= 0) return;
    const next = { ...current.current.answers };
    if (answer) next[question.id] = answer; else delete next[question.id];
    current.current.answers = next; current.current.dirty = true; setAnswers(next); setSaveStatus('Chờ đồng bộ'); persist();
  }
  return <section className="content-section exam-runner">
    <div className="exam-toolbar"><div><p className="eyebrow">{session.competitionName} · Lượt {session.attemptNumber}</p><h2>{session.roundName || 'Bài thi'}</h2><p>Mã đề: {session.examCode || session.examId}</p></div>{!done && <div className={`exam-clock ${left <= 60 ? 'urgent' : ''}`} role="timer" aria-label="Thời gian còn lại">{String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}<small>Thời gian còn lại</small></div>}</div>
    <Notice text={message} error={saveStatus === 'Chưa đồng bộ'} />
    {done ? <div className="exam-result"><h3>{session.status === 'expired' ? 'Đã tự động nộp bài khi hết giờ' : 'Bài thi đã được nộp'}</h3><strong>{officialScore(officialResult.score)}</strong><p>{session.roundName}</p><p>Bắt đầu: {formatDate(officialResult.startedAt)}</p><p>Nộp bài: {formatDate(officialResult.finishedAt)}</p><p>Thời gian làm bài: {officialDuration(officialResult.durationSeconds)}</p><button onClick={onExit}>Về danh sách kỳ thi</button></div> : <>
      <div className="save-bar"><span role="status">{saveStatus} · Đã chọn {session.questions.length - unanswered.length}/{session.questions.length} câu</span><button className="secondary" disabled={busy || left <= 0} onClick={save}>Đồng bộ ngay</button></div>
      {left === 0 && <p role="alert" className="notice warning-message">Đã hết giờ. Hệ thống đang xác nhận kết quả từ đáp án đã đồng bộ.</p>}
      <div className="question-layout"><nav className="question-nav" aria-label="Chọn câu hỏi">{session.questions.map((item, position) => <button key={item.id} className={`${position === index ? 'current' : ''} ${answers[item.id] ? 'answered' : ''}`} aria-label={`Câu ${position + 1}${answers[item.id] ? ', đã chọn' : ', chưa chọn'}`} aria-current={position === index ? 'step' : undefined} onClick={() => setIndex(position)}>{position + 1}</button>)}</nav>
        {question && <div className="question-card"><h3>Câu {index + 1} / {session.questions.length}</h3><p className="question-content">{question.content}</p><fieldset disabled={busy || left <= 0}><legend className="sr-only">Chọn một đáp án cho câu {index + 1}</legend>{['A', 'B', 'C', 'D'].map(answer => <label className={`answer-option ${answers[question.id] === answer ? 'selected' : ''}`} key={answer}><input type="radio" name={`question-${question.id}`} checked={answers[question.id] === answer} onChange={() => choose(answer)} /><strong>{answer}.</strong><span>{question[`option${answer}`]}</span></label>)}<button className="text-button" onClick={() => choose(null)}>Bỏ lựa chọn câu này</button></fieldset><div className="actions"><button className="secondary" disabled={!index} onClick={() => setIndex(index - 1)}>Câu trước</button><button className="secondary" disabled={index === session.questions.length - 1} onClick={() => setIndex(index + 1)}>Câu tiếp</button></div></div>}
      </div><div className="actions"><button disabled={busy} onClick={() => submit(left <= 0)}>{busy ? 'Đang nộp…' : left <= 0 ? 'Kiểm tra kết quả nộp tự động' : 'Nộp bài'}</button><button className="secondary" disabled={busy} onClick={async () => { await save(); onExit(); }}>Lưu và về danh sách</button></div>
    </>}
  </section>;
}
