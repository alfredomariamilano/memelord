/**
 * Deterministic mock embedding function for store tests.
 *
 * Hashes text into a 384-dimensional Float32Array using a simple hash
 * function and sinusoidal mapping, then normalizes to unit length.
 *
 * Same input always produces the same vector (deterministic).
 * Different inputs produce different vectors.
 * Output magnitude ≈ 1.0 (normalized).
 */

const DIMENSIONS = 384;

/**
 * Simple hash function: djb2 variant — deterministic, fast, decent avalanche.
 */
function hashText(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    // Rotate left by 5 bits and add char code
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Create a deterministic mock embedding for the given text.
 * Each dimension is computed from a hash of the text combined with the dimension index,
 * mapped through Math.sin to produce values in [-1, 1], then normalized to unit length.
 *
 * @param text - The text to embed
 * @returns A normalized Float32Array of length 384
 */
export function mockEmbed(text: string): Promise<Float32Array> {
  const baseHash = hashText(text);
  const vec = new Float32Array(DIMENSIONS);

  for (let i = 0; i < DIMENSIONS; i++) {
    // Combine base hash with dimension index for per-dimension variation
    const combined = baseHash + i * 2654435761; // golden ratio multiplier
    vec[i] = Math.sin(combined);
  }

  // Normalize to unit length
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < DIMENSIONS; i++) {
      vec[i] /= norm;
    }
  }

  return Promise.resolve(vec);
}
