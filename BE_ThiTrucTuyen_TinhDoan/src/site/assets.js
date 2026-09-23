import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccess, requireRoles } from '../auth/access.js';
import { audit, fail, route, textField } from '../common/http.js';
import { assetUpload, inspectOfficeArchive } from './files.js';

export const uploadsDirectory = path.resolve(process.env.UPLOAD_DIR || fileURLToPath(new URL('../uploads/', import.meta.url)));
const jsonList = value => { try { const list = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(list) ? list.filter(item => item?.url && item?.title).slice(0, 20) : []; } catch { return []; } };
const DEFAULT_FOOTER = { organizationLabel: '\u0110\u01a1n v\u1ecb t\u1ed5 ch\u1ee9c', organizationName: 'T\u1ec9nh \u0110o\u00e0n V\u0129nh Long', address: '169/2, \u0111\u01b0\u1eddng Ph\u1ea1m H\u00f9ng, Ph\u01b0\u1eddng Long Ch\u00e2u, t\u1ec9nh V\u0129nh Long', contactLabel: 'Li\u00ean h\u1ec7', email: 'tuyengiao.tinhdoanvinhlong@gmail.com', website: 'tinhdoanvinhlong.vn' };
const footerPayload = value => {
  try { const item = typeof value === 'string' ? JSON.parse(value) : value; return item && typeof item === 'object' && !Array.isArray(item) ? { ...DEFAULT_FOOTER, ...item } : DEFAULT_FOOTER; } catch { return DEFAULT_FOOTER; }
};
const footerInput = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'Th\u00f4ng tin footer kh\u00f4ng h\u1ee3p l\u1ec7.');
  const footer = {
    organizationLabel: textField(value.organizationLabel, 'Nh\u00e3n \u0111\u01a1n v\u1ecb t\u1ed5 ch\u1ee9c', 255), organizationName: textField(value.organizationName, 'T\u00ean \u0111\u01a1n v\u1ecb t\u1ed5 ch\u1ee9c', 255),
    address: textField(value.address, '\u0110\u1ecba ch\u1ec9', 500), contactLabel: textField(value.contactLabel, 'Nh\u00e3n li\u00ean h\u1ec7', 255),
    email: textField(value.email, 'Email li\u00ean h\u1ec7', 254), website: textField(value.website, 'Website', 255)
  };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(footer.email)) throw fail(400, 'Email li\u00ean h\u1ec7 kh\u00f4ng h\u1ee3p l\u1ec7.');
  if (!/^(https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/.*)?$/i.test(footer.website)) throw fail(400, 'Website kh\u00f4ng h\u1ee3p l\u1ec7.');
  return footer;
};
const settingsPayload = row => ({ title: row?.title || 'Thi trực tuyến Tỉnh Đoàn', description: row?.description || '', bannerUrl: row?.banner_url || '', newsUrl: row?.news_url || '', newsTitle: row?.news_title || '', pinnedCompetitionId: row?.pinned_competition_id || null, banners: jsonList(row?.banners_json), news: jsonList(row?.news_json), footer: footerPayload(row?.footer_json) });
// Multer/Busboy c? th? ??c filename trong multipart theo Latin-1 d? tr?nh duy?t g?i UTF-8.
// Chu?n h?a tr??c khi ??a t?n t?p v?o th?ng b?o, ti?u ?? tin t?c v? c? s? d? li?u.
export function uploadedFileName(value) {
  const raw = String(value || '');
  if (!raw || [...raw].some(character => character.codePointAt(0) > 255)) return raw;
  try {
    const bytes = Buffer.from(raw, 'latin1');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : raw;
  } catch { return raw; }
}

