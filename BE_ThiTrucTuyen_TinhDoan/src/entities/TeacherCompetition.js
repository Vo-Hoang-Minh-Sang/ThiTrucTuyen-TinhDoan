// Ánh xạ dữ liệu cho chức năng thi và quản trị; cấu trúc được quản lý bằng migration.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  "name": "TeacherCompetition",
  "tableName": "teacher_competitions",
  "columns": {
    "user_id": {
      "type": "int",
      "unsigned": true,
      "primary": true
    },
    "competition_id": {
      "type": "int",
      "unsigned": true,
      "primary": true
    }
  }
});

