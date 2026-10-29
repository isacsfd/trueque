import { describe, expect, it } from "vitest";
import {
  decryptPersonalData,
  encryptPersonalData,
  fingerprintIdentity,
  normalizeDocument,
  normalizeIsbn,
  sha256,
} from "./crypto.ts";

describe("personal data handling", () => {
  it("encrypts with an authenticated cipher and decrypts only with the key", () => {
    const key = Buffer.alloc(32, 7);
    const ciphertext = encryptPersonalData("Ana Pérez", key);
    expect(ciphertext.toString("utf8")).not.toContain("Ana");
    expect(decryptPersonalData(ciphertext, key)).toBe("Ana Pérez");
    expect(() => decryptPersonalData(ciphertext, Buffer.alloc(32, 8))).toThrow();
  });

  it("normalizes identity and ISBN deterministically", () => {
    expect(normalizeDocument("  12 345 678 ")).toBe("12 345 678");
    expect(normalizeIsbn("978-3-16-148410-0")).toBe("9783161484100");
    expect(normalizeIsbn("0-306-40615-2")).toBe("0306406152");
    expect(normalizeIsbn("0-8044-2957-X")).toBe("080442957X");
    expect(normalizeIsbn("")).toBeNull();
    expect(normalizeIsbn(null)).toBeNull();
    expect(normalizeIsbn("978-3-16-148410-1")).toBeNull();
    expect(normalizeIsbn("invalid")).toBeNull();
    expect(fingerprintIdentity("123", Buffer.alloc(32, 1))).toHaveLength(32);
    expect(sha256("value")).toHaveLength(32);
  });
});
