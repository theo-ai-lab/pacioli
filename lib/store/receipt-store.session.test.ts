import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore, tryCreateSqliteStore, type StoredReceipt } from "./receipt-store";

const mk = (id: string, balanced: boolean, types: string[], sessionKey?: string, createdAt = 1): StoredReceipt => ({
  receiptId: id,
  receiptHash: "h" + id,
  balanced,
  findingTypes: types,
  agent: "a",
  merchant: "m",
  deltaUsd: null,
  createdAt,
  sessionKey,
});

const dir = mkdtempSync(join(tmpdir(), "pacioli-session-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("receipt store — per-user/session ledger (additive)", () => {
  it("memory: scopes list + stats to a session key without disturbing the global view", async () => {
    const s = createMemoryStore();
    await s.save(mk("a1", false, ["OVERSPEND"], "user-alice", 1));
    await s.save(mk("a2", true, [], "user-alice", 2));
    await s.save(mk("b1", false, ["SCOPE_CREEP"], "user-bob", 3));
    await s.save(mk("g1", true, [])); // no session → global only

    expect(s.listBySession("user-alice").map((r) => r.receiptId)).toEqual(["a2", "a1"]); // newest first
    expect(s.statsBySession("user-alice")).toMatchObject({ total: 2, events: 2, flagged: 1 });
    expect(s.statsBySession("user-bob")).toMatchObject({ total: 1, flagged: 1 });
    expect(s.statsBySession("user-bob").byType.SCOPE_CREEP).toBe(1);

    // the global ledger still sees everything (additive, non-destructive)
    expect(s.stats().total).toBe(4);
    // an unknown key is empty, never a leak of another user's rows
    expect(s.listBySession("nobody")).toEqual([]);
    expect(s.statsBySession("nobody")).toMatchObject({ total: 0, events: 0, flagged: 0 });
  });

  it("memory: a replay under the same content keeps its first session and counts as an event", async () => {
    const s = createMemoryStore();
    await s.save(mk("r1", false, ["OVERSPEND"], "user-alice", 1));
    await s.save(mk("r1", false, ["OVERSPEND"], "user-alice", 9)); // replay
    expect(s.statsBySession("user-alice")).toMatchObject({ total: 1, events: 2 });
  });

  it("node:sqlite: persists, scopes by session, and isolates keys", async () => {
    const s = await tryCreateSqliteStore(join(dir, "session.db"));
    if (!s) return; // node:sqlite unavailable on this runtime — skip
    expect(s.backend).toBe("sqlite");
    await s.save(mk("a1", false, ["OVERSPEND"], "user-alice", 10));
    await s.save(mk("a2", true, [], "user-alice", 20));
    await s.save(mk("b1", false, ["SCOPE_CREEP"], "user-bob", 30));
    await s.save(mk("g1", true, [])); // global-only

    expect(s.listBySession("user-alice").map((r) => r.receiptId)).toEqual(["a2", "a1"]); // createdAt DESC
    expect(s.get("a1")?.sessionKey).toBe("user-alice");
    expect(s.get("g1")?.sessionKey).toBeUndefined();
    expect(s.statsBySession("user-alice")).toMatchObject({ total: 2, flagged: 1 });
    expect(s.statsBySession("user-bob")).toMatchObject({ total: 1, flagged: 1 });
    expect(s.stats().total).toBe(4); // global unaffected
    expect(s.listBySession("nobody")).toEqual([]);
  });

  it("node:sqlite: ADDITIVELY migrates a pre-session DB (no sessionKey column) without data loss", async () => {
    // Variable specifier keeps the typechecker from requiring node:sqlite types (same trick the
    // store module uses) — it's a runtime built-in (Node >= 22.5), not a typed dependency.
    interface RawDb {
      exec(s: string): void;
      prepare(s: string): { run(...a: unknown[]): unknown };
    }
    const NODE_SQLITE = "node:sqlite";
    let DatabaseSync: (new (p: string) => RawDb) | null = null;
    try {
      ({ DatabaseSync } = (await import(NODE_SQLITE)) as { DatabaseSync: new (p: string) => RawDb });
    } catch {
      return; // node:sqlite unavailable — skip
    }
    if (!DatabaseSync) return;

    const path = join(dir, "legacy.db");
    // Seed a DB with the ORIGINAL pre-session schema (8 cols + seenCount), one legacy row.
    const legacy = new DatabaseSync(path);
    legacy.exec(
      `CREATE TABLE receipts (receiptId TEXT PRIMARY KEY, receiptHash TEXT, balanced INTEGER,
       findingTypes TEXT, agent TEXT, merchant TEXT, deltaUsd REAL, createdAt INTEGER, seenCount INTEGER NOT NULL DEFAULT 1)`,
    );
    legacy.prepare(`INSERT INTO receipts VALUES (?,?,?,?,?,?,?,?,1)`).run("old1", "hold1", 0, "OVERSPEND", "a", "m", null, 5);

    // Opening it through the store must ADD the column, preserve the legacy row, and accept session writes.
    const s = await tryCreateSqliteStore(path);
    expect(s).not.toBeNull();
    expect(s!.get("old1")?.sessionKey).toBeUndefined(); // legacy row survives, ungrouped
    expect(s!.stats().total).toBe(1);
    await s!.save(mk("new1", true, [], "user-alice", 6));
    expect(s!.listBySession("user-alice").map((r) => r.receiptId)).toEqual(["new1"]);
    expect(s!.stats().total).toBe(2);
  });
});
