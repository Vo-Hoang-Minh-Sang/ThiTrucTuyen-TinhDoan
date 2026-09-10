// Vòng thi thuộc một cuộc thi và có thời điểm bắt đầu/kết thúc chi tiết.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  name: 'Round',
  tableName: 'rounds',
  columns: {
    id: { type: Number, unsigned: true, primary: true, generated: 'increment' },
    competition_id: { type: Number, unsigned: true },
    round_number: { type: Number, unsigned: true },
    start_datetime: { type: 'datetime' },
    end_datetime: { type: 'datetime' }
  },
  relations: { competition: { type: 'many-to-one', target: 'Competition', joinColumn: { name: 'competition_id' }, inverseSide: 'rounds' } }
});
