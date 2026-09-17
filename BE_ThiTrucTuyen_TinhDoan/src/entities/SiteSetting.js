// Ánh xạ dữ liệu cho chức năng thi và quản trị; cấu trúc được quản lý bằng migration.
import { EntitySchema } from 'typeorm';

export default new EntitySchema({
  "name": "SiteSetting",
  "tableName": "site_settings",
  "columns": {
    "id": {
      "type": "int",
      "unsigned": true,
      "primary": true
    },
    "title": {
      "type": "varchar",
      "length": 255
    },
    "description": {
      "type": "text",
      "nullable": true
    },
    "banner_url": {
      "type": "varchar",
      "length": 255,
      "nullable": true
    },
    "news_url": {
      "type": "varchar",
      "length": 255,
      "nullable": true
    },
    "news_title": {
      "type": "varchar",
      "length": 255,
      "nullable": true
    },
    "banners_json": { "type": "json", "nullable": true },
    "news_json": { "type": "json", "nullable": true },
    "pinned_competition_id": { "type": "int", "nullable": true },
    "updated_at": {
      "type": "datetime",
      "createDate": true
    }
  }
});
