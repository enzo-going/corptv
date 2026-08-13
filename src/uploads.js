'use strict';

const fs = require('fs');
const path = require('path');

const MIME_BY_EXTENSION = new Map([
  ['.jpg', new Set(['image/jpeg'])],
  ['.jpeg', new Set(['image/jpeg'])],
  ['.png', new Set(['image/png'])],
  ['.webp', new Set(['image/webp'])],
  ['.mp4', new Set(['video/mp4'])]
]);

function acceptsUpload(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const allowedMimes = MIME_BY_EXTENSION.get(extension);
  return !!allowedMimes && allowedMimes.has(file.mimetype);
}

function mediaTypeFromSignature(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'img';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'img';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'img';
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'vid';
  return null;
}

async function inspectStoredUpload(filePath, file) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    const type = mediaTypeFromSignature(buffer.subarray(0, result.bytesRead));
    const expected = file && file.mimetype === 'video/mp4' ? 'vid' : 'img';
    if (!type || type !== expected) {
      return { ok: false, error: 'O conteúdo do arquivo não corresponde ao formato informado.' };
    }
    return { ok: true, type };
  } finally {
    await handle.close();
  }
}

function uploadedPathFromUrl(url, uploadsDir) {
  if (typeof url !== 'string' || !/^\/uploads\/[0-9a-f-]+\.(?:jpe?g|png|webp|mp4)$/i.test(url)) return null;
  const candidate = path.join(uploadsDir, path.basename(url));
  return path.dirname(candidate) === path.resolve(uploadsDir) ? candidate : null;
}

async function removeFile(filePath) {
  if (!filePath) return false;
  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = {
  acceptsUpload,
  inspectStoredUpload,
  mediaTypeFromSignature,
  removeFile,
  uploadedPathFromUrl
};
