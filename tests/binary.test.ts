import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataUrlBytes, imageFile } from '../src/binary';

test('local image decoding preserves base64, percent-encoded binary and UTF-8 without fetching', () => {
  const binary = new Uint8Array([0, 255, 128, 1]);
  assert.deepEqual(new Uint8Array(dataUrlBytes('data:image/png;base64,AP+AAQ==')), binary);
  assert.deepEqual(new Uint8Array(dataUrlBytes('data:image/png,%00%ff%80%01')), binary);
  const svg = '<svg>中文</svg>';
  assert.deepEqual(new Uint8Array(dataUrlBytes(`data:image/svg+xml,${encodeURIComponent(svg)}`)), new TextEncoder().encode(svg));
  assert.deepEqual(new Uint8Array(dataUrlBytes(`data:image/svg+xml,${svg}`)), new TextEncoder().encode(svg));
  assert.throws(() => dataUrlBytes('https://example.com/image.png'), /本地数据/);
});

test('image files keep their identity and timestamps while rejecting non-image MIME types', () => {
  const file = imageFile('image-id', 'data:image/png;base64,AP+AAQ==', 'image/png', 42);
  assert.equal(file.id, 'image-id'); assert.equal(file.created, 42);
  assert.equal(file.dataURL, 'data:image/png;base64,AP+AAQ==');
  assert.throws(() => imageFile('image-id', file.dataURL, 'text/plain'), /图片类型/);
});
