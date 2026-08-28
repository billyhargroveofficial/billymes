/**
 * Category identity colour.
 *
 * A label must read the same wherever it shows up — the memory ribbon, a skill
 * row, a cluster bar — so the hue is derived from the text itself rather than
 * from list position, which shifts every time the counts move. Only the hue
 * leaves this module: lightness and chroma live in the `.cat-swatch` and
 * `.cat-tint` rules so both themes stay legible.
 */
export function categoryHue(category: string) {
  let hash = 2166136261
  for (let index = 0; index < category.length; index += 1) {
    hash ^= category.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 360
}
