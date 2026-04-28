// @ts-check
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AVATAR_RAW_FILE_LIMIT_BYTES } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { avatarsRoutes } from '../../dist/routes/avatars.js';

/**
 * Build a minimal multipart/form-data payload with one file part.
 */
function buildMultipartPayload({ buffer, filename, mimetype, fieldName = 'file' }) {
  const boundary = `----TestBoundary${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${mimetype}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    payload: Buffer.concat([head, buffer, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('POST /api/uploads/avatar', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;
  /** @type {string} */
  let uploadDir;
  /** @type {string | undefined} */
  let prevUploadDir;

  before(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'avatars-route-'));
    prevUploadDir = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = uploadDir;
    app = Fastify();
    await app.register(avatarsRoutes);
    await app.ready();
  });

  after(async () => {
    await app.close();
    if (prevUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = prevUploadDir;
    await rm(uploadDir, { recursive: true, force: true });
  });

  it('accepts a 7 MiB PNG and persists it to UPLOAD_DIR', async () => {
    const rawBytes = 7 * 1024 * 1024;
    const buffer = Buffer.alloc(rawBytes);
    const { payload, contentType } = buildMultipartPayload({
      buffer,
      filename: 'big.png',
      mimetype: 'image/png',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/avatar',
      headers: { 'Content-Type': contentType },
      payload,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.url, 'should return upload URL');
    assert.ok(body.url.startsWith('/uploads/'), 'URL should start with /uploads/');
    assert.ok(body.url.endsWith('.png'), 'URL should end with .png');
    const filename = body.url.replace('/uploads/', '');
    const saved = await stat(join(uploadDir, filename));
    assert.equal(saved.isFile(), true);
    assert.equal(saved.size, rawBytes, 'saved file size should match the input buffer length');
  });

  it('rejects files larger than AVATAR_RAW_FILE_LIMIT_BYTES with structured 413', async () => {
    const buffer = Buffer.alloc(AVATAR_RAW_FILE_LIMIT_BYTES + 1024);
    const { payload, contentType } = buildMultipartPayload({
      buffer,
      filename: 'too-big.png',
      mimetype: 'image/png',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/avatar',
      headers: { 'Content-Type': contentType },
      payload,
    });
    assert.equal(res.statusCode, 413);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(body.maxBytes, AVATAR_RAW_FILE_LIMIT_BYTES);
  });

  it('rejects unsupported mime types with 415', async () => {
    const buffer = Buffer.from('hello world');
    const { payload, contentType } = buildMultipartPayload({
      buffer,
      filename: 'doc.txt',
      mimetype: 'text/plain',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/avatar',
      headers: { 'Content-Type': contentType },
      payload,
    });
    assert.equal(res.statusCode, 415);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects request with no file part with 400', async () => {
    const boundary = `----EmptyBoundary${Math.random().toString(16).slice(2)}`;
    const payload = Buffer.from(`--${boundary}--\r\n`, 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/avatar',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'NO_FILE');
  });
});