const assetId = (url, kind) => {
  if (typeof url !== 'string' || !/^\/api\/assets\/[0-9a-f-]{36}$/.test(url)) throw fail(400, 'Hãy sử dụng tệp đã tải lên hệ thống.');
  return { id: url.split('/').at(-1), kind };
};
export async function detectAsset(file, kind) {
  if (!file?.size || !['banner', 'news'].includes(kind)) throw fail(400, 'Vui lòng chọn tệp và loại nội dung hợp lệ.');
  const b = file.buffer;
  // Banner gi? gi?i h?n nh? ?? trang ch? t?i nhanh; ri?ng t?p tin t?c ???c middleware cho ph?p t?i ?a 25 MB.
  if (kind === 'banner') {
    if (b.length > 5 * 1024 * 1024) throw fail(413, 'Banner c? dung l??ng t?i ?a 5 MB.');
    if (b.length > 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      if (b.readUInt32BE(16) > 10000 || b.readUInt32BE(20) > 10000) throw fail(400, 'Kích thước ảnh tối đa 10.000 pixel mỗi chiều.');
      return { extension: 'png', mime: 'image/png' };
    }
    if (b.length > 4 && b[0] === 255 && b[1] === 216 && b[2] === 255) return { extension: 'jpg', mime: 'image/jpeg' };
    if (b.length > 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { extension: 'webp', mime: 'image/webp' };
    throw fail(400, 'Banner chỉ nhận ảnh PNG, JPEG hoặc WebP hợp lệ.');
  }
  if (b.toString('ascii', 0, 5) === '%PDF-') return { extension: 'pdf', mime: 'application/pdf' };
  if (/\.docx$/i.test(file.originalname)) { await inspectOfficeArchive(b, 'word/document.xml'); return { extension: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }; }
  if (/\.txt$/i.test(file.originalname)) {
    try { const decoded = new TextDecoder('utf-8', { fatal: true }).decode(b); if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded)) throw new Error(); } catch { throw fail(400, 'Tệp TXT phải là văn bản UTF-8.'); }
    return { extension: 'txt', mime: 'text/plain; charset=utf-8' };
  }
  throw fail(400, 'Tin tức chỉ nhận PDF, DOCX hoặc TXT.');
}

