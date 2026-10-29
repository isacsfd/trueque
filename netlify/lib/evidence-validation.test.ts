// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  MAX_EVIDENCE_BYTES,
  evidenceFileName,
  inspectEvidenceImage,
} from "./evidence-validation.ts";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("evidence image validation", () => {
  it("accepts a real PNG and computes dimensions", () => {
    expect(inspectEvidenceImage(onePixelPng)).toMatchObject({
      mime: "image/png",
      width: 1,
      height: 1,
    });
  });

  it("rejects text, SVG and truncated files even with an image extension", () => {
    expect(() => inspectEvidenceImage(Buffer.from("<svg></svg>"))).toThrow(/JPEG, PNG o WebP/);
    expect(() => inspectEvidenceImage(Buffer.from("not an image"))).toThrow(/JPEG, PNG o WebP/);
    expect(() => inspectEvidenceImage(onePixelPng.subarray(0, 20))).toThrow(/PNG/);
  });

  it("rejects files above the byte limit before parsing", () => {
    expect(() => inspectEvidenceImage(Buffer.alloc(MAX_EVIDENCE_BYTES + 1, 0))).toThrow(/4 MB/);
  });

  it("creates a safe download filename", () => {
    expect(evidenceFileName("42", "image/jpeg")).toBe("evidence-42.jpg");
    expect(evidenceFileName("<script>", "image/png")).toBe("evidence-unknown.png");
  });
});
