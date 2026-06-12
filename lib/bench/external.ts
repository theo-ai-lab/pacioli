/**
 * Pacioli — general external-benchmark adapter.
 *
 * Ingests ANY external agent dataset (Agents' Last Exam, τ², a CRM-dispute corpus, …) via a pluggable
 * MAPPER that converts a raw task into Pacioli's claim-vs-evidence input — or returns null when the
 * task has no money/scope dimension (out of Pacioli's lane). Runs the deterministic engine over the
 * mapped subset and reports **honest coverage** (how much of the dataset actually maps) plus per-class
 * precision/recall over any gold-labeled tasks. Coverage being a thin slice for a task-completion
 * benchmark is reported plainly, not hidden.
 */
import { diff } from "../engine/diff";
import { FINDING_TYPES, type DiffInput, type FindingType } from "../engine/types";

export interface MappedTask {
  id: string;
  input: DiffInput;
  /** Gold finding types, if the source provides labels. */
  expect?: FindingType[];
}

/** Convert a raw dataset row into a Pacioli task, or null if it has no money/scope dimension. */
export type Mapper<T> = (raw: T, index: number) => MappedTask | null;

export interface ClassScore {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
}

export interface AdapterReport {
  total: number;
  mapped: number;
  /** mapped / total — the share of the benchmark that maps to Pacioli's lane. */
  coverage: number;
  flagged: number;
  byClass: Record<FindingType, ClassScore>;
}

const CLASSES: readonly FindingType[] = FINDING_TYPES;

export function runAdapter<T>(tasks: T[], mapper: Mapper<T>): AdapterReport {
  const acc: Record<string, { tp: number; fp: number; fn: number }> = {};
  for (const c of CLASSES) acc[c] = { tp: 0, fp: 0, fn: 0 };
  let mapped = 0;
  let flagged = 0;

  tasks.forEach((raw, i) => {
    const m = mapper(raw, i);
    if (!m) return; // out of scope — counts against coverage, honestly
    mapped++;
    const found = new Set(diff(m.input).findings.map((f) => f.type));
    if (found.size) flagged++;
    if (m.expect) {
      const exp = new Set(m.expect);
      for (const c of CLASSES) {
        const f = found.has(c);
        const e = exp.has(c);
        if (f && e) acc[c].tp++;
        else if (f && !e) acc[c].fp++;
        else if (!f && e) acc[c].fn++;
      }
    }
  });

  const byClass = {} as Record<FindingType, ClassScore>;
  for (const c of CLASSES) {
    const { tp, fp, fn } = acc[c];
    byClass[c] = { tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null };
  }
  return { total: tasks.length, mapped, coverage: tasks.length ? mapped / tasks.length : 0, flagged, byClass };
}
