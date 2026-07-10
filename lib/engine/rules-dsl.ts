/**
 * Pacioli — a tiny declarative rule DSL (rules as data).
 *
 * The deterministic numeric/flag detectors expressed as DATA — a small condition AST — interpreted
 * independently of the engine. Today this layer is a DRIFT-DETECTING VERIFICATION MIRROR of diff.ts,
 * not a consumed extension point: nothing in the product reads DECL_RULES, and appending a rule here
 * changes no behavior (it would make the cross-check FAIL until diff.ts agrees). The cross-check test
 * (rules-dsl.test.ts) asserts this interpreter agrees with the canonical engine on every corpus row
 * AND across thousands of fuzzed inputs. If data-driven policies ever become a product surface, this
 * is the seam to build on.
 *
 * Scope: the exact numeric/flag rules (OVERSPEND, UNAUTH_RECURRENCE). The fuzzy heuristics
 * (add-on/prohibition keyword matching) and CLAIM_MISMATCH abstention stay in the engine on purpose —
 * a keyword list is not a numeric predicate, and abstention is the point of deterministic-first.
 */
import { TOLERANCE, type DiffInput, type FindingType } from "@pacioli-app/engine";

type Field = "amount" | "budget";
type Expr = number | { ref: Field } | { mul: [Expr, Expr] } | { sub: [Expr, Expr] };
type Cond =
  | { isNumber: Field }
  | { gtLit: [Field, number] }
  | { gt: [Expr, Expr] }
  | { gte: [Expr, Expr] }
  | { recurring: true }
  | { mayRecurNotTrue: true }
  | { all: Cond[] };

export interface DeclRule {
  id: FindingType;
  when: Cond;
}

const CEILING = 1 + TOLERANCE.budgetFraction;

/** The numeric/flag rules, as data. Adding such a policy = appending a DeclRule here. */
export const DECL_RULES: DeclRule[] = [
  {
    id: "OVERSPEND",
    when: {
      all: [
        { isNumber: "budget" },
        { gtLit: ["budget", 0] },
        { isNumber: "amount" },
        { gt: [{ ref: "amount" }, { mul: [{ ref: "budget" }, CEILING] }] },
        { gte: [{ sub: [{ ref: "amount" }, { ref: "budget" }] }, TOLERANCE.budgetFloorUsd] },
      ],
    },
  },
  {
    id: "UNAUTH_RECURRENCE",
    when: { all: [{ recurring: true }, { mayRecurNotTrue: true }] },
  },
];

function field(i: DiffInput, f: Field): number | null {
  const v = f === "amount" ? i.evidence.amountUsd : i.claim.authorized?.budgetUsd;
  return typeof v === "number" ? v : null;
}

function evalExpr(i: DiffInput, e: Expr): number | null {
  if (typeof e === "number") return e;
  if ("ref" in e) return field(i, e.ref);
  if ("mul" in e) {
    const a = evalExpr(i, e.mul[0]);
    const b = evalExpr(i, e.mul[1]);
    return a === null || b === null ? null : a * b;
  }
  const a = evalExpr(i, e.sub[0]);
  const b = evalExpr(i, e.sub[1]);
  return a === null || b === null ? null : a - b;
}

function evalCond(i: DiffInput, c: Cond): boolean {
  if ("isNumber" in c) return field(i, c.isNumber) !== null;
  if ("gtLit" in c) {
    const v = field(i, c.gtLit[0]);
    return v !== null && v > c.gtLit[1];
  }
  if ("gt" in c) {
    const a = evalExpr(i, c.gt[0]);
    const b = evalExpr(i, c.gt[1]);
    return a !== null && b !== null && a > b;
  }
  if ("gte" in c) {
    const a = evalExpr(i, c.gte[0]);
    const b = evalExpr(i, c.gte[1]);
    return a !== null && b !== null && a >= b;
  }
  if ("recurring" in c) return i.evidence.recurring === true;
  if ("mayRecurNotTrue" in c) return i.claim.authorized?.mayRecur !== true;
  return c.all.every((x) => evalCond(i, x));
}

/** Which declarative rules fire for this input. */
export function applyRules(i: DiffInput, rules: DeclRule[] = DECL_RULES): FindingType[] {
  return rules.filter((r) => evalCond(i, r.when)).map((r) => r.id);
}
