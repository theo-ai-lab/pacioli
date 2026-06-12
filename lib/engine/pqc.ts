/**
 * Pacioli — post-quantum signature over the Merkle audit-trail root (ML-DSA-65 / FIPS 204).
 *
 * The receipt trail is SHA-256 + a Merkle root (merkle.ts) — classical integrity. This adds an OPTIONAL
 * post-quantum SIGNATURE over that root, so the audit trail stays verifiable against a future quantum
 * adversary. ML-DSA is provided by `@noble/post-quantum`, a small audited pure-JS library.
 *
 * Activation: `npm install @noble/post-quantum`. It's an OPTIONAL, dynamically-imported dependency —
 * until it's installed, `pqcAvailable()` returns false and these functions throw a clear message, so
 * nothing else in the app (which never imports this) is affected and the test suite stays green.
 */

interface MlDsaKeys {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}
interface MlDsa {
  keygen(seed?: Uint8Array): MlDsaKeys;
  sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array;
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;
}

// Typed `string` (not a literal) on purpose: the static typechecker then treats this as a runtime
// dynamic import and does NOT require the optional dependency to be installed to typecheck.
const MLDSA_PKG: string = "@noble/post-quantum/ml-dsa";

async function loadMlDsa(): Promise<MlDsa | null> {
  try {
    const mod = (await import(MLDSA_PKG)) as { ml_dsa65: MlDsa };
    return mod.ml_dsa65;
  } catch {
    return null;
  }
}

const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function hexToBytes(h: string): Uint8Array {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return a;
}

const NOT_INSTALLED =
  "@noble/post-quantum not installed — run `npm install @noble/post-quantum` to activate PQC signing.";

export async function pqcAvailable(): Promise<boolean> {
  return (await loadMlDsa()) !== null;
}

export interface PqcSignature {
  algorithm: "ML-DSA-65";
  publicKeyHex: string;
  signatureHex: string;
}

/** Sign a Merkle-root hex with ML-DSA-65. Deterministic given a 32-byte seed (omit for random keys). */
export async function signMerkleRoot(
  rootHex: string,
  seed?: Uint8Array,
): Promise<PqcSignature & { secretKeyHex: string }> {
  const mldsa = await loadMlDsa();
  if (!mldsa) throw new Error(NOT_INSTALLED);
  const keys = mldsa.keygen(seed);
  const sig = mldsa.sign(keys.secretKey, hexToBytes(rootHex));
  return {
    algorithm: "ML-DSA-65",
    publicKeyHex: bytesToHex(keys.publicKey),
    signatureHex: bytesToHex(sig),
    secretKeyHex: bytesToHex(keys.secretKey),
  };
}

/** Verify an ML-DSA-65 signature over a Merkle-root hex. */
export async function verifyMerkleRoot(rootHex: string, signatureHex: string, publicKeyHex: string): Promise<boolean> {
  const mldsa = await loadMlDsa();
  if (!mldsa) throw new Error(NOT_INSTALLED);
  return mldsa.verify(hexToBytes(publicKeyHex), hexToBytes(rootHex), hexToBytes(signatureHex));
}
