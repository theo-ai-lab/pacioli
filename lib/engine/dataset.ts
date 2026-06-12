/**
 * Pacioli — dataset loader (server-only; reads the labeled JSONL corpus).
 *
 * The corpus mirrors the provenance firewall on disk:
 *   - ground-truth.seed.jsonl — synthetic fixtures (engine dev; never a reported number)
 *   - incidents.jsonl         — documented public incidents (real, but a separate class)
 *   - captured.jsonl          — your real commissioned runs (gitignored; the only headline source)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GroundTruthSample } from "./types";

const DATASET_DIR = join(process.cwd(), "dataset");

export function loadJsonl(file: string): GroundTruthSample[] {
  let raw: string;
  try {
    raw = readFileSync(join(DATASET_DIR, file), "utf8");
  } catch {
    return []; // file absent (e.g. gitignored captured.jsonl) — an honest empty per the firewall
  }
  const rows: GroundTruthSample[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as GroundTruthSample;
      // light shape guard: skip a single malformed line rather than dropping the whole file
      if (row?.input?.claim && row?.input?.evidence && row?.target && row?.meta) rows.push(row);
    } catch {
      /* skip the bad line */
    }
  }
  return rows;
}

/** Synthetic engine-development fixtures only (firewall: never a reported rate). */
export const loadSeed = (): GroundTruthSample[] =>
  loadJsonl("ground-truth.seed.jsonl").filter((r) => r.meta.provenance === "synthetic-seed");

/** Documented public incidents (real-world evidence; a supporting class, not the headline rate). */
export const loadIncidents = (): GroundTruthSample[] => loadJsonl("incidents.jsonl");

/** Real commissioned runs (gitignored). Eligible for the headline misbehavior rate. */
export const loadCaptured = (): GroundTruthSample[] => loadJsonl("captured.jsonl");
