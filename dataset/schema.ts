/**
 * Pacioli ledger contract.
 *
 * The canonical types now live with the engine at `packages/engine/src/types.ts`
 * (published as `@pacioli-app/engine`), so the data and the engine that scores it
 * can never drift. This file is kept as the dataset's stable, self-describing
 * import path (and is referenced by TAXONOMY.md). It re-exports the ledger
 * contract only — deliberately not the whole engine surface.
 */
export {
  FINDING_TYPES,
  TOLERANCE,
  isHeadlineEligible,
  isReal,
  type AgentClaim,
  type Authorization,
  type DiffInput,
  type Dimension,
  type EvidenceSource,
  type Finding,
  type FindingType,
  type GroundTruthSample,
  type MerchantEvidence,
  type Provenance,
  type Severity,
  type Verdict,
} from "@pacioli-app/engine";
