import { describe, it, expect } from "vitest";
import { isInQuietHours } from "./time.js";

function atLocal(hour, minute = 0) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

describe("isInQuietHours — wrapping window (22:00-08:00)", () => {
  const window = { start: "22:00", end: "08:00" };
  it("inside at 23:30", () => expect(isInQuietHours(atLocal(23, 30), window)).toBe(true));
  it("inside at 03:00", () => expect(isInQuietHours(atLocal(3, 0), window)).toBe(true));
  it("outside at 09:00", () => expect(isInQuietHours(atLocal(9, 0), window)).toBe(false));
  it("outside at 12:00", () => expect(isInQuietHours(atLocal(12, 0), window)).toBe(false));
  it("boundary: 22:00 is quiet (start inclusive)", () => expect(isInQuietHours(atLocal(22, 0), window)).toBe(true));
  it("boundary: 08:00 is NOT quiet (end exclusive)", () => expect(isInQuietHours(atLocal(8, 0), window)).toBe(false));
  it("boundary: 07:59 is quiet", () => expect(isInQuietHours(atLocal(7, 59), window)).toBe(true));
});

describe("isInQuietHours — non-wrapping window (12:00-14:00)", () => {
  const window = { start: "12:00", end: "14:00" };
  it("inside at 13:00", () => expect(isInQuietHours(atLocal(13, 0), window)).toBe(true));
  it("outside at 11:00", () => expect(isInQuietHours(atLocal(11, 0), window)).toBe(false));
  it("outside at 15:00", () => expect(isInQuietHours(atLocal(15, 0), window)).toBe(false));
  it("boundary: 12:00 is quiet", () => expect(isInQuietHours(atLocal(12, 0), window)).toBe(true));
  it("boundary: 14:00 is NOT quiet", () => expect(isInQuietHours(atLocal(14, 0), window)).toBe(false));
});
