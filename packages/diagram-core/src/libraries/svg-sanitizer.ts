/**
 * Strips constructs that could execute script or load external resources from an inline SVG/XML
 * fragment. Applied to icon `assetRef` values at ingestion time (loadLibrary): this repo's
 * bundled libraries embed inline SVG markup directly in `assetRef` (see azure-icons.ts /
 * aws-icons.ts), and a future admin-uploaded library (POST /libraries) could otherwise smuggle a
 * `<script>` or an `onload=` handler into a diagram's rendered SVG/PNG export.
 *
 * Only applies to values that look like markup (start with `<`) — plain path/URL asset
 * references (e.g. "icons/azure/blob-storage.svg", "shape:rectangle") pass through untouched.
 */
export function sanitizeSvgFragment(assetRef: string): string {
  const trimmed = assetRef.trimStart();
  if (!trimmed.startsWith('<')) return assetRef;

  return assetRef
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*"(?:[^"\\]|\\.)*"/gi, '')
    .replace(/\son\w+\s*=\s*'(?:[^'\\]|\\.)*'/gi, '')
    .replace(/(href|xlink:href|src)\s*=\s*"javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|xlink:href|src)\s*=\s*'javascript:[^']*'/gi, "$1='#'");
}
