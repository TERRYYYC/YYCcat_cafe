/**
 * Content Block Path Extraction
 * Extracts absolute file paths from MessageContent blocks for CLI passthrough.
 */

import { resolve } from 'node:path';
import type { MessageContent } from '@cat-cafe/shared';

const DEFAULT_UPLOAD_DIR = process.env.UPLOAD_DIR ?? './uploads';

function resolveUploadUrl(url: string, uploadDir?: string): string | null {
  if (url.startsWith('/uploads/')) {
    const filename = url.slice('/uploads/'.length);
    return resolve(uploadDir ?? DEFAULT_UPLOAD_DIR, filename);
  }
  if (url.startsWith('/')) {
    return resolve(url);
  }
  return null;
}

/**
 * Extract absolute image file paths from contentBlocks.
 * Converts relative URL paths (/uploads/foo.png) to absolute filesystem paths.
 */
export function extractImagePaths(contentBlocks: readonly MessageContent[] | undefined, uploadDir?: string): string[] {
  if (!contentBlocks) return [];

  const paths: string[] = [];
  for (const block of contentBlocks) {
    if (block.type !== 'image') continue;
    const resolved = resolveUploadUrl(block.url, uploadDir);
    if (resolved) paths.push(resolved);
  }
  return paths;
}

/**
 * Extract absolute paste file paths from contentBlocks.
 */
export function extractPastePaths(contentBlocks: readonly MessageContent[] | undefined, uploadDir?: string): string[] {
  if (!contentBlocks) return [];

  const paths: string[] = [];
  for (const block of contentBlocks) {
    if (block.type !== 'paste') continue;
    const resolved = resolveUploadUrl(block.url, uploadDir);
    if (resolved) paths.push(resolved);
  }
  return paths;
}
