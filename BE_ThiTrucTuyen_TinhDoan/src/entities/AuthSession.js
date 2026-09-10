// Ánh xạ dữ liệu cho chức năng thi và quản trị; cấu trúc được quản lý bằng migration.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  "name": "AuthSession",
  "tableName": "auth_sessions",
  "columns": {
    "id": {
      "type": "varchar",
      "length": 36,
      "primary": true
    },
    "user_id": {
      "type": "int",
      "unsigned": true
    },
    "expires_at": {
      "type": "datetime"
    },
    "revoked_at": {
      "type": "datetime",
      "nullable": true
    },
    "created_at": {
      "type": "datetime",
      "createDate": true
    }
  }
});

