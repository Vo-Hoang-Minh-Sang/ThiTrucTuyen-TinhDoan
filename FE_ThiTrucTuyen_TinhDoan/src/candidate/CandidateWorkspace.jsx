import { useEffect, useRef, useState } from 'react';
import { api } from '../shared/api';
import { activeKey, progressKey, readCache, recoverProgress, removeCache, remainingSeconds, writeCache } from './examProgress';
import { CompetitionSelect, DateFilters, Notice, Pagination, ResourceState, Table, formatDate, queryString, useAction, useResource } from '../shared/ui';

const roundStates = new Set(['COMPLETED', 'AVAILABLE', 'LOCKED']);
// Mã trạng thái vẫn dùng để quyết định quyền làm bài; chỉ phần chữ hiển thị được Việt hóa cho thí sinh.
const roundStatus = (value, scheduleStatus) => {
  if (!roundStates.has(value)) return 'Chưa cập nhật trạng thái';
  if (scheduleStatus === 'upcoming') return 'Chưa diễn ra';
  if (scheduleStatus === 'ended' || value === 'COMPLETED') return 'Đã kết thúc';
  if (value === 'AVAILABLE') return 'Đang diễn ra';
  return 'Đóng';
};
const competitionStatus = value => ({ unscheduled: 'Chưa có lịch', upcoming: 'Chưa diễn ra', active: 'Đang diễn ra', paused: 'Tạm đóng', ended: 'Đã kết thúc', closed: 'Đóng' }[value] || 'Chưa cập nhật trạng thái');
const officialScore = value => value == null ? 'Chưa có điểm' : `${Number(value).toLocaleString('vi-VN')} \u0111i\u1ec3m`;
const officialDuration = value => value == null ? 'Chưa có thời gian chính thức' : `${Math.floor(value / 60)} phút ${value % 60} giây`;
// Chỉ thông báo đậu/rớt sau khi backend đã chốt xếp hạng của vòng.
const advancement = value => value === true ? 'Được vào vòng tiếp theo' : value === false ? 'Không được vào vòng tiếp theo' : 'Kết quả sẽ được công bố sau khi vòng thi kết thúc.';

