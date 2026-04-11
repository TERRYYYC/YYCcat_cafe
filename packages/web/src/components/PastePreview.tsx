'use client';

import { getPastePreview, getPasteStats } from '@/utils/pasteDetection';

interface PastePreviewProps {
  file: File;
  rawText: string;
  onRemove: () => void;
}

export function PastePreview({ file, rawText, onRemove }: PastePreviewProps) {
  const stats = getPasteStats(rawText);
  const preview = getPastePreview(rawText, 4);

  return (
    <div className="mx-4 my-2 rounded-lg border border-cafe bg-cafe-surface/50 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-cafe-surface/80 border-b border-cafe">
        <span className="text-xs text-cafe-muted truncate">
          {file.name} &middot; {stats.lineCount} lines &middot; {(stats.charCount / 1024).toFixed(1)}KB
        </span>
        <button
          onClick={onRemove}
          className="ml-2 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center hover:bg-red-600 transition-colors flex-shrink-0"
          title="Remove pasted text"
          aria-label="Remove pasted text"
        >
          x
        </button>
      </div>
      <pre className="px-3 py-2 text-xs text-cafe-secondary overflow-hidden max-h-24 font-mono whitespace-pre-wrap">
        {preview}
        {'\n'}
        <span className="text-cafe-muted">... +{stats.lineCount - 4} more lines</span>
      </pre>
    </div>
  );
}
