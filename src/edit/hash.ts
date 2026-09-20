/**
 * Fast, deterministic 32-bit rolling hash over source text.
 *
 * Used by edit plans to verify that a plan is committed against exactly the
 * same source snapshot that was analysed. Prefix edits change the hash.
 */
export function hashText(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let i = 0; i < text.length; ++i) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ ((c << 5) | (c >>> 11)), 0x85ebca6b) >>> 0
  }
  return (
    (h1 >>> 0).toString(36).padStart(7, '0') +
    (h2 >>> 0).toString(36).padStart(7, '0')
  )
}
