import { describe, it, expect } from "vitest";
import { parsePositiveInt } from "./helpers.js";

describe("parsePositiveInt", () => {
  it("parses a valid positive integer", () => {
    expect(parsePositiveInt("42", 0)).toBe(42);
  });

  it("returns fallback for undefined", () => {
    expect(parsePositiveInt(undefined, 99)).toBe(99);
  });

  it("returns fallback for empty string", () => {
    expect(parsePositiveInt("", 10)).toBe(10);
  });

  it("returns fallback for non-numeric string", () => {
    expect(parsePositiveInt("abc", 5)).toBe(5);
  });

  it("returns fallback for zero", () => {
    expect(parsePositiveInt("0", 10)).toBe(10);
  });

  it("returns fallback for negative numbers", () => {
    expect(parsePositiveInt("-5", 10)).toBe(10);
  });

  it("handles whitespace around the number", () => {
    expect(parsePositiveInt("  100  ", 0)).toBe(100);
  });
});
