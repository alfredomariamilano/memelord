import { describe, it, expect } from "bun:test";

// Replicate the vecBuf function from packages/sdk/src/store.ts for testing
function vecBuf(vec: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
}

describe("vecBuf", () => {
  it("should preserve Float32Array binary data", () => {
    const original = new Float32Array([1.0, 2.0, 3.0, 4.0, 5.0]);
    const buf = vecBuf(original);

    // Convert Buffer back to Float32Array using Uint8Array as bridge
    const bytes = new Uint8Array(buf.buffer.slice(0, buf.length));
    const recovered = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);

    // Compare element-by-element
    expect(recovered.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i]);
    }
  });

  it("should return correct byte length", () => {
    const original = new Float32Array([1.0, 2.0, 3.0]);
    const buf = vecBuf(original);

    // Float32Array: 4 bytes per element
    expect(buf.length).toBe(original.length * 4);
  });

  it("should handle empty Float32Array", () => {
    const original = new Float32Array(0);
    const buf = vecBuf(original);

    expect(buf.length).toBe(0);
    // Empty array — no recovery needed, just verify length
    expect(buf.byteLength).toBe(0);
  });

  it("should handle large Float32Array", () => {
    const size = 384; // Real embedding dimension
    const original = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      original[i] = i / size;
    }

    const buf = vecBuf(original);
    expect(buf.length).toBe(size * 4);

    // Convert Buffer back to Float32Array using Uint8Array as bridge
    const bytes = new Uint8Array(buf.buffer.slice(0, buf.length));
    const recovered = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    expect(recovered.length).toBe(size);
    for (let i = 0; i < size; i++) {
      expect(recovered[i]).toBeCloseTo(original[i]);
    }
  });

  it("should handle negative values", () => {
    const original = new Float32Array([-1.0, -2.0, -3.0]);
    const buf = vecBuf(original);

    const bytes = new Uint8Array(buf.buffer.slice(0, buf.length));
    const recovered = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    expect(recovered[0]).toBeCloseTo(-1.0);
    expect(recovered[1]).toBeCloseTo(-2.0);
    expect(recovered[2]).toBeCloseTo(-3.0);
  });

  it("should handle zero values", () => {
    const original = new Float32Array([0.0, 0.0, 0.0]);
    const buf = vecBuf(original);

    const bytes = new Uint8Array(buf.buffer.slice(0, buf.length));
    const recovered = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    expect(recovered[0]).toBe(0.0);
    expect(recovered[1]).toBe(0.0);
    expect(recovered[2]).toBe(0.0);
  });

  it("should handle subarray (offset/boundaries)", () => {
    const original = new Float32Array([0.0, 1.0, 2.0, 3.0, 4.0]);
    const subarray = original.subarray(1, 4); // [1.0, 2.0, 3.0]

    const buf = vecBuf(subarray);
    expect(buf.length).toBe(3 * 4); // 3 elements * 4 bytes

    const bytes = new Uint8Array(buf.buffer.slice(0, buf.length));
    const recovered = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    expect(recovered.length).toBe(3);
    expect(recovered[0]).toBeCloseTo(1.0);
    expect(recovered[1]).toBeCloseTo(2.0);
    expect(recovered[2]).toBeCloseTo(3.0);
  });
});
