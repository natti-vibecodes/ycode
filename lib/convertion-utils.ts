/**
 * Conversion utilities for encoding/decoding UUIDs to compact URL-safe strings
 */

const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Encode a UUID to a base62 string (22 chars)
 * @param uuid - Standard UUID string (e.g., "8f2a4b1c-7d8e-4f12-b345-6789abcdef01")
 * @returns Base62-encoded string (e.g., "6sFz3Kx9qB2nJhWm4PdYrT")
 */
export function uuidToBase62(uuid: string): string {
  const hex = uuid.replace(/-/g, '');
  let num = BigInt('0x' + hex);
  const ZERO = BigInt(0);
  const BASE = BigInt(62);
  if (num === ZERO) return '0'.padStart(22, '0');

  const chars: string[] = [];
  while (num > ZERO) {
    chars.unshift(BASE62_CHARS[Number(num % BASE)]);
    num = num / BASE;
  }

  return chars.join('').padStart(22, '0');
}

/**
 * Decode a base62 string back to a UUID
 * @param b62 - Base62-encoded string (22 chars)
 * @returns Standard UUID string with dashes
 */
export function base62ToUuid(b62: string): string {
  let num = BigInt(0);
  const BASE = BigInt(62);
  for (const char of b62) {
    const idx = BASE62_CHARS.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base62 character: ${char}`);
    num = num * BASE + BigInt(idx);
  }

  const hex = num.toString(16).padStart(32, '0');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Get file extension from MIME type for proxy URLs
 */
export function mimeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/mpeg': 'mpeg',
    'video/webm': 'webm',
    'video/ogg': 'ogv',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/webm': 'weba',
    'audio/aac': 'aac',
    'application/pdf': 'pdf',
    // Site code. Without these three the fallback below takes the subtype verbatim, so
    // `text/javascript` produced `/a/<hash>/site.javascript` — a working URL, but not one
    // anybody hand-writes, so `/a/<hash>/site.js` cost a 301 on every guess. Chrome is
    // referenced through this path on every page of the site (SCA-1469), which is what
    // made the cosmetics worth a line. `text/css` already resolved to `css` through the
    // fallback; it is spelled out here so the three site-code types read as one decision.
    'text/css': 'css',
    'text/javascript': 'js',
    'application/javascript': 'js',
  };

  return map[mimeType] || mimeType.split('/').pop() || 'bin';
}