export function createSiteRouter({ pool }) {
  const router = Router();
  router.get('/site', route(async (_req, res) => {
    const [[row]] = await pool.query('SELECT * FROM site_settings WHERE id=1');
    res.json({ success: true, item: settingsPayload(row) });
  }));
  router.get('/assets/:id', route(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw fail(404, 'Không tìm thấy tệp.');
    const [[asset]] = await pool.query('SELECT * FROM site_assets WHERE id=?', [req.params.id]);
    if (!asset || path.basename(asset.path) !== asset.path) throw fail(404, 'Không tìm thấy tệp.');
    res.type(asset.mime_type);
    // Tin t?c m? tr?c ti?p ?? ??c tr?n tr?nh duy?t; ch? t?i t?p khi ng??i d?ng b?m n?t t?i xu?ng.
    if (asset.kind === 'news' && req.query.download === '1') res.attachment(`tin-tuc.${asset.path.split('.').at(-1)}`);
    else res.set('Content-Disposition', 'inline');
    // Kh?ng sandbox t?p c?ng b?: m?t s? tr?nh duy?t kh?ng th? d?ng tr?nh xem PDF t?ch h?p khi ph?n h?i b? sandbox.
    res.set('Content-Security-Policy', "default-src 'none'");
    await new Promise((resolve, reject) => res.sendFile(asset.path, { root: uploadsDirectory }, error => error ? reject(error.status === 404 ? fail(404, 'Tệp không còn trên máy chủ.') : error) : resolve()));
  }));
  router.post('/manage/assets', createAccess({ pool }), requireRoles('admin'), assetUpload.single('file'), route(async (req, res) => {
    const originalName = uploadedFileName(req.file?.originalname);
    const file = { ...req.file, originalname: originalName };
    const kind = req.body.kind, type = await detectAsset(file, kind), id = randomUUID(), filename = `${id}.${type.extension}`;
    await mkdir(uploadsDirectory, { recursive: true });
    await writeFile(path.join(uploadsDirectory, filename), req.file.buffer, { flag: 'wx' });
    try {
      await pool.transaction(async tx => {
        await tx.query('INSERT INTO site_assets (id,original_name,kind,mime_type,path,created_by) VALUES (?,?,?,?,?,?)', [id, originalName.slice(0, 255), kind, type.mime, filename, req.user.id]);
        await audit(tx, req.user.id, 'asset.upload', 'asset', id);
      });
    } catch (error) { await unlink(path.join(uploadsDirectory, filename)).catch(() => {}); throw error; }
    res.status(201).json({ success: true, item: { url: `/api/assets/${id}`, name: originalName, kind } });
  }));
  router.put('/manage/site/pin-competition', createAccess({ pool }), requireRoles('admin'), route(async (req, res) => {
    const competitionId = req.body?.competitionId ? Number(req.body.competitionId) : null;
    if (competitionId && (!Number.isSafeInteger(competitionId) || competitionId < 1)) throw fail(400, 'Kỳ thi không hợp lệ.');
    if (competitionId) { const [[competition]] = await pool.query("SELECT id FROM competitions WHERE id=? AND status IN ('published','closed')", [competitionId]); if (!competition) throw fail(400, 'Chỉ có thể ghim kỳ thi đã công bố.'); }
    await pool.query('INSERT INTO site_settings (id,title,pinned_competition_id) VALUES (1,?,?) ON DUPLICATE KEY UPDATE pinned_competition_id=VALUES(pinned_competition_id),updated_at=NOW()', ['Thi trực tuyến Tỉnh Đoàn', competitionId]);
    res.json({ success: true, pinnedCompetitionId: competitionId });
  }));
  router.put('/manage/site', createAccess({ pool }), requireRoles('admin'), route(async (req, res) => {
    const title = textField(req.body.title, 'Tiêu đề'), description = textField(req.body.description, 'Mô tả', 10000, true), newsTitle = textField(req.body.newsTitle, 'Tiêu đề tin tức', 255, true);
    const footer = footerInput(req.body.footer || DEFAULT_FOOTER);
    const bannerUrl = req.body.bannerUrl || '', newsUrl = req.body.newsUrl || '';
    const lists = { banners: Array.isArray(req.body.banners) ? req.body.banners : [], news: Array.isArray(req.body.news) ? req.body.news : [] };
    if (lists.banners.length > 20 || lists.news.length > 50) throw fail(400, 'Số lượng banner hoặc tin tức vượt giới hạn.');
    for (const item of [...lists.banners, ...lists.news]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw fail(400, 'Nội dung trang chủ không hợp lệ.');
      item.title = textField(item.title, 'Tiêu đề', 255);
    }
    for (const [url, kind] of [[bannerUrl, 'banner'], [newsUrl, 'news'], ...lists.banners.map(item => [item.url, 'banner']), ...lists.news.map(item => [item.url, 'news'])]) {
      if (!url) continue;
      const assetInput = assetId(url, kind);
      const [[asset]] = await pool.query('SELECT id FROM site_assets WHERE id=? AND kind=?', [assetInput.id, assetInput.kind]);
      if (!asset) throw fail(400, 'Tệp không tồn tại hoặc không đúng loại.');
    }
    await pool.transaction(async tx => {
      await tx.query('INSERT INTO site_settings (id,title,description,banner_url,news_url,news_title,banners_json,news_json,footer_json) VALUES (1,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),description=VALUES(description),banner_url=VALUES(banner_url),news_url=VALUES(news_url),news_title=VALUES(news_title),banners_json=VALUES(banners_json),news_json=VALUES(news_json),footer_json=VALUES(footer_json),updated_at=NOW()', [title, description, bannerUrl || null, newsUrl || null, newsTitle, JSON.stringify(lists.banners), JSON.stringify(lists.news), JSON.stringify(footer)]);
      await audit(tx, req.user.id, 'site.apply', 'site', 1);
    });
    res.json({ success: true, item: { title, description, bannerUrl, newsUrl, newsTitle, footer, ...lists }, message: 'Đã áp dụng giao diện và tin tức.' });
  }));
  return router;
}
