import { useEffect, useState } from 'react';
import { api } from './api';

// Thành phần, định dạng và hook dùng chung để các màn hình hiển thị dữ liệu nhất quán.
// Chuyển mã dữ liệu backend thành nhãn tiếng Việt, không dùng để quyết định quyền nghiệp vụ.
export const formatDate = value => value ? new Date(value).toLocaleString('vi-VN') : 'Chưa công bố';
export const roleNames = { candidate: 'Thí sinh', teacher: 'Giảng viên', admin: 'Quản trị viên' };
export const statusNames = { draft: 'Bản nháp', published: 'Thông báo kỳ thi', paused: 'Tạm đóng', unscheduled: 'Chưa có lịch', upcoming: 'Sắp diễn ra', active: 'Đang diễn ra', ongoing: 'Đang diễn ra', ended: 'Đã kết thúc', closed: 'Đã kết thúc', in_progress: 'Đang làm bài', submitted: 'Đã nộp', expired: 'Hết giờ' };
export const queryString = filters => new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== '' && value != null)).toString();

// Hủy lần tải cũ khi đổi bộ lọc để dữ liệu chậm không ghi đè kết quả mới.
export function useResource(path, token, refresh = 0) {
  const [state, setState] = useState({ data: null, loading: Boolean(path), error: '' });
  useEffect(() => {
    if (!path) { setState({ data: null, loading: false, error: '' }); return; }
    const controller = new AbortController();
    setState({ data: null, loading: true, error: '' });
    api(path, { token, signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ data, loading: false, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ data: null, loading: false, error: error.message });
    });
    return () => controller.abort();
  }, [path, token, refresh]);
  return state;
}

// Hiển thị trạng thái tải, lỗi và rỗng trước nội dung thật của một tài nguyên API.
export function ResourceState({ resource, empty = false, children }) {
  if (resource.loading) return <p className="empty-state" role="status">Đang tải dữ liệu…</p>;
  if (resource.error) return <p className="error-message notice" role="alert">{resource.error}</p>;
  if (empty) return <p className="empty-state">Chưa có dữ liệu phù hợp.</p>;
  return children;
}
// Hiển thị phản hồi thao tác trong cửa sổ nổi để người dùng không bỏ sót thông báo.
export function Notice({ text, error = false, clear }) {
  const [closed, setClosed] = useState(false);
  useEffect(() => { setClosed(false); }, [text]);
  if (!text || closed) return null;
  const close = () => { setClosed(true); clear?.(); };
  return <div className="notice-modal-backdrop" role="presentation" onMouseDown={close}><section className={`notice-modal ${error ? 'error-message' : 'success-message'}`} role={error ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby="notice-title" onMouseDown={event => event.stopPropagation()}><h2 id="notice-title">{error ? 'Không thể thực hiện thao tác' : 'Thông báo'}</h2><p>{text}</p><div className="actions"><button autoFocus onClick={close}>Đã hiểu</button></div></section></div>;
}
export function Table({ headings, children, label = 'Bảng dữ liệu' }) { return <div className="table-wrap" role="region" aria-label={label} tabIndex={0}><table><thead><tr>{headings.map(heading => <th scope="col" key={heading}>{heading}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
export function CompetitionSelect({ items, value, onChange, required = false, all = 'Tất cả kỳ thi' }) { return <label>Kỳ thi<select value={value} onChange={event => onChange(event.target.value)} required={required}><option value="">{required ? 'Chọn kỳ thi' : all}</option>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>; }
export function DateFilters({ value, onChange }) { return <><label>Từ ngày<input type="date" value={value.from || ''} onChange={event => onChange({ ...value, from: event.target.value })} /></label><label>Đến ngày<input type="date" value={value.to || ''} min={value.from || undefined} onChange={event => onChange({ ...value, to: event.target.value })} /></label></>; }
// Dùng được cho phân trang do backend trả về hoặc danh sách đã tải ở frontend.
export function Pagination({ data, page, onChange, total, pageSize }) {
  const itemTotal = total ?? data?.total;
  const itemPageSize = Number(pageSize ?? data?.pageSize ?? 100);
  const pages = Math.max(1, Math.ceil(Number(itemTotal || 0) / itemPageSize));
  return itemTotal != null ? <div className="pagination"><span>{itemTotal} bản ghi · Trang {page}/{pages}</span><button type="button" className="secondary" disabled={page <= 1} onClick={() => onChange(page - 1)}>Trang trước</button><button type="button" className="secondary" disabled={page >= pages} onClick={() => onChange(page + 1)}>Trang sau</button></div> : null;
}

// Dùng chung trạng thái thao tác; lỗi API luôn được hiển thị bên cạnh biểu mẫu.
export function useAction() {
  const [state, setState] = useState({ busy: false, text: '', error: false });
  async function run(action, success = 'Đã lưu thay đổi.') {
    if (state.busy) return;
    setState({ busy: true, text: '', error: false });
    try {
      const value = await action();
      // Một số thao tác nhập tệp cần đưa số lượng xử lý từ phản hồi máy chủ vào thông báo.
      setState({ busy: false, text: typeof success === 'function' ? success(value) : success, error: false });
      return value;
    }
    catch (error) { setState({ busy: false, text: error.message, error: true }); }
  }
  return { ...state, run, clear: () => setState({ busy: false, text: '', error: false }) };
}
