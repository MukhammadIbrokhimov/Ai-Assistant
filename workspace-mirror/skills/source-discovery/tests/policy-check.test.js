import { describe, it, expect } from "vitest";
import { regexPrecheck, validateEvidenceSnippet } from "../policy-check.js";

describe("regexPrecheck", () => {
  it("accepts 'clipping is allowed'", () => {
    expect(regexPrecheck("Clipping is allowed, please credit.")).toBe(true);
  });
  it("accepts 'feel free to clip'", () => {
    expect(regexPrecheck("Feel free to clip highlights.")).toBe(true);
  });
  it("accepts CC-BY", () => {
    expect(regexPrecheck("Licensed under Creative Commons Attribution 4.0.")).toBe(true);
  });
  it("rejects CC-BY-NC (non-commercial)", () => {
    expect(regexPrecheck("Creative Commons Attribution-NonCommercial")).toBe(false);
  });
  it("rejects plain prose with no permission language", () => {
    expect(regexPrecheck("All rights reserved. © 2026.")).toBe(false);
  });
  it("rejects 'we clip music under license' (not clip-permission)", () => {
    expect(regexPrecheck("We clip music under license.")).toBe(false);
  });
});

describe("validateEvidenceSnippet", () => {
  it("passes when snippet is substring of page text", () => {
    const page = "Long page text including 'Feel free to clip highlights' as policy.";
    expect(validateEvidenceSnippet("Feel free to clip highlights", page)).toBe(true);
  });
  it("fails when snippet is paraphrased/not found", () => {
    const page = "Long page text.";
    expect(validateEvidenceSnippet("Please feel free to clip", page)).toBe(false);
  });
});
