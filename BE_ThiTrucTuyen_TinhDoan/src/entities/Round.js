// Vòng thi thuộc một cuộc thi và có thời điểm bắt đầu/kết thúc chi tiết.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'Round',
  tableName: 'rounds',
  columns: {
    name: { type: String, length: 255, nullable: true },
    duration_minutes: { type: Number, unsigned: true, default: 30 },
    duration_seconds: { type: Number, unsigned: true },
    advance_count: { type: Number, unsigned: true, default: 0 },
    enabled: { type: Boolean, default: false },
    finalized_at: { type: 'datetime', nullable: true },
    id: { type: Number, unsigned: true, primary: true, generated: 'increment' },
    competition_id: { type: Number, unsigned: true },
    round_number: { type: Number, unsigned: true },
    start_datetime: { type: 'datetime' },
    end_datetime: { type: 'datetime' }
  },
  relations: { competition: { type: 'many-to-one', target: 'Competition', joinColumn: { name: 'competition_id' }, inverseSide: 'rounds' } }
});
