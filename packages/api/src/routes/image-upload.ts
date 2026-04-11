/**
 * Image Upload Utilities
 * Handles multipart file saving and validation for image uploads.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ImageContent, PasteContent } from '@cat-cafe/shared';

const ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PASTE_MIMES = new Set(['text/markdown', 'text/plain']);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 5;

export interface SavedImage {
  absPath: string;
  urlPath: string;
  content: ImageContent;
}

export interface UploadImageFile {
  filename?: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
}

/**
 * Validate and save uploaded image files.
 * Returns saved image metadata for contentBlocks and CLI passthrough.
 */
export async function saveUploadedImages(files: UploadImageFile[], uploadDir: string): Promise<SavedImage[]> {
  if (files.length > MAX_FILES) {
    throw new ImageUploadError(`Too many files (max ${MAX_FILES})`);
  }

  await mkdir(uploadDir, { recursive: true });

  const saved: SavedImage[] = [];
  for (const file of files) {
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      throw new ImageUploadError(`Unsupported file type: ${file.mimetype}`);
    }

    const buffer = await file.toBuffer();
    if (buffer.byteLength > MAX_FILE_SIZE) {
      throw new ImageUploadError(`File too large: ${buffer.byteLength} bytes (max ${MAX_FILE_SIZE})`);
    }

    // SECURITY: derive extension from validated MIME only, never trust filename
    const ext = mimeToExt(file.mimetype);
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
    const absPath = resolve(join(uploadDir, filename));

    await writeFile(absPath, buffer);

    saved.push({
      absPath,
      urlPath: `/uploads/${filename}`,
      content: { type: 'image', url: `/uploads/${filename}` },
    });
  }

  return saved;
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '.bin';
  }
}

export interface SavedPaste {
  absPath: string;
  urlPath: string;
  content: PasteContent;
}

const DEFAULT_PREVIEW_LINES = 5;

/**
 * Validate and save an uploaded paste file (.md / .txt).
 * Returns paste metadata for contentBlocks.
 */
export async function saveUploadedPaste(file: UploadImageFile, uploadDir: string): Promise<SavedPaste> {
  if (!PASTE_MIMES.has(file.mimetype)) {
    throw new ImageUploadError(`Unsupported paste type: ${file.mimetype}`);
  }

  const buffer = await file.toBuffer();
  if (buffer.byteLength > MAX_FILE_SIZE) {
    throw new ImageUploadError(`Paste too large: ${buffer.byteLength} bytes (max ${MAX_FILE_SIZE})`);
  }

  await mkdir(uploadDir, { recursive: true });

  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.md`;
  const absPath = resolve(join(uploadDir, filename));
  await writeFile(absPath, buffer);

  const text = buffer.toString('utf-8');
  const lines = text.split('\n');
  const MAX_PREVIEW_CHARS = 2000;
  const preview = lines.slice(0, DEFAULT_PREVIEW_LINES).join('\n').slice(0, MAX_PREVIEW_CHARS);

  return {
    absPath,
    urlPath: `/uploads/${filename}`,
    content: {
      type: 'paste',
      url: `/uploads/${filename}`,
      lineCount: lines.length,
      charCount: text.length,
      preview,
    },
  };
}

/** Check if a MIME type is a paste (text/markdown or text/plain) */
export function isPasteMime(mime: string): boolean {
  return PASTE_MIMES.has(mime);
}

export class ImageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageUploadError';
  }
}
