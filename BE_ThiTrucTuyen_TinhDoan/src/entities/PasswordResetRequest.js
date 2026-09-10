// Ánh xạ dữ liệu cho chức năng thi và quản trị; cấu trúc được quản lý bằng migration.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  "name": "PasswordResetRequest",
  "tableName": "password_reset_requests",
  "columns": {
    "id": {
      "type": "bigint",
      "unsigned": true,
      "primary": true,
      "generated": "increment"
    },
    "user_id": {
      "type": "int",
      "unsigned": true
    },
    "status": {
      "type": "varchar",
      "length": 20,
      "default": "pending"
    },
    "created_at": {
      "type": "datetime",
      "createDate": true
    },
    "resolved_at": {
      "type": "datetime",
      "nullable": true
    },
    "resolved_by": {
      "type": "int",
      "unsigned": true,
      "nullable": true
    }
  }
});

