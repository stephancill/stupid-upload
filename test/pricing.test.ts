import { describe, it, expect } from "vitest";
import {
  pricePermanent,
  priceTemporary,
  pricePermanentUsd,
  billableMiB,
  usdToAtomic,
  atomicToUsd,
  PAYMENT_NETWORKS,
} from "../src/pricing";

const MIB = 1048576;

describe("pricing boundaries", () => {
  it("bills a flat $0.01 for empty to 1 MiB permanent", () => {
    expect(pricePermanentUsd(0)).toBe(0.01);
    expect(pricePermanentUsd(1)).toBe(0.01);
    expect(pricePermanentUsd(MIB)).toBe(0.01);
  });

  it("adds $0.002 per started MiB after the first", () => {
    expect(pricePermanentUsd(MIB + 1)).toBe(0.012);
    expect(pricePermanentUsd(10 * MIB)).toBe(0.01 + 9 * 0.002);
    expect(pricePermanentUsd(100 * MIB)).toBe(0.01 + 99 * 0.002);
  });

  it("rejects over-limit sizes via pricePermanent advisory", () => {
    expect(() => pricePermanent(100 * MIB + 1)).toThrow(/limit/);
  });

  it("returns atomic six-decimal values and the expectation amounts", () => {
    const p = pricePermanent(MIB + 1);
    expect(p.priceAtomic).toBe(usdToAtomic(0.012));
    expect(p.network).toBe(PAYMENT_NETWORKS.production);
    expect(atomicToUsd(p.priceAtomic)).toBe("0.012000");
  });

  it("bills the first MiB incrementally and reports permanent retention", () => {
    const p = pricePermanent(10 * MIB);
    expect(p.billableMiB).toBe(10);
    expect(p.priceUsd).toBeCloseTo(0.028, 9);
  });

  it("0 bytes permanent still bills the minimum", () => {
    const p = pricePermanent(0);
    expect(p.priceUsd).toBe(0.01);
  });
});

describe("billableMiB", () => {
  it("counts partial bytes as a full MiB", () => {
    expect(billableMiB(0)).toBe(1);
    expect(billableMiB(1)).toBe(1);
    expect(billableMiB(MIB)).toBe(1);
    expect(billableMiB(MIB + 1)).toBe(2);
  });
});

describe("temporary pricing", () => {
  it("is free and reports temporary retention", () => {
    const t = priceTemporary(1234);
    expect(t.priceUsd).toBe(0);
    expect(t.retention[0]?.type).toBe("temporary");
  });
});
