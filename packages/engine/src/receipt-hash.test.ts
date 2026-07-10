import { describe, it, expect } from "vitest";
import { receiptHash, fingerprint, verifyReceipt, chainHash } from "./receipt-hash";
import { diff } from "./diff";
import type { DiffInput } from "./types";

const mk = (amount: number): DiffInput => ({
  claim: { agent: "a", task: "t", text: "t", authorized: { budgetUsd: 300, mayPurchase: true } },
  evidence: { source: "email", merchant: "m", amountUsd: amount, date: "2026-06-14", items: [], recurring: false, excerpt: "x" },
});

describe("verifiable receipts (SHA-256 content addressing)", () => {
  it("is deterministic and a 64-hex-char digest", async () => {
    const i = mk(378);
    const v = diff(i);
    expect(await receiptHash(i, v)).toBe(await receiptHash(i, v));
    expect(await receiptHash(i, v)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any field changes (tamper-evident)", async () => {
    expect(await receiptHash(mk(378), diff(mk(378)))).not.toBe(await receiptHash(mk(379), diff(mk(379))));
  });

  it("verifyReceipt detects tampering with the verdict", async () => {
    const i = mk(378);
    const v = diff(i);
    const h = await receiptHash(i, v);
    expect(await verifyReceipt(i, v, h)).toBe(true);
    expect(await verifyReceipt(i, { ...v, balanced: !v.balanced }, h)).toBe(false);
  });

  it("is canonical — key order does not affect the hash", async () => {
    const i = mk(378);
    const v = diff(i);
    const reordered: DiffInput = { evidence: i.evidence, claim: i.claim };
    expect(await receiptHash(i, v)).toBe(await receiptHash(reordered, v));
  });

  it("chains receipts deterministically and tamper-evidently", async () => {
    const h1 = await receiptHash(mk(378), diff(mk(378)));
    const c1 = await chainHash("GENESIS", h1);
    expect(await chainHash("GENESIS", h1)).toBe(c1);
    expect(c1).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(h1)).toHaveLength(16);
  });
});
