// Media provenance at capture. The moment a file lands we compute its sha256
// and extract EXIF, then store the bytes plus that provenance in an immutable
// `media` row. Nothing here ever mutates an existing row.

const crypto = require('crypto');
const exifr = require('exifr');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Extract EXIF from image buffers. Non-images (PDFs, etc.) and images without
// EXIF return {}. Never throws — a parse failure must not block the upload.
async function extractExif(buffer, mime) {
  if (!mime || !mime.startsWith('image/')) return {};
  try {
    const parsed = await exifr.parse(buffer, { tiff: true, exif: true, gps: true });
    if (!parsed || typeof parsed !== 'object') return {};
    // Strip non-serialisable values (Buffers) so the JSONB column stays clean.
    return JSON.parse(JSON.stringify(parsed, (_k, v) => (v instanceof Buffer ? undefined : v)));
  } catch {
    return {};
  }
}

// Best-effort capture time: prefer EXIF DateTimeOriginal, else null (the DB
// column defaults are handled by the caller).
function capturedAtFromExif(exif) {
  const raw = exif?.DateTimeOriginal || exif?.CreateDate || exif?.ModifyDate;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { sha256, extractExif, capturedAtFromExif };
