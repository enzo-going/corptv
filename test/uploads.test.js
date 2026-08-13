'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  acceptsUpload,
  mediaTypeFromSignature,
  uploadedPathFromUrl
} = require('../src/uploads');

test('exige combinação coerente de extensão e MIME', () => {
  assert.equal(acceptsUpload({ originalname: 'aviso.png', mimetype: 'image/png' }), true);
  assert.equal(acceptsUpload({ originalname: 'aviso.png', mimetype: 'text/html' }), false);
  assert.equal(acceptsUpload({ originalname: 'video.exe', mimetype: 'video/mp4' }), false);
});

test('reconhece assinaturas de PNG, JPEG, WEBP e MP4', () => {
  assert.equal(mediaTypeFromSignature(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])), 'img');
  assert.equal(mediaTypeFromSignature(Buffer.from([0xff,0xd8,0xff,0xe0])), 'img');
  assert.equal(mediaTypeFromSignature(Buffer.from('RIFFxxxxWEBP')), 'img');
  assert.equal(mediaTypeFromSignature(Buffer.from('xxxxftypisom')), 'vid');
  assert.equal(mediaTypeFromSignature(Buffer.from('<script>')), null);
});

test('só resolve URLs de upload geradas pelo sistema', () => {
  const root = path.resolve('uploads');
  assert.equal(uploadedPathFromUrl('/uploads/123e4567-e89b-12d3-a456-426614174000.mp4', root), path.join(root, '123e4567-e89b-12d3-a456-426614174000.mp4'));
  assert.equal(uploadedPathFromUrl('/uploads/../../segredo.txt', root), null);
  assert.equal(uploadedPathFromUrl('/outro/video.mp4', root), null);
});
