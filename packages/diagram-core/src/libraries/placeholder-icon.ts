/**
 * Generates a simple, consistent placeholder glyph (colored rounded square + short label) on a
 * normalized 48x48 viewBox, used by the bundled azure-icons/aws-icons manifests in place of the
 * vendors' actual proprietary icon artwork (see those files' doc comments for why).
 */
export function placeholderIconMarkup(glyph: string, colorHex: string): string {
  return [
    `<rect x="2" y="2" width="44" height="44" rx="8" fill="${colorHex}" />`,
    `<text x="24" y="30" text-anchor="middle" font-size="16" font-family="sans-serif" fill="#ffffff">${glyph}</text>`,
  ].join('');
}
