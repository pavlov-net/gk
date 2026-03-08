import { describe, expect, test } from "bun:test";
import { newId } from "../src/id";

describe("newId", () => {
  test("returns 16-char string", () => {
    const id = newId();
    expect(id).toHaveLength(16);
    expect(typeof id).toBe("string");
  });

  test("returns unique values", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });
});
