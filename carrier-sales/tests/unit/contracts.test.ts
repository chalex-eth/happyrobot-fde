import { describe, expect, it } from "vitest";
import { mcNumberSchema, runIdSchema } from "@/contracts/identifiers";
import { moneyCentsSchema } from "@/contracts/money";

describe("scaffold contract primitives", () => {
  it("uses non-negative, safe integer cents", () => {
    expect(moneyCentsSchema.parse(125_000)).toBe(125_000);
    for (const value of [-1, 1.25, "125000", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(moneyCentsSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects blank run identifiers", () => {
    expect(runIdSchema.safeParse(" ").success).toBe(false);
  });

  it("retains MC leading zeroes and rejects non-digits", () => {
    expect(mcNumberSchema.parse("001234")).toBe("001234");
    expect(mcNumberSchema.safeParse("MC-1234").success).toBe(false);
  });
});
