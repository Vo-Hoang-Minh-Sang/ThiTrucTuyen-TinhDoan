import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccess, requireRoles } from './access.js';
import { audit, fail, route, textField } from './http.js';
import { inspectOfficeArchive, upload } from './files.js';

export const uploadsDirectory = path.resolve(process.env.UPLOAD_DIR || fileURLToPath(new URL('../uploads/', import.meta.url)));
const settingsPayload = row => ({ title: row?.title || 'Thi trực tuyến Tỉnh Đoàn', description: row?.description || '', bannerUrl: row?.banner_url || '', newsUrl: row?.news_url || '', newsTitle: row?.news_title || '' });
export async function detectAsset(file, kind) {
  if (!file?.size || !['banner', 'news'].includes(kind)) throw fail(400, 'Vui lòng chọn tệp và loại nội dung hợp lệ.');
  const b = file.buffer;
  if (kind === 'banner') {
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
    if (asset.kind === 'news') res.attachment(`tin-tuc.${asset.path.split('.').at(-1)}`);
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    await new Promise((resolve, reject) => res.sendFile(asset.path, { root: uploadsDirectory }, error => error ? reject(error.status === 404 ? fail(404, 'Tệp không còn trên máy chủ.') : error) : resolve()));
  }));
  router.post('/manage/assets', createAccess({ pool }), requireRoles('admin'), upload.single('file'), route(async (req, res) => {
    const kind = req.body.kind, type = await detectAsset(req.file, kind), id = randomUUID(), filename = `${id}.${type.extension}`;
    await mkdir(uploadsDirectory, { recursive: true });
    await writeFile(path.join(uploadsDirectory, filename), req.file.buffer, { flag: 'wx' });
    try {
      await pool.transaction(async tx => {
        await tx.query('INSERT INTO site_assets (id,original_name,kind,mime_type,path,created_by) VALUES (?,?,?,?,?,?)', [id, req.file.originalname.slice(0, 255), kind, type.mime, filename, req.user.id]);
        await audit(tx, req.user.id, 'asset.upload', 'asset', id);
      });
    } catch (error) { await unlink(path.join(uploadsDirectory, filename)).catch(() => {}); throw error; }
    res.status(201).json({ success: true, item: { url: `/api/assets/${id}`, name: req.file.originalname, kind } });
  }));
  router.put('/manage/site', createAccess({ pool }), requireRoles('admin'), route(async (req, res) => {
    const title = textField(req.body.title, 'Tiêu đề'), description = textField(req.body.description, 'Mô tả', 10000, true), newsTitle = textField(req.body.newsTitle, 'Tiêu đề tin tức', 255, true);
    const bannerUrl = req.body.bannerUrl || '', newsUrl = req.body.newsUrl || '';
    for (const [url, kind] of [[bannerUrl, 'banner'], [newsUrl, 'news']]) {
      if (!url) continue;
      if (typeof url !== 'string' || !/^\/api\/assets\/[0-9a-f-]{36}$/.test(url)) throw fail(400, 'Hãy sử dụng tệp đã tải lên hệ thống.');
      const [[asset]] = await pool.query('SELECT id FROM site_assets WHERE id=? AND kind=?', [url.split('/').at(-1), kind]);
      if (!asset) throw fail(400, 'Tệp không tồn tại hoặc không đúng loại.');
    }
    await pool.transaction(async tx => {
      await tx.query('INSERT INTO site_settings (id,title,description,banner_url,news_url,news_title) VALUES (1,?,?,?,?,?) ON DUPLICATE KEY UPDATE title=VALUES(title),description=VALUES(description),banner_url=VALUES(banner_url),news_url=VALUES(news_url),news_title=VALUES(news_title),updated_at=NOW()', [title, description, bannerUrl || null, newsUrl || null, newsTitle]);
      await audit(tx, req.user.id, 'site.apply', 'site', 1);
    });
    res.json({ success: true, item: { title, description, bannerUrl, newsUrl, newsTitle }, message: 'Đã áp dụng giao diện và tin tức.' });
  }));
  return router;
}
