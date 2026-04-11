import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

/**
 * Build prompt hints for local image paths.
 * These are path references for tool access, not binary attachments.
 */
export function buildLocalImagePathHints(imagePaths: readonly string[]): string {
  if (imagePaths.length === 0) return '';
  return imagePaths.map((p) => `[Local image path: ${p}]`).join('\n');
}

/**
 * Append local image path hints to an existing prompt.
 */
export function appendLocalImagePathHints(prompt: string, imagePaths: readonly string[]): string {
  const hints = buildLocalImagePathHints(imagePaths);
  if (!hints) return prompt;
  return `${prompt}\n\n${hints}`;
}

/**
 * Read paste files and append their content to the prompt.
 * Unlike images (path hints), paste text is injected directly so the AI always sees it.
 */
export async function appendPasteFileContent(prompt: string, pastePaths: readonly string[]): Promise<string> {
  if (pastePaths.length === 0) return prompt;

  const sections: string[] = [];
  for (const filePath of pastePaths) {
    try {
      const content = await readFile(filePath, 'utf-8');
      const name = basename(filePath);
      sections.push(`[Pasted text — ${name}]\n\`\`\`\n${content}\n\`\`\`\n[End of pasted text]`);
    } catch {
      // File missing or unreadable — skip silently
    }
  }

  if (sections.length === 0) return prompt;
  return `${prompt}\n\n${sections.join('\n\n')}`;
}

/**
 * Extract unique directory list from image paths for CLI workspace include flags.
 */
export function collectImageAccessDirectories(imagePaths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const imagePath of imagePaths) {
    const dir = dirname(imagePath);
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}
