// Lưu thông tin ngữ cảnh của audit log để có thể xem lại lịch sử khi dữ liệu gốc thay đổi.
export class AuditLogDetails1790700000000 {
  name = 'AuditLogDetails1790700000000';
  transaction = false;

  async up(runner) {
    const table = await runner.getTable('audit_logs');
    if (!table.columns.some(column => column.name === 'details')) {
      await runner.query('ALTER TABLE `audit_logs` ADD COLUMN `details` JSON NULL AFTER `target_id`');
    }
  }

  async down() {
    throw new Error('Khong tu dong xoa chi tiet audit log de tranh mat lich su quan tri.');
  }
}
