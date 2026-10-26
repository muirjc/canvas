import { MAX_SVG_BYTES, prepareUploadedSvg } from '@canvas/diagram-core';

/** canvas-3dq: a data: URI for an icon's artwork (an SVG fragment in the 48x48 icon space). Used as
 *  an <img> source, never as inline markup -- browsers do not run script from an image resource. */
export function iconDataUri(assetRef: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${assetRef}</svg>`,
  )}`;
}

export function displayNameFromFile(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : fileName;
}

export function parseKeywords(text: string): string[] {
  return text
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 20);
}

export interface SvgDraft {
  key: string;
  fileName: string;
  svg: string;
  displayName: string;
  category: string;
  keywords: string;
  /** The fitted artwork, when the file passed the local check. */
  preview?: string;
  /** Why the file can't be used; such files are shown but not sent. */
  error?: string;
}

/** Reads the chosen files and runs the same clean-up the server will, so problems show before saving. */
export async function readSvgDrafts(files: File[]): Promise<SvgDraft[]> {
  return Promise.all(
    files.map(async (file, index) => {
      const draft: SvgDraft = {
        key: `${index}-${file.name}`,
        fileName: file.name,
        svg: '',
        displayName: displayNameFromFile(file.name),
        category: '',
        keywords: '',
      };
      if (file.size > MAX_SVG_BYTES) return { ...draft, error: `The file is too large (over ${MAX_SVG_BYTES / 1024} KB).` };
      try {
        draft.svg = await file.text();
        draft.preview = prepareUploadedSvg(draft.svg, `preview-${index}`);
      } catch (err) {
        draft.error = err instanceof Error ? err.message : 'The file could not be read.';
      }
      return draft;
    }),
  );
}

export function toUploadIcons(drafts: SvgDraft[]) {
  return drafts
    .filter((d) => !d.error)
    .map((d) => ({
      fileName: d.fileName,
      svg: d.svg,
      ...(d.displayName.trim() ? { displayName: d.displayName.trim() } : {}),
      ...(d.category.trim() ? { category: d.category.trim() } : {}),
      ...(parseKeywords(d.keywords).length ? { keywords: parseKeywords(d.keywords) } : {}),
    }));
}
