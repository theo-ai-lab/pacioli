/**
 * Pacioli — a SELECTIVE-RISK CERTIFICATE on the residual judge (distribution-free, conformal route).
 *
 * The residual judge does not have to answer every claim. A SELECTIVE predictor ABSTAINS on the claims it is
 * unsure of and commits a verdict only on an ACCEPTED region; its SELECTIVE RISK is its error rate ON THAT
 * accepted region. The question a deployer actually has is: "on the claims my judge does NOT abstain on, how
 * wrong can it be on claims I have never seen?" This module answers it with a CERTIFICATE — a distribution-
 * free upper confidence bound on the selective risk that holds for unseen, exchangeable claims.
 *
 * ── WHY (the citation) ──────────────────────────────────────────────────────────────────────────────────
 * Selective-risk certification for LLM outputs is the framing of Akter, Shihab & Sharma, "Selective Risk
 * Certification for LLM Outputs via Information-Lift Statistics: PAC-Bayes, Robustness, and Skeleton Design"
 * (arXiv:2509.12527, 2025). Their route is a sub-gamma PAC-Bayes information-lift bound. We deliberately take
 * the OTHER, distribution-free route — an exact binomial (Clopper–Pearson) upper bound on the error rate over
 * the accepted region — because at our gold-set size (N in the tens) a PAC-Bayes constant printed as a
 * headline number would be vacuous. The theory is the WHY (the accepted region carries a certifiable risk);
 * the number we print is the honest exact-binomial bound.
 *
 * ── WHAT IS / ISN'T CLAIMED (the honesty bar) ──────────────────────────────────────────────────────────
 *   - Distribution-free, CONDITIONAL on exchangeability of the calibration and future claims. It assumes no
 *     parametric error model — but it is NOT unconditional, and it is NOT tight at small N.
 *   - At N in the tens the certified bound is WIDE: with 0 observed errors in ~25 accepted claims the 95%
 *     upper bound on selective risk is still ≈ 11%, and with smaller accepted regions it is far looser. We
 *     print the bound AND its width and say plainly it is not a tight number — never a vacuous headline.
 *   - CONVERGENCE is the deliverable: the certificate WIDTH shrinks as O(1/√N) as the gold set grows. We
 *     display width-vs-N so the methodology — not any single small-N number — is the result.
 *   - A two-sided Wilson interval (judge-eval.ts) answers a DIFFERENT question (a CI around the point); this
 *     is a one-sided distribution-free UPPER bound with a coverage guarantee, the right tool for a guarantee.
 *
 * Pure; exact binomial arithmetic in double precision (no special functions, no dependencies).
 */

// ── the inputs: labeled, selectively-accepted predictions ─────────────────────────────────────────────────

/** One calibration item: the (selective) predictor's verdict, the gold label, and whether it was ACCEPTED
 *  (committed) versus ABSTAINED. Selective risk is measured over the accepted items only. */
export interface SelectiveItem {
  /** The predictor's CLAIM_MISMATCH verdict on this claim (only meaningful when `accepted`). */
  predicted: boolean;
  gold: boolean;
  /** True iff the selective predictor committed a verdict here (did not abstain). */
  accepted: boolean;
}

// ── exact binomial machinery ──────────────────────────────────────────────────────────────────────────────

/** P(X ≤ e) for X ~ Binomial(n, p), via a stable iterative pmf (no factorials, no overflow). */
export function binomialCdfAtMost(e: number, n: number, p: number): number {
  if (e < 0) return 0;
  if (e >= n) return 1;
  if (p <= 0) return 1; // X = 0 ≤ e almost surely
  if (p >= 1) return e >= n ? 1 : 0; // X = n
  let pmf = Math.pow(1 - p, n); // pmf(0)
  const odds = p / (1 - p);
  let cdf = 0;
  for (let k = 0; k <= n; k++) {
    if (k <= e) cdf += pmf;
    else break;
    pmf *= ((n - k) / (k + 1)) * odds; // pmf(k+1)
  }
  return Math.min(1, Math.max(0, cdf));
}

/**
 * The one-sided Clopper–Pearson (exact binomial) UPPER confidence limit at level (1−delta) for the success
 * (error) probability, given `errors` errors in `n` trials. p_U solves P(Binom(n,p_U) ≤ errors) = delta;
 * the tail is monotone decreasing in p, so we bisect. Distribution-free for a binomial proportion and the
 * correct tool at small n (e.g. errors=0 ⇒ the exact closed form 1 − delta^(1/n)).
 */
