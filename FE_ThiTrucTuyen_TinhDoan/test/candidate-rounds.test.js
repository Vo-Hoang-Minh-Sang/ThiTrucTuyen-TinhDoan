import assert from 'node:assert/strict';
import { mkdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import React from 'react';
import { act, create } from 'react-test-renderer';

const output = resolve('.test-build', `candidate-rounds-${randomUUID()}.mjs`);
await mkdir(resolve('.test-build'), { recursive: true });
await build({ entryPoints: ['src/candidate/CandidateWorkspace.jsx'], outfile: output, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external', define: { 'import.meta.env': '{}' } });
const { default: CandidateWorkspace, ExamRunner } = await import(pathToFileURL(output).href);
after(() => unlink(output));

test('chọn vòng đủ điều kiện, gửi đúng roundId và hiển thị thời gian / thứ hạng', async t => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    let payload;
    if (url.includes('/competitions?')) payload = { success: true, items: [{ id: 7, name: 'Cuộc thi', registered: true, maxAttempts: 2, currentRoundId: 2, rounds: [
      { id: 1, name: 'Sơ loại', roundNumber: 1, status: 'COMPLETED', eligible: false, attemptsRemaining: 0 },
      { id: 2, name: 'Chung kết', roundNumber: 2, status: 'AVAILABLE', eligible: true, attemptsRemaining: 2 },
      { id: 3, name: 'Vòng bị khóa', roundNumber: 3, status: 'LOCKED', eligible: true, attemptsRemaining: 2 },
      { id: 4, name: 'API cũ', roundNumber: 4, status: 'active', eligible: true, attemptsRemaining: 2 }
    ] }] };
    else if (url.includes('/results?')) payload = { success: true, items: [{ id: 1, competitionName: 'Cuộc thi', roundName: 'Sơ loại', roundId: 1, score: 100, durationSeconds: 75, roundRank: 1, advanced: true, startedAt: '2026-09-14T01:00:00Z', finishedAt: '2026-09-14T01:01:15Z' }] };
    else return new Response(JSON.stringify({ success: false, message: 'Dừng sau kiểm tra dữ liệu gửi.' }), { status: 409 });
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  let renderer;
  t.after(() => { act(() => renderer?.unmount()); globalThis.fetch = previous; });
  await act(async () => { renderer = create(React.createElement(CandidateWorkspace, { user: { id: 123 }, token: 'test-token' })); });
  const button = () => renderer.root.findAllByType('button').find(node => node.children.join('') === 'Bắt đầu làm bài');
  assert.equal(Boolean(button().props.disabled), false);
  assert.match(JSON.stringify(renderer.toJSON()), /1 phút 15 giây/);
  assert.match(JSON.stringify(renderer.toJSON()), /Được vào vòng tiếp theo/);
  const selector = renderer.root.findAllByType('select').find(node => Number(node.props.value) === 2);
  act(() => selector.props.onChange({ target: { value: '1' } }));
  assert.equal(button().props.disabled, true);
  for (const value of ['3', '4']) {
    act(() => selector.props.onChange({ target: { value } }));
    assert.equal(button().props.disabled, true);
    // Gọi trực tiếp handler cũng không được bỏ qua điều kiện AVAILABLE.
    await act(async () => { await button().props.onClick(); });
    assert.equal(calls.filter(call => call.url.endsWith('/start')).length, 0);
  }
  act(() => selector.props.onChange({ target: { value: '2' } }));
  await act(async () => { await button().props.onClick(); });
  assert.deepEqual(calls.find(call => call.url.endsWith('/start')).body, { roundId: 2 });
});

test('làm bài hiển thị cuộc thi/vòng/đồng hồ; nộp xong chỉ hiển thị điểm và thời gian từ backend', async t => {
  const oldFetch = globalThis.fetch, oldWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, confirm: () => true };
  const initial = { id: 99, competitionId: 7, competitionName: 'Cuộc thi thử', roundId: 2, roundName: 'Vòng chung kết', examName: 'Đề số 1', attemptNumber: 1, status: 'in_progress', startedAt: '2026-09-14T01:00:00Z', serverNow: new Date().toISOString(), expiresAt: new Date(Date.now()+600000).toISOString(), revision: 0, answers: {}, questions: [{ id: 1, content: 'Câu hỏi', optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D' }] };
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/submit')) {
      assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(), ['answers', 'revision']);
      return new Response(JSON.stringify({ success: true, item: { ...initial, status: 'submitted', score: 80, durationSeconds: 123, finishedAt: '2026-09-14T01:02:03Z' } }));
    }
    throw new Error(`Không mong đợi yêu cầu ${url}`);
  };
  let renderer;
  t.after(() => { act(() => renderer?.unmount()); globalThis.fetch=oldFetch; globalThis.window=oldWindow; });
  await act(async () => { renderer=create(React.createElement(ExamRunner,{initial,userId:123,token:'test',onExit(){}})); });
  assert.match(JSON.stringify(renderer.toJSON()), /Cuộc thi thử/);
  assert.match(JSON.stringify(renderer.toJSON()), /Vòng chung kết/);
  assert.equal(renderer.root.findAll(node=>node.props.role==='timer').length,1);
  await act(async () => { await renderer.root.findAllByType('button').find(node=>node.children.join('')==='Nộp bài').props.onClick(); });
  const rendered=JSON.stringify(renderer.toJSON());
  assert.match(rendered,/80 \/ 100/);
  assert.match(rendered,/2 phút 3 giây/);
  assert.ok(!rendered.includes('Thứ hạng:'));
  assert.ok(!rendered.includes('vào vòng tiếp theo'));
  assert.equal(renderer.root.findAll(node=>node.props.role==='timer').length,0);
});

test('thiếu dữ liệu phiên không tự điền điểm hoặc thời gian bằng 0', async t => {
  const oldFetch=globalThis.fetch, oldWindow=globalThis.window;
  globalThis.window={addEventListener(){},removeEventListener(){}};
  globalThis.fetch=async()=>new Response(JSON.stringify({success:true,items:[]}));
  let renderer;
  t.after(()=>{act(()=>renderer?.unmount());globalThis.fetch=oldFetch;globalThis.window=oldWindow;});
  await act(async()=>{renderer=create(React.createElement(ExamRunner,{initial:{id:1,competitionId:2,roundId:3,status:'submitted',questions:[],answers:{},serverNow:new Date().toISOString()},userId:123,token:'test',onExit(){}}));});
  const rendered=JSON.stringify(renderer.toJSON());
  for(const text of ['Chưa có điểm','Chưa có thời gian chính thức']) assert.ok(rendered.includes(text));
  assert.ok(!rendered.includes('Thứ hạng:'));
  assert.ok(!rendered.includes('trạng thái đi tiếp'));
  assert.ok(!rendered.includes('0 / 100'));
});
