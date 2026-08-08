/**
 * HTML escaping for ANY user-influenced value interpolated into a template.
 * Every dynamic field (names, timezones, free text) passes through this before
 * it reaches the HTML body — templates never interpolate raw input.
 */
export function escapeHtml(input: unknown): string {
  const s = input === null || input === undefined ? '' : String(input);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Plain-text safety: drop control characters (keeping tab and newline) so a
 * dynamic value can never break header/body structure. Implemented by code point
 * to avoid embedding control characters in source.
 */
export function plainText(input: unknown): string {
  const s = input === null || input === undefined ? '' : String(input);
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 || ch === '\n' || ch === '\t') out += ch;
  }
  return out;
}