export function clopperPearsonUpper(errors: number, n: number, delta = 0.05): number {
  if (n <= 0) return 1; // no calibration evidence → no certificate (admit the worst case)
  if (errors >= n) return 1;
  // bisection on [errors/n, 1]: f(p) = P(X ≤ errors) is 1 at p=0 and 0 at p=1, decreasing.
  let lo = errors / n;
  let hi = 1;
  for (let it = 0; it < 100; it++) {
    const mid = (lo + hi) / 2;
    if (binomialCdfAtMost(errors, n, mid) > delta) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Hoeffding one-sided upper bound on a bounded-[0,1] mean: r̂ + √(ln(1/delta)/(2n)). Distribution-free,
 *  variance-agnostic — reported as a CROSS-CHECK against the exact binomial bound. */
export function hoeffdingUpper(rhat: number, n: number, delta = 0.05): number {
  if (n <= 0) return 1;
  return Math.min(1, rhat + Math.sqrt(Math.log(1 / delta) / (2 * n)));
}

// ── the certificate ───────────────────────────────────────────────────────────────────────────────────────

export interface SelectiveRiskCertificate {
  delta: number;
  nTotal: number;
  nAccepted: number;
  /** Selective COVERAGE: fraction of claims the predictor committed a verdict on (did not abstain). */
  coverage: number;
  errors: number;
  /** Empirical selective risk: errors / nAccepted (the point estimate, NOT the guarantee). */
  empiricalRisk: number;
  /** The distribution-free (1−delta) upper bound on selective risk for unseen exchangeable claims. */
  upperBound: number;
  /** Hoeffding upper bound (a cross-check; usually looser than the exact binomial at small n). */
  hoeffdingUpper: number;
  /** upperBound − empiricalRisk: the certificate WIDTH (how far the honest bound sits above what we saw). */
  width: number;
  method: "clopper-pearson-exact-binomial";
}

/**
 * Certify the selective risk of a (selective) predictor from labeled, accept-flagged calibration items.
 * Restricts to the accepted region, counts errors against gold, and returns the exact-binomial (1−delta)
 * upper bound plus its width. An empty accepted region yields the trivial certificate (upperBound = 1).
 */
export function certifySelectiveRisk(items: readonly SelectiveItem[], delta = 0.05): SelectiveRiskCertificate {
  const accepted = items.filter((i) => i.accepted);
  const nAccepted = accepted.length;
  const errors = accepted.filter((i) => i.predicted !== i.gold).length;
  const empiricalRisk = nAccepted === 0 ? 0 : errors / nAccepted;
  const upperBound = clopperPearsonUpper(errors, nAccepted, delta);
  return {
    delta,
    nTotal: items.length,
    nAccepted,
    coverage: items.length === 0 ? 0 : nAccepted / items.length,
    errors,
    empiricalRisk,
    upperBound,
    hoeffdingUpper: hoeffdingUpper(empiricalRisk, nAccepted, delta),
    width: upperBound - empiricalRisk,
    method: "clopper-pearson-exact-binomial",
  };
}

// ── convergence: the certificate WIDTH shrinks as the gold set grows ──────────────────────────────────────

export interface WidthPoint {
  n: number;
  /** Errors held at the same empirical risk for this N (round(rhat·n)) so only N moves. */
  errors: number;
  upperBound: number;
  /** upperBound − rhat: the half-life of the guarantee as N grows (≈ O(1/√N)). */
  width: number;
}

/**
 * The width-vs-N convergence curve: holding the empirical selective risk `rhat` FIXED, recompute the exact
 * (1−delta) upper bound across a grid of gold-set sizes N. This is a METHODOLOGY display — "if you keep
 * observing this error rate, here is how the certified bound tightens with more gold" — never a claim that
 * we already HAVE that much gold. Width shrinks at the binomial O(1/√N) rate.
 */
export function widthVsN(rhat: number, ns: readonly number[] = [10, 25, 50, 100, 250, 500, 1000, 5000], delta = 0.05): WidthPoint[] {
  return [...ns]
    .sort((a, b) => a - b)
    .map((n) => {
      const errors = Math.round(rhat * n);
      const upperBound = clopperPearsonUpper(errors, n, delta);
      return { n, errors, upperBound, width: upperBound - errors / n };
    });
}
