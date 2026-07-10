/**
 * Pacioli — dataset loader (server-only; reads the labeled JSONL corpus).
 *
 * The corpus mirrors the provenance firewall on disk:
 *   - ground-truth.seed.jsonl  — synthetic fixtures (engine dev; never a reported number)
 *   - incidents.jsonl          — documented public incidents (real, but a separate class)
 *   - captured.jsonl           — your real commissioned runs, RAW (gitignored; never ships)
 *   - captured.public.jsonl    — the committed redacted projection of those same runs
 *                                (`npm run capture:publish`; contract fields + short no-PII
 *                                excerpt only) — how the deployed site and any stranger see
 *                                the headline-eligible rows without the personal data
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GroundTruthSample } from "@pacioli-app/engine";

const DATASET_DIR = join(process.cwd(), "dataset");

export function loadJsonl(file: string, dir: string = DATASET_DIR): GroundTruthSample[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, file), "utf8");
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

/**
 * Real commissioned runs — the only rows eligible for the headline misbehavior rate.
 * The raw corpus (captured.jsonl, gitignored) wins when present; otherwise the committed
 * redacted corpus (captured.public.jsonl, emitted by `npm run capture:publish`) supplies
 * the same runs — both describe the same captures, so they are never merged.
 */
export const loadCaptured = (dir: string = DATASET_DIR): GroundTruthSample[] => {
  const raw = loadJsonl("captured.jsonl", dir);
  return raw.length > 0 ? raw : loadJsonl("captured.public.jsonl", dir);
};
