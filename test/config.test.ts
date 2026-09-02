import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config";

const base = {
  STUPID_UPLOAD_HMAC_SECRET: "0123456789abcdef0123456789abcdef01234567",
  STUPID_UPLOAD_ADMIN_SECRET: "0123456789abcdef12345678",
};

describe("loadConfig boolean coercion is string-safe", () => {
  function flagFor(value: unknown | undefined): boolean {
    const vars = {
      ...base,
      ...(value === undefined ? {} : { STUPID_UPLOAD_PERMANENT_PAYMENT_ENABLED: value }),
    };
    return loadConfig(vars).STUPID_UPLOAD_PERMANENT_PAYMENT_ENABLED;
  }

  it("defaults to false when unset", () => {
    expect(flagFor(undefined)).toBe(false);
  });

  it("parses 'true' and '1' as true", () => {
    expect(flagFor("true")).toBe(true);
    expect(flagFor("1")).toBe(true);
  });

  it("parses 'false' and '0' as false (not truthy strings)", () => {
    expect(flagFor("false")).toBe(false);
    expect(flagFor("0")).toBe(false);
  });

  it("does not make an unknown string truthy", () => {
    expect(flagFor("yes")).toBe(false);
  });
});