export default function CandidateWorkspace({ user, token, units = [], initialTab = 'competitions' }) {
  const [selectedRounds,setSelectedRounds]=useState({});
  // Tách tra cứu kết quả khỏi danh sách kỳ thi để thí sinh tập trung vào từng tác vụ.
  const [workspaceTab, setWorkspaceTab] = useState('competitions');
  const [competitionTab, setCompetitionTab] = useState('current');
  const [filters, setFilters] = useState({ from: '', to: '' });
  const [competitionId, setCompetitionId] = useState('');
  const [resultPage, setResultPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [session, setSession] = useState(null);
  const [restoring, setRestoring] = useState(true);
  const action = useAction();
  // Menu đầu trang quyết định khu vực cần mở; không để lại thanh tab trùng lặp trong nội dung.
  // Giữ đúng màn hình được chọn từ menu: danh sách cuộc thi để đăng ký, làm bài thi để bắt đầu vòng đang mở.
  useEffect(() => { setWorkspaceTab(['competitions', 'exams', 'results'].includes(initialTab) ? initialTab : 'competitions'); }, [initialTab]);
  const competitions = useResource(`/candidate/competitions?${queryString(filters)}`, token, refresh);
  const results = useResource(`/candidate/results?${queryString({ competitionId })}`, token, refresh);
  const items = competitions.data?.items || [];
  // Kỳ thi đã đóng hoặc qua thời điểm kết thúc được tách riêng để danh sách đang diễn ra dễ theo dõi.
  const ended = item => item.status === 'closed' || item.status === 'ended' || (item.endAt && Date.parse(item.endAt) <= Date.now());
  const visibleItems = items.filter(item => competitionTab === 'ended' ? ended(item) : !ended(item))
    .sort((left, right) => competitionTab === 'ended' ? Date.parse(right.endAt || 0) - Date.parse(left.endAt || 0) : 0);
  // Mục làm bài chỉ hiển thị vòng đã đăng ký và được máy chủ cho phép bắt đầu hoặc tiếp tục.
  const takingItems = visibleItems.filter(item => item.registered && item.rounds?.some(round => round.status === 'AVAILABLE' || round.activeSessionId));
  // Tab da ket thuc phai hien day du lich su, khong ap dung bo loc chi duoc lam bai.
  const displayedItems = workspaceTab === 'competitions' || competitionTab === 'ended' ? visibleItems : takingItems;
  useEffect(() => {
    const id = readCache(activeKey(user.id));
    if (!id) { setRestoring(false); return; }
    const controller = new AbortController();
    api(`/candidate/sessions/${encodeURIComponent(id)}`, { token, signal: controller.signal }).then(payload => { if (!controller.signal.aborted) setSession(payload.item); }).catch(error => { if (!controller.signal.aborted && [403, 404].includes(error.status)) removeCache(activeKey(user.id)); }).finally(() => { if (!controller.signal.aborted) setRestoring(false); });
    return () => controller.abort();
  }, [user.id, token]);
  async function start(item) {
    await action.run(async () => {
      // Backend confirms registration before opening the session.
      if (item.roundId && !item.activeSessionId && item.status !== 'AVAILABLE') throw new Error('Vòng thi hiện chưa mở để bắt đầu làm bài.');
      const payload = item.activeSessionId ? await api(`/candidate/sessions/${item.activeSessionId}`, { token }) : await api(`/candidate/competitions/${item.id}/start`, { token, body: {roundId:item.roundId} });
      writeCache(activeKey(user.id), payload.item.id); setSession(payload.item);
    }, '');
  }
  const unitName = user.unitName || user.donvi?.ten || units.find(item => String(item.id) === String(user.donviID))?.ten || '';
  if (session) return <ExamRunner key={session.id} initial={session} candidate={user} unitName={unitName} userId={user.id} token={token} onExit={() => { setSession(null); setWorkspaceTab('competitions'); removeCache(activeKey(user.id)); setRefresh(value => value + 1); }} />;
  return <>{['competitions', 'exams'].includes(workspaceTab) && <section id="candidate-competitions" className="content-section"><div className="section-heading"><div><h2>{workspaceTab === 'competitions' ? 'Danh sách cuộc thi' : 'Làm bài thi'}</h2><p className="section-note">{workspaceTab === 'competitions' ? 'Xem thông tin và đăng ký các cuộc thi.' : 'Chọn vòng đang mở để bắt đầu hoặc tiếp tục làm bài.'}</p></div><button className="secondary" onClick={() => setRefresh(value => value + 1)}>Tải lại</button></div>
      <div className="form-grid filters"><DateFilters value={filters} onChange={setFilters} /></div><nav className="tab-nav competition-tabs" aria-label="Nhóm kỳ thi"><button type="button" className={competitionTab === 'current' ? 'active' : ''} aria-pressed={competitionTab === 'current'} onClick={() => setCompetitionTab('current')}>Kỳ thi đang mở</button><button type="button" className={competitionTab === 'ended' ? 'active' : ''} aria-pressed={competitionTab === 'ended'} onClick={() => setCompetitionTab('ended')}>Kỳ thi đã kết thúc</button></nav><Notice {...action} />
      {restoring && <p role="status">Đang kiểm tra bài thi đang làm…</p>}
      <ResourceState resource={competitions} empty={!displayedItems.length}><div className="exam-grid">{displayedItems.map(competition => { const round=competition.rounds?.find(r=>String(r.id)===String(selectedRounds[competition.id]||competition.currentRoundId)); const item={...competition,...(round?{...round,id:competition.id,roundId:round.id,name:competition.name,roundName:round.name}:{})}; return <article className="exam-card" key={item.id}>
        <span className="exam-status">{!item.registered && competition.status === 'active' ? 'Chưa đăng ký' : item.roundId ? roundStatus(item.status, item.scheduleStatus) : competitionStatus(item.status)}</span><h3>{item.name}</h3>{competition.currentRoundId && <p>Vòng hiện tại: {competition.rounds?.find(r=>String(r.id)===String(competition.currentRoundId))?.name || 'Chưa có tên vòng từ backend'}</p>}{competition.rounds?.length>0&&<label>Vòng thi<select value={item.roundId||''} onChange={event=>setSelectedRounds({...selectedRounds,[competition.id]:event.target.value})}>{competition.rounds.map(r=><option key={r.id} value={r.id}>{r.roundNumber}. {r.name}</option>)}</select></label>}<p>{item.description}</p>{item.eligibilityMessage&&<p>{item.eligibilityMessage}</p>}<p>{formatDate(item.startAt)} → {formatDate(item.endAt)}</p><p>{item.durationMinutes} phút / lượt · Tối đa {item.maxAttempts} lượt{item.roundId ? ' / vòng' : ''}</p><p><strong>Còn {item.attemptsRemaining} lượt{item.roundId ? ' của vòng' : ''}</strong> · Đã dùng {item.attemptsUsed}</p>
        <div className="actions">{workspaceTab === 'competitions' && !item.registered && !ended(competition) && <button disabled={action.busy} className="secondary" onClick={() => action.run(async () => { await api(`/candidate/competitions/${item.id}/register`, { token, body: {} }); setCompetitionTab('current'); setWorkspaceTab('exams'); setRefresh(value => value + 1); }, 'Đã đăng ký kỳ thi.')}>Đăng ký kỳ thi</button>}
          {workspaceTab === 'competitions' && item.activeSessionId && <button disabled={action.busy || restoring} onClick={() => start(item)}>Tiếp tục làm bài</button>}
          {workspaceTab === 'exams' && <button disabled={action.busy || restoring || (!item.activeSessionId && (item.roundId ? item.status !== 'AVAILABLE' : item.attemptsRemaining <= 0 || item.status !== 'active'))} onClick={() => start(item)}>{item.activeSessionId ? 'Tiếp tục làm bài' : 'Bắt đầu làm bài'}</button>}{workspaceTab === 'competitions' && item.registered && !item.activeSessionId && !ended(competition) && (item.roundId ? item.status === 'AVAILABLE' && item.attemptsRemaining > 0 : item.status === 'active' && item.attemptsRemaining > 0) && <button disabled={action.busy || restoring} onClick={() => start(item)}>{'B\u1eaft \u0111\u1ea7u l\u01b0\u1ee3t thi ti\u1ebfp theo'}</button>}</div>
        {competition.rounds?.length > 0 && <details><summary>Chi tiết cuộc thi · Danh sách vòng</summary><Table headings={['Vòng', 'Lịch thi', 'Trạng thái', 'Thao tác']} label={`Các vòng của ${competition.name}`}>{competition.rounds.map(r=><tr key={r.id}><td>{r.roundNumber}. {r.name}</td><td>{formatDate(r.startAt)} → {formatDate(r.endAt)}</td><td>{roundStatus(r.status, r.scheduleStatus)}</td><td><button className="secondary" onClick={()=>setSelectedRounds({...selectedRounds,[competition.id]:r.id})}>Chọn vòng {r.roundNumber}</button></td></tr>)}</Table></details>}
        {item.roundId && !roundStates.has(item.status) && <p role="status">Hệ thống chưa cập nhật trạng thái vòng thi. Chức năng bắt đầu bài đang tạm đóng.</p>}
        {workspaceTab === 'competitions' && <p className="section-note">{item.registered ? 'Đã đăng ký cuộc thi.' : 'Bạn cần đăng ký cuộc thi trước khi bắt đầu làm bài.'}</p>}
      </article>;})}</div></ResourceState>
    </section>}{workspaceTab === 'results' && <section className="content-section"><h2>Tra cứu kết quả của bạn</h2><div className="form-grid filters"><CompetitionSelect items={items} value={competitionId} onChange={value => { setCompetitionId(value); setResultPage(1); }} /></div><ResourceState resource={results} empty={!results.data?.items?.length}><Table headings={['Kỳ thi / vòng', 'Lượt', 'Điểm \u0111i\u1ec3m', 'Bắt đầu', 'Nộp bài', 'Thời gian', 'Hạng', 'Đi tiếp']} label="Kết quả cá nhân">{(results.data?.items || []).slice((resultPage - 1) * 10, resultPage * 10).map(item => <tr key={item.id}><td>{item.competitionName}<br />{item.roundName}</td><td>{item.attemptNumber}</td><td><strong>{officialScore(item.score)}</strong></td><td>{formatDate(item.startedAt)}</td><td>{formatDate(item.finishedAt)}</td><td>{officialDuration(item.durationSeconds)}</td><td>{item.roundRank??'—'}</td><td>{advancement(item.advanced)}</td></tr>)}</Table><Pagination total={(results.data?.items || []).length} pageSize={10} page={resultPage} onChange={setResultPage} /></ResourceState></section>}
  </>;
}

// Lưu tuần tự theo revision; chỉ máy chủ quyết định hạn nộp và điểm số.
export function ExamRunner({ initial, candidate, unitName, token, userId, onExit }) {
  const key = progressKey(userId, initial.id);
  const recovered = useRef(recoverProgress(initial, readCache(key)));
  const [session, setSession] = useState(initial);
  const [answers, setAnswers] = useState(() => recovered.current?.answers || initial.answers || {});
  // M?i l?n ch? hi?n th? m?t c?u ?? th? sinh t?p trung v?o c?u ?ang l?m.
  const questionsPerPage = 1;
  const [questionPage, setQuestionPage] = useState(1);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  // Hộp thoại xác nhận chỉ dùng cho thao tác nộp bài chủ động của thí sinh.
  const [submitConfirmation, setSubmitConfirmation] = useState(false);
  const [message, setMessage] = useState(recovered.current ? 'Đã khôi phục lựa chọn chưa đồng bộ trên thiết bị này.' : '');
  const [saveStatus, setSaveStatus] = useState(recovered.current ? 'Chờ đồng bộ' : 'Đã đồng bộ');
  const current = useRef({ session: initial, answers: recovered.current?.answers || initial.answers || {}, dirty: Boolean(recovered.current), offset: Date.parse(initial.serverNow) - Date.now() });
  const pending = useRef(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const retryAt = useRef(0);
  const questionRef = useRef(null);
  const left = remainingSeconds(session.expiresAt, current.current.offset, now);
  const done = session.status !== 'in_progress';
  // Khi quản trị viên tạm đóng, chỉ giữ lựa chọn cục bộ; không gửi thêm dữ liệu lên máy chủ.
  const paused = Boolean(session.paused);
  // Điểm và thời gian của màn hình nộp bài lấy trực tiếp từ phiên vừa được backend chấm.
  const officialResult = session;
  const unanswered = session.questions.map((question, position) => !answers[question.id] ? position + 1 : null).filter(Boolean);
  const totalQuestionPages = Math.max(1, Math.ceil(session.questions.length / questionsPerPage));
  const pageStart = (questionPage - 1) * questionsPerPage;
  const pageQuestions = session.questions.slice(pageStart, pageStart + questionsPerPage);

  useEffect(() => {
    // Khi vừa vào phòng thi, đưa ngay câu đầu tiên vào vùng nhìn thấy của thí sinh.
    const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : callback => setTimeout(callback, 0);
    const cancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout;
    const frame = schedule(() => questionRef.current?.scrollIntoView?.({ block: 'start', behavior: 'auto' }));
    return () => cancel(frame);
  }, [questionPage]);

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
    if (!value.dirty || value.session.status !== 'in_progress' || value.session.paused || remainingSeconds(value.session.expiresAt, value.offset) <= 0) return;
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
    if (submitting.current || current.current.session.status !== 'in_progress' || current.current.session.paused) return;
    submitting.current = true; setBusy(true); setMessage('');
    try {
      if (pending.current) await pending.current;
      if (current.current.session.status !== 'in_progress' || current.current.session.paused) return;
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
      if (current.current.session.status !== 'in_progress' || current.current.session.paused) return;
      setNow(Date.now());
      if (remainingSeconds(current.current.session.expiresAt, current.current.offset) <= 0) {
        if (Date.now() >= retryAt.current) commands.current.submit(true);
      } else if (!submitting.current) commands.current.save();
    }, 1000);
    const beforeUnload = event => { if (current.current.session.status === 'in_progress') { event.preventDefault(); event.returnValue = ''; } };
    const online = () => { setMessage('Đã có kết nối. Đang kiểm tra đồng bộ bài thi…'); commands.current.save(); };
    window.addEventListener('beforeunload', beforeUnload); window.addEventListener('online', online);
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('online', online); };
  }, []);
  useEffect(() => {
    // Kiểm tra định kỳ để thông báo tạm đóng nhanh cả khi thí sinh đang ở màn hình làm bài.
    const poll = setInterval(() => {
      if (current.current.session.status !== 'in_progress') return;
      api(`/candidate/sessions/${initial.id}/status`, { token }).then(payload => {
        // Không gọi accept ở đây vì đáp án cục bộ chưa đồng bộ trong lúc tạm dừng phải được giữ nguyên.
        const wasPaused = Boolean(current.current.session.paused);
        current.current.offset = Date.parse(payload.item.serverNow) - Date.now();
        // Khi mở lại, backend đã gia hạn expiresAt theo thời gian tạm dừng; phải thay giá trị cũ ở trình duyệt.
        current.current.session = { ...current.current.session, status: payload.item.status, paused: payload.item.paused, expiresAt: payload.item.expiresAt || current.current.session.expiresAt, serverNow: payload.item.serverNow };
        setSession(current.current.session);
        if (payload.item.paused) setMessage('Cuộc thi đang bị tạm dừng. Các lựa chọn hiện tại chỉ được giữ trên thiết bị và chưa gửi lên hệ thống.');
        else if (wasPaused) { setNow(Date.now()); setMessage('Cuộc thi đã mở lại. Hệ thống sẽ đồng bộ các lựa chọn của bạn.'); }
      }).catch(error => { if (error.code === 'COMPETITION_PAUSED') setMessage('Cuộc thi đang bị tạm dừng.'); });
    }, 5000);
    return () => clearInterval(poll);
  }, [initial.id, token]);
  function choose(questionId, answer) {
    if (done || paused || busy || remainingSeconds(current.current.session.expiresAt, current.current.offset) <= 0) return;
    const next = { ...current.current.answers };
    if (answer) next[questionId] = answer; else delete next[questionId];
    current.current.answers = next; current.current.dirty = true; setAnswers(next); setSaveStatus('Cho dong bo'); persist();
  }
  function openQuestionPage(value) {
    setQuestionPage(Math.min(totalQuestionPages, Math.max(1, value)));
  }
  return <section className="content-section exam-runner">
    <div className="exam-toolbar"><div><p className="eyebrow">{session.competitionName} {'\u00b7'} {'L\u01b0\u1ee3t'} {session.attemptNumber}</p><h2>{session.roundName || 'B\u00e0i thi'}</h2><p>{'M\u00e3 \u0111\u1ec1:'} {session.examCode || session.examId}</p></div><div className="exam-toolbar-right"><div className="exam-candidate-info" aria-label={'Th\u00f4ng tin th\u00ed sinh'}><strong>{candidate?.hoten || 'Th\u00ed sinh'}</strong>{candidate?.dienthoai && <span>{candidate.dienthoai}</span>}{unitName && <span>{unitName}</span>}</div>{!done && <div className={`exam-clock mobile-exam-clock ${paused ? 'paused' : ''} ${left <= 60 ? 'urgent' : ''}`} role="timer" aria-label={'Th\u1eddi gian c\u00f2n l\u1ea1i'}>{String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}<small>{paused ? '\u0110\u1ed3ng h\u1ed3 t\u1ea1m d\u1eebng' : 'Th\u1eddi gian c\u00f2n l\u1ea1i'}</small></div>}</div></div>
    {submitConfirmation && <div className="notice-modal-backdrop" role="presentation"><section className="notice-modal submit-confirmation" role="dialog" aria-modal="true" aria-labelledby="submit-exam-title"><h2 id="submit-exam-title">Xác nhận nộp bài</h2><p>{unanswered.length ? <>Bạn còn <strong>{unanswered.length}</strong> câu chưa làm: {unanswered.join(', ')}.</> : 'Bạn đã trả lời đủ các câu hỏi.'}</p><p>Sau khi nộp bài, bạn không thể thay đổi đáp án.</p><div className="actions"><button className="submit-exam" disabled={busy || paused} onClick={() => { setSubmitConfirmation(false); submit(); }}>Xác nhận nộp bài</button><button type="button" className="secondary" disabled={busy} onClick={() => setSubmitConfirmation(false)}>Quay lại làm bài</button></div></section></div>}
    <Notice text={message} error={saveStatus === 'Chưa đồng bộ'} />
    {done ? <div className="exam-result"><h3>{session.status === 'expired' ? 'Đã tự động nộp bài khi hết giờ' : 'Bài thi đã được nộp'}</h3><strong>{officialScore(officialResult.score)}</strong><p>{session.roundName}</p><p>Bắt đầu: {formatDate(officialResult.startedAt)}</p><p>Nộp bài: {formatDate(officialResult.finishedAt)}</p><p>Thời gian làm bài: {officialDuration(officialResult.durationSeconds)}</p><button onClick={onExit}>Về danh sách kỳ thi</button></div> : <>
      {paused && <p role="alert" className="notice warning-message">Cuộc thi đang bị tạm dừng.</p>}
      {left === 0 && <p role="alert" className="notice warning-message">Đã hết giờ. Hệ thống đang xác nhận kết quả từ đáp án đã đồng bộ.</p>}
      <div className="question-layout"><div className="question-page"><div className="question-page-heading"><strong>{'Câu'} {questionPage}/{totalQuestionPages}</strong><span>{'Câu'} {pageStart + 1} / {session.questions.length}</span></div>{pageQuestions.map((question, offset) => { const position = pageStart + offset; return <article ref={questionRef} className="question-card" key={question.id}><h3>{'C\u00e2u'} {position + 1} / {session.questions.length}</h3><p className="question-content">{question.content}</p><fieldset className="answer-list" disabled={paused || busy || left <= 0}><legend className="sr-only">{'Ch\u1ecdn m\u1ed9t \u0111\u00e1p \u00e1n cho c\u00e2u '} {position + 1}</legend>{['A', 'B', 'C', 'D'].map(answer => <label className={`answer-option ${answers[question.id] === answer ? 'selected' : ''}`} key={answer}><input type="radio" name={`question-${question.id}`} checked={answers[question.id] === answer} onChange={() => choose(question.id, answer)} /><strong>{answer}.</strong><span>{question[`option${answer}`]}</span></label>)}</fieldset></article>; })}<div className="actions question-actions page-actions"><button type="button" className="secondary" disabled={questionPage <= 1} onClick={() => openQuestionPage(questionPage - 1)}>{'\u2190 C\u00e2u tr\u01b0\u1edbc'}</button><span>{'C\u00e2u'} {questionPage}/{totalQuestionPages}</span><button type="button" className="secondary" disabled={questionPage >= totalQuestionPages} onClick={() => openQuestionPage(questionPage + 1)}>{'C\u00e2u ti\u1ebfp theo \u2192'}</button></div></div><aside className="question-sidebar">{!done && <div className={`exam-clock desktop-exam-clock ${paused ? 'paused' : ''} ${left <= 60 ? 'urgent' : ''}`} aria-label={'Th\u1eddi gian c\u00f2n l\u1ea1i'}>{String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}<small>{paused ? '\u0110\u1ed3ng h\u1ed3 t\u1ea1m d\u1eebng' : 'Th\u1eddi gian c\u00f2n l\u1ea1i'}</small></div>}<div className="progress-panel"><strong>{'Ti\u1ebfn \u0111\u1ed9'}</strong><span>{session.questions.length - unanswered.length}/{session.questions.length} {'\u0111\u00e3 tr\u1ea3 l\u1eddi'}</span><div className="progress-track"><i style={{ width: `${Math.round((session.questions.length - unanswered.length) * 100 / session.questions.length)}%` }} /></div></div><strong className="question-list-title">{'Danh s\u00e1ch c\u00e2u'}</strong><nav className="question-nav" aria-label={'Ch\u1ecdn c\u00e2u h\u1ecfi'}>{session.questions.map((item, position) => <button type="button" key={item.id} className={`${Math.floor(position / questionsPerPage) + 1 === questionPage ? 'page-current' : ''} ${answers[item.id] ? 'answered' : ''}`} aria-label={`${'C\u00e2u'} ${position + 1}${answers[item.id] ? ', \u0111\u00e3 ch\u1ecdn' : ', ch\u01b0a ch\u1ecdn'}`} aria-current={Math.floor(position / questionsPerPage) + 1 === questionPage ? 'page' : undefined} onClick={() => openQuestionPage(Math.floor(position / questionsPerPage) + 1)}>{position + 1}</button>)}</nav><p className="question-legend"><span className="answered-dot" />{'\u0110\u00e3 l\u00e0m'} <span className="empty-dot" />{'Ch\u01b0a l\u00e0m'}</p></aside>
      </div><div className="actions exam-actions"><button className="submit-exam" disabled={paused || busy} onClick={() => { if (left <= 0) submit(true); else setSubmitConfirmation(true); }}>{busy ? 'Đang nộp…' : left <= 0 ? 'Kiểm tra kết quả nộp tự động' : 'Nộp bài'}</button><button className="secondary" disabled={busy} onClick={async () => { if (!paused) await save(); onExit(); }}>{paused ? 'Về danh sách kỳ thi' : 'Lưu và về danh sách'}</button></div>
    </>}
  </section>;
}
