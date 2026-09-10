// Ánh xạ dữ liệu cho chức năng thi và quản trị; cấu trúc được quản lý bằng migration.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  "name": "SiteAsset",
  "tableName": "site_assets",
  "columns": {
    "id": {
      "type": "varchar",
      "length": 36,
      "primary": true
    },
    "original_name": {
      "type": "varchar",
      "length": 255
    },
    "kind": {
      "type": "varchar",
      "length": 20
    },
    "mime_type": {
      "type": "varchar",
      "length": 100
    },
    "path": {
      "type": "varchar",
      "length": 255
    },
    "created_by": {
      "type": "int",
      "unsigned": true,
      "nullable": true
    },
    "created_at": {
      "type": "datetime",
      "createDate": true
    }
  }
});

