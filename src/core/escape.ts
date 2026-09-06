// src/render/escape.ts
// & must come first, or you escape the ampersands of your own entities.
export const escapeHtml = (t: string): string =>
  t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
