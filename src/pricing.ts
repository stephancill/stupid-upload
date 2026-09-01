import { LIMITS } from "./config";

/** USDC uses six decimal places. */
export const USDC_DECIMALS = 6;

/** Minimum price ($0.01) for any permanent upload (first MiB flat). */
export const PERMANENT_MIN_PRICE_USD = 0.01;

/** Incremental price per started MiB beyond the first. */
export const PERMANENT_MIB_PRICE_USD = 0.002;

export const MIB = 1048576;

export const PAYMENT_NETWORKS = {
  production: "eip155:8453",
  test: "eip155:84532",
} as const;

/** Convert a whole-dollar value to atomic six-decimal USDC units. */
export function usdToAtomic(usd: number): bigint {
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
}

/** Convert atomic six-decimal units to a fixed six-decimal dollar string. */
export function atomicToUsd(atomic: bigint): string {
  return (Number(atomic) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS);
}

/** Whole MiB billable, counting any partial byte as a full MiB. */
export function billableMiB(sizeBytes: number): number {
  if (sizeBytes <= 0) return 1;
  return Math.ceil(sizeBytes / MIB);
}

/**
 * Permanent price in USD: $0.01 for the first MiB plus $0.002 per additional
 * started MiB. An empty or sub-1-MiB file still bills the $0.01 minimum.
 */
export function pricePermanentUsd(sizeBytes: number): number {
  const extra = Math.max(0, billableMiB(sizeBytes) - 1);
  return PERMANENT_MIN_PRICE_USD + extra * PERMANENT_MIB_PRICE_USD;
}

/**
 * Advisory pricing payload for a permanent upload of `sizeBytes`.
 * The runtime x402 challenge is authoritative for the exact amount owed.
 */
export function pricePermanent(sizeBytes: number) {
  assertSize(sizeBytes, LIMITS.maxPermanentBytes);
  const usd = pricePermanentUsd(sizeBytes);
  return {
    sizeBytes,
    billableMiB: billableMiB(sizeBytes),
    priceUsd: usd,
    priceAtomic: usdToAtomic(usd),
    priceAtomicString: usdToAtomic(usd).toString(),
    limits: {
      maxTemporaryBytes: LIMITS.maxTemporaryBytes,
      maxPermanentBytes: LIMITS.maxPermanentBytes,
    },
    network: PAYMENT_NETWORKS.production,
    retention: [{ type: "permanent", label: "no scheduled expiry" }],
  };
}

/** Advisory pricing payload for a temporary upload of `sizeBytes`. */
export function priceTemporary(sizeBytes: number) {
  assertSize(sizeBytes, LIMITS.maxTemporaryBytes);
  return {
    sizeBytes,
    priceUsd: 0,
    priceAtomic: 0,
    limits: {
      maxTemporaryBytes: LIMITS.maxTemporaryBytes,
      maxPermanentBytes: LIMITS.maxPermanentBytes,
    },
    network: PAYMENT_NETWORKS.production,
    retention: [{ type: "temporary", expiresAfterSeconds: 86400 }],
  };
}

function assertSize(sizeBytes: number, within: number): void {
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("sizeBytes must be a non-negative integer");
  }
  if (sizeBytes > within) {
    throw new Error("sizeBytes exceeds the allowed limit");
  }
}
