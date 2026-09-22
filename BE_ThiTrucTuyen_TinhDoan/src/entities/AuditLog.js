// Ánh xạ dữ liệu cho chức năng thi và quản trị; cấu trúc được quản lý bằng migration.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  "name": "AuditLog",
  "tableName": "audit_logs",
  "columns": {
    "id": {
      "type": "bigint",
      "unsigned": true,
      "primary": true,
      "generated": "increment"
    },
    "actor_id": {
      "type": "int",
      "unsigned": true,
      "nullable": true
    },
    "action": {
      "type": "varchar",
      "length": 80
    },
    "target_type": {
      "type": "varchar",
      "length": 50
    },
    "target_id": {
      "type": "varchar",
      "length": 64,
      "nullable": true
    },
    "details": {
      "type": "json",
      "nullable": true
    },
    "created_at": {
      "type": "datetime",
      "createDate": true
    }
  }
});
