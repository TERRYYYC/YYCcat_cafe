/**
 * Multipart Request Parser
 * 解析 multipart/form-data 请求，提取文本字段和图片文件。
 * 从 messages.ts 提取，降低文件复杂度。
 */

import type { ImageContent, MessageContent, PasteContent, TextContent } from '@cat-cafe/shared';
import type { Multipart } from '@fastify/multipart';
import {
  ImageUploadError,
  isPasteMime,
  saveUploadedImages,
  saveUploadedPaste,
  type UploadImageFile,
} from './image-upload.js';
import { sendMessageSchema } from './messages.schema.js';

export type ParsedMultipart =
  | {
      content: string;
      userId?: string;
      threadId?: string;
      idempotencyKey?: string;
      contentBlocks: MessageContent[];
      visibility?: string;
      whisperTo?: string[];
      deliveryMode?: 'immediate' | 'queue' | 'force';
    }
  | { error: string };

/** Parse multipart request into validated message fields + contentBlocks */
export async function parseMultipart(
  request: { parts: () => AsyncIterableIterator<Multipart> },
  uploadDir: string,
): Promise<ParsedMultipart> {
  // F35: Use string | string[] to support multi-value fields like whisperTo
  const fields: Record<string, string | string[]> = {};
  const files: UploadImageFile[] = [];

  for await (const part of request.parts()) {
    if (part.type === 'field' && typeof part.value === 'string') {
      const existing = fields[part.fieldname];
      if (existing !== undefined) {
        // Multi-value field (e.g. whisperTo): collect into array
        fields[part.fieldname] = Array.isArray(existing) ? [...existing, part.value] : [existing, part.value];
      } else {
        fields[part.fieldname] = part.value;
      }
    } else if (part.type === 'file') {
      // IMPORTANT: multipart file streams must be drained during iteration.
      // If we defer `toBuffer()` until after the loop, parser may block waiting
      // for this stream to be consumed and request hangs.
      const buffer = await part.toBuffer();
      files.push({
        filename: part.filename,
        mimetype: part.mimetype,
        toBuffer: async () => buffer,
      });
    }
  }

  // F35: Normalize whisperTo — single value becomes array for Zod validation
  if (fields.whisperTo !== undefined && !Array.isArray(fields.whisperTo)) {
    fields.whisperTo = [fields.whisperTo];
  }

  const parseResult = sendMessageSchema.safeParse(fields);
  if (!parseResult.success) {
    return { error: 'Invalid form fields' };
  }

  const { content, userId, threadId, idempotencyKey } = parseResult.data;
  const blocks: MessageContent[] = [{ type: 'text', text: content } as TextContent];

  if (files.length > 0) {
    // Split files into images and pastes
    const imageFiles = files.filter((f) => !isPasteMime(f.mimetype));
    const pasteFiles = files.filter((f) => isPasteMime(f.mimetype));

    try {
      if (imageFiles.length > 0) {
        const saved = await saveUploadedImages(imageFiles, uploadDir);
        for (const img of saved) {
          blocks.push(img.content as ImageContent);
        }
      }
      for (const pasteFile of pasteFiles) {
        const saved = await saveUploadedPaste(pasteFile, uploadDir);
        blocks.push(saved.content as PasteContent);
      }
    } catch (err) {
      if (err instanceof ImageUploadError) {
        return { error: err.message };
      }
      throw err;
    }
  }

  return {
    content,
    ...(userId ? { userId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(parseResult.data.visibility ? { visibility: parseResult.data.visibility } : {}),
    ...(parseResult.data.whisperTo ? { whisperTo: parseResult.data.whisperTo as string[] } : {}),
    ...(parseResult.data.deliveryMode ? { deliveryMode: parseResult.data.deliveryMode } : {}),
    contentBlocks: blocks,
  };
}
