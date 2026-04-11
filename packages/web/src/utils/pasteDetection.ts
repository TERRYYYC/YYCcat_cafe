/** Paste fold threshold — text exceeding this many lines gets folded */
export const PASTE_FOLD_THRESHOLD = 20;

/** Default number of preview lines shown in the folded card */
const DEFAULT_PREVIEW_LINES = 5;

/** Check whether pasted text should be folded (exceeds threshold) */
export function shouldFoldPaste(text: string): boolean {
  if (!text) return false;
  const lineCount = text.split('\n').length;
  return lineCount > PASTE_FOLD_THRESHOLD;
}

/** Create a .md File from pasted text (raw content, no wrapper) */
export function createPasteFile(text: string): File {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const fileName = `paste-${timestamp}-${random}.md`;
  return new File([text], fileName, { type: 'text/markdown' });
}

/** Get the first N lines of text for preview display */
export function getPastePreview(text: string, maxLines = DEFAULT_PREVIEW_LINES): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n');
}

/** Get line count and character count stats for pasted text */
export function getPasteStats(text: string): { lineCount: number; charCount: number } {
  return {
    lineCount: text.split('\n').length,
    charCount: text.length,
  };
}
