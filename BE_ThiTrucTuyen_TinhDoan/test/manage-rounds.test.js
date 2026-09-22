// Kiểm tra dữ liệu vòng trả về luôn có trạng thái bật để frontend không loại nhầm vòng hợp lệ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roundPayload } from '../src/management/manage.js';

test('round payload exposes enabled state and multi-round configuration', () => {
  const item = roundPayload({
    id: 8,
    competition_id: 3,
    name: 'Vòng kiến thức',
    round_number: 2,
    duration_minutes: 25,
    advance_count: 15,
    enabled: 1,
    finalized_at: null,
    start_datetime: '2026-09-14T08:00:00.000Z',
    end_datetime: '2026-09-14T09:00:00.000Z'
  });
  assert.deepEqual(item, {
    id: 8,
    competitionId: 3,
    name: 'Vòng kiến thức',
    roundNumber: 2,
    durationMinutes: 25, durationSeconds: 1500,
    advanceCount: 15,
    enabled: true,
    finalized: false,
    finalizedAt: null,
    startAt: '2026-09-14T08:00:00.000Z',
    endAt: '2026-09-14T09:00:00.000Z'
  });
});
