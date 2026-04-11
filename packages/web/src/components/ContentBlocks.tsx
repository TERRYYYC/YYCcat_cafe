'use client';

import { useCallback, useState } from 'react';
import type { MessageContent } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { Lightbox } from './Lightbox';
import { MarkdownContent } from './MarkdownContent';

function PasteBlock({ block }: { block: { url: string; lineCount: number; charCount: number; preview: string } }) {
  const [expanded, setExpanded] = useState(false);
  const [fullText, setFullText] = useState<string | null>(null);

  const handleExpand = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (!fullText) {
      const url = block.url.startsWith('/uploads/') ? `${API_URL}${block.url}` : block.url;
      const res = await fetch(url);
      setFullText(await res.text());
    }
    setExpanded(true);
  }, [expanded, fullText, block.url]);

  return (
    <div className="mt-2 rounded-lg border border-cafe overflow-hidden">
      <button
        onClick={handleExpand}
        className="w-full flex items-center justify-between px-3 py-1.5 bg-cafe-surface/80 hover:bg-cafe-surface transition-colors text-left"
      >
        <span className="text-xs text-cafe-muted">
          Pasted text &middot; {block.lineCount} lines &middot; {(block.charCount / 1024).toFixed(1)}KB
        </span>
        <span className="text-xs text-cafe-muted">{expanded ? 'Collapse' : 'Expand'}</span>
      </button>
      {!expanded && (
        <pre className="px-3 py-2 text-xs text-cafe-secondary font-mono whitespace-pre-wrap max-h-20 overflow-hidden">
          {block.preview}
          {'\n'}
          <span className="text-cafe-muted">...</span>
        </pre>
      )}
      {expanded && fullText && (
        <div className="max-h-96 overflow-auto">
          <MarkdownContent content={`\`\`\`\n${fullText}\n\`\`\``} />
        </div>
      )}
    </div>
  );
}

export function ContentBlocks({ blocks }: { blocks: MessageContent[] }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.type === 'text') {
          return <MarkdownContent key={i} content={block.text} />;
        }
        if (block.type === 'image') {
          const src = block.url.startsWith('/uploads/') ? `${API_URL}${block.url}` : block.url;
          return (
            // biome-ignore lint/performance/noImgElement: uploaded images cannot use next/image
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={i}
              src={src}
              alt="attached image"
              className="max-w-full sm:max-w-sm rounded-lg mt-2 border border-cafe cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => setLightboxSrc(src)}
            />
          );
        }
        if (block.type === 'paste') {
          return <PasteBlock key={i} block={block} />;
        }
        return null;
      })}
      {lightboxSrc && <Lightbox url={lightboxSrc} alt="attached image" onClose={() => setLightboxSrc(null)} />}
    </>
  );
}
