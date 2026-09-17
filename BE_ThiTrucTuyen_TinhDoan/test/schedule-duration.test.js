import test from 'node:test';
import assert from 'node:assert/strict';
import { competitionInput, roundInput, validateQuestion } from '../src/management/manage.js';

const competition = { start_at: '2026-10-01T08:00:00.000Z', end_at: '2026-10-01T10:00:00.000Z', duration_minutes: 30 };

test('lịch vòng phải dài hơn thời lượng làm bài, còn kỳ thi chỉ kiểm tra mốc bắt đầu và kết thúc', () => {
  // Kỳ thi nhiều vòng không có thời lượng chung; từng vòng tự xác định thời lượng làm bài.
  assert.doesNotThrow(() => competitionInput({ name: 'Kỳ thi', description: '', maxAttempts: 1, startAt: '2026-10-01T08:00:00.000Z', endAt: '2026-10-01T08:01:00.000Z' }));
  assert.throws(() => roundInput({ name: 'Vòng 1', roundNumber: 1, durationMinutes: 30, advanceCount: 0, startAt: '2026-10-01T08:00:00.000Z', endAt: '2026-10-01T08:30:00.000Z' }, competition), /lớn hơn thời lượng làm bài/);
  assert.doesNotThrow(() => roundInput({ name: 'Vòng 1', roundNumber: 1, durationMinutes: 30, advanceCount: 0, startAt: '2026-10-01T08:00:00.000Z', endAt: '2026-10-01T08:31:00.000Z' }, competition));
});

test('nhãn độ khó tiếng Việt trong Excel được chuẩn hóa trước khi lưu', () => {
  const question = { competitionId: 1, roundId: 2, content: 'Câu hỏi', optionA: 'A', optionB: 'B', optionC: 'C', optionD: 'D', correctAnswer: 'A', topic: 'Chung' };
  assert.equal(validateQuestion({ ...question, difficulty: 'Dễ' }).difficulty, 'easy');
  assert.equal(validateQuestion({ ...question, difficulty: 'Trung bình' }).difficulty, 'medium');
  assert.equal(validateQuestion({ ...question, difficulty: 'Khó' }).difficulty, 'hard');
});
