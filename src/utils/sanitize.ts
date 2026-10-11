// Control characters, zero-width characters and bidi overrides are stripped from user text.
// eslint-disable-next-line no-control-regex
const UNWANTED = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Normalises visitor-supplied text: NFC, strips control/invisible characters, collapses whitespace.
 * Output is stored as plain text and is NOT HTML-escaped: clients must render it as text
 * (textContent / React escaping) and never as HTML.
 */
export function sanitizeText(input: string): string {
  return input.normalize('NFC').replace(UNWANTED, ' ').replace(/\s+/g, ' ').trim();
}
