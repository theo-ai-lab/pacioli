import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, tryCreateSqliteStore, type StoredReceipt } from "./receipt-store";

const mk = (id: string, balanced: boolean, types: string[], createdAt = 1): StoredReceipt => ({
  receiptId: id,
  receiptHash: "h" + id,
  balanced,
  findingTypes: types,
  agent: "a",
  merchant: "m",
  deltaUsd: null,
  createdAt,
});

// Isolated temp dir — DB files must not accumulate in /tmp across runs (state-leak class).
const dir = mkdtempSync(join(tmpdir(), "pacioli-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("receipt store", () => {
  it("memory: saves, gets, lists, and aggregates stats", async () => {
    const s = createMemoryStore();
    await s.save(mk("r1", true, []));
    await s.save(mk("r2", false, ["OVERSPEND", "SCOPE_CREEP"]));
    await s.save(mk("r3", false, ["OVERSPEND"]));
    expect(s.get("r2")?.findingTypes).toContain("SCOPE_CREEP");
    expect(s.list()).toHaveLength(3);
    expect(s.stats()).toMatchObject({ total: 3, events: 3, flagged: 2 });
    expect(s.stats().byType.OVERSPEND).toBe(2);
  });

  it("memory: a replay is an EVENT, not a new receipt (content-addressed dedupe + seenCount)", async () => {
    const s = createMemoryStore();
    await s.save(mk("r1", false, ["OVERSPEND"]));
    await s.save(mk("r1", false, ["OVERSPEND"]));
    expect(s.stats()).toMatchObject({ total: 1, events: 2 });
    expect(s.get("r1")?.seenCount).toBe(2);
  });

  it("node:sqlite: persists durably and counts replays, keeping the FIRST createdAt", async () => {
    const s = await tryCreateSqliteStore(join(dir, "replay.db"));
    if (!s) return; // node:sqlite unavailable on this runtime — skip
    expect(s.backend).toBe("sqlite");
    await s.save(mk("x1", false, ["OVERSPEND"], 111));
    await s.save(mk("x1", false, ["OVERSPEND"], 999)); // replay later — audit log keeps first-seen time
    await s.save(mk("x2", true, []));
    expect(s.get("x1")?.seenCount).toBe(2);
    expect(s.get("x1")?.createdAt).toBe(111);
    expect(s.stats()).toMatchObject({ total: 2, events: 3, flagged: 1 });
  });

  it("memory: bounded at MEMORY_CAP — a flood evicts oldest instead of growing without limit", async () => {
    const s = createMemoryStore();
    for (let i = 0; i < 10_001; i++) await s.save(mk(`f${i}`, true, [], i));
    expect(s.stats().total).toBe(10_000);
    expect(s.get("f0")).toBeNull(); // oldest evicted
    expect(s.get("f10000")).not.toBeNull(); // newest kept
  });
});
