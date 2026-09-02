import { describe, it, expect, beforeEach } from "vitest";
import {
  pricePermanent,
  priceTemporary,
  pricePermanentUsd,
  billableMiB,
  usdToAtomic,
  atomicToUsd,
  PAYMENT_NETWORKS,
} from "../src/pricing";
import { app } from "../src/app";
import { makeTestEnv } from "./helpers/fake";

const MIB = 1048576;

describe("(HTTP) /v1/pricing stays JSON-serializable", () => {
  let W: ReturnType<typeof makeTestEnv>;
  beforeEach(() => {
    W = makeTestEnv();
  });

  async function getPricing(sizeBytes: number) {
    return app.request(`/v1/pricing?sizeBytes=${sizeBytes}`, {}, W);
  }

  it("returns 200 JSON for a sub-1-MiB advisory (no BigInt 500)", async () => {
    const res = await getPricing(1234);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.sizeBytes).toBe(1234);
    expect(body.permanent.priceUsd).toBe(0.01);
    expect(typeof body.priceAtomic).toBe("number");
    expect(typeof body.permanent.priceAtomic).toBe("number");
  });

  it("returns 200 JSON for a permanent >1 MiB advisory (no BigInt 500)", async () => {
    const res = await getPricing(10 * MIB);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.priceUsd).toBeCloseTo(0.028, 9);
    expect(typeof body.priceAtomic).toBe("number");
    expect(body.priceAtomic).toBe(28000);
  });

  it("rejects out-of-range and validates boundaries at the HTTP layer", async () => {
    expect((await getPricing(100 * MIB + 1)).status).toBe(400);
    expect((await getPricing(100 * MIB)).status).toBe(200); // max exactly
    expect((await getPricing(0)).status).toBe(200); // min
  });
});

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
