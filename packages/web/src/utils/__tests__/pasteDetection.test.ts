import { describe, expect, it } from 'vitest';
import {
  createPasteFile,
  getPastePreview,
  getPasteStats,
  PASTE_FOLD_THRESHOLD,
  shouldFoldPaste,
} from '@/utils/pasteDetection';

describe('pasteDetection', () => {
  const shortText = 'line 1\nline 2\nline 3';
  const exactThresholdText = Array.from({ length: PASTE_FOLD_THRESHOLD }, (_, i) => `line ${i + 1}`).join('\n');
  const longText = Array.from(
    { length: 100 },
    (_, i) => `2026-04-10 20:09:32.${i} AndroidRuntime E FATAL EXCEPTION line ${i}`,
  ).join('\n');

  describe('shouldFoldPaste', () => {
    it('returns false for short text', () => {
      expect(shouldFoldPaste(shortText)).toBe(false);
    });

    it('returns false for exactly threshold lines', () => {
      expect(shouldFoldPaste(exactThresholdText)).toBe(false);
    });

    it('returns true for text exceeding threshold', () => {
      expect(shouldFoldPaste(longText)).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(shouldFoldPaste('')).toBe(false);
    });

    it('returns false for single line', () => {
      expect(shouldFoldPaste('hello world')).toBe(false);
    });
  });

  describe('createPasteFile', () => {
    it('creates a File with .md extension', () => {
      const file = createPasteFile(longText);
      expect(file).toBeInstanceOf(File);
      expect(file.name).toMatch(/\.md$/);
    });

    it('has text/markdown MIME type', () => {
      const file = createPasteFile(longText);
      expect(file.type).toBe('text/markdown');
    });

    it('contains raw text without code block wrapper', async () => {
      const file = createPasteFile(longText);
      const content = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsText(file);
      });
      expect(content).toBe(longText);
      expect(content).not.toMatch(/^```/);
    });

    it('generates unique filenames', () => {
      const file1 = createPasteFile(longText);
      const file2 = createPasteFile(longText);
      expect(file1.name).not.toBe(file2.name);
    });
  });

  describe('getPastePreview', () => {
    it('returns first 5 lines by default', () => {
      const preview = getPastePreview(longText);
      const lines = preview.split('\n');
      expect(lines).toHaveLength(5);
    });

    it('returns custom number of lines', () => {
      const preview = getPastePreview(longText, 3);
      const lines = preview.split('\n');
      expect(lines).toHaveLength(3);
    });

    it('returns full text if fewer lines than requested', () => {
      const preview = getPastePreview(shortText, 10);
      expect(preview).toBe(shortText);
    });
  });

  describe('getPasteStats', () => {
    it('returns correct line count', () => {
      const stats = getPasteStats(longText);
      expect(stats.lineCount).toBe(100);
    });

    it('returns correct char count', () => {
      const stats = getPasteStats(shortText);
      expect(stats.charCount).toBe(shortText.length);
    });

    it('handles single line', () => {
      const stats = getPasteStats('hello');
      expect(stats.lineCount).toBe(1);
      expect(stats.charCount).toBe(5);
    });
  });
});
