/**
 * Pacioli — Steward tools: a sandboxed commerce surface behind an INJECTABLE HTTP seam.
 *
 * This is the second role for Pacioli. The first role (the rest of the repo) is the AUDITOR — given a
 * claim + evidence it returns a verdict. The Steward is the AGENT ENGINEER's role: an agent that
 * actually COMPLETES a multi-step commerce task (book / buy / subscribe) and uses Pacioli's own
 * `diff()` reconcile as its in-loop conscience (see agent/loop.ts).
 *
 * THE SEAM IS REAL HTTP, NOT A BARE FUNCTION.
 *   Every tool issues a `CommerceRequest` (method + path + body + idempotency key) and gets back a
 *   `CommerceResponse` (status + ok + body). That is the shape of a real payments API call. Two
 *   implementations satisfy the same interface:
 *     • createMockCommerceClient()  — a deterministic, in-memory commerce surface for tests/demos.
 *     • createHttpCommerceClient()  — a genuine `fetch`-over-HTTP client (Bearer auth, idempotency
 *                                     header). A Stripe TEST-mode adapter is the live drop-in — see
 *                                     createStripeTestClient() and the note at the bottom of the file.
 *
 *   Because the boundary is request/response shaped (not `buy(plan)` as a bare call), the live path
 *   is a swap of the client, not a rewrite of the agent — exactly how a real integration reads.
 *
 * PRIVACY: tools return EXTRACTED, redacted `MerchantEvidence` (the same contract the auditor uses) —
 * never a raw merchant body. The reconcile step in the loop consumes that evidence directly.
 */

import type { MerchantEvidence } from "../lib/engine/types";

// ── The HTTP-shaped seam ────────────────────────────────────────────────────────────────────────

export interface CommerceRequest {
  method: "GET" | "POST";
  /** Resource path, e.g. "/v1/plans", "/v1/subscriptions", "/v1/subscriptions/{id}/cancel". */
  path: string;
  query?: Record<string, string | number>;
  body?: unknown;
  /** Carried as an `Idempotency-Key` header on the live client; a retry never double-charges. */
  idempotencyKey?: string;
}

export interface CommerceResponse<T = unknown> {
  /** HTTP-shaped status code (200 / 201 / 4xx / 5xx). */
  status: number;
  ok: boolean;
  body: T;
}

/** The one method every commerce backend implements. Mock and live clients are interchangeable. */
export interface CommerceClient {
  request<T = unknown>(req: CommerceRequest): Promise<CommerceResponse<T>>;
}

// ── Catalog domain types (what the commerce surface sells) ────────────────────────────────────────

export type BillingPeriod = "weekly" | "monthly" | "annual";

export interface Plan {
  id: string;
  name: string;
  priceUsd: number;
  recurring: true;
  period: BillingPeriod;
}

export interface Product {
  id: string;
  name: string;
  priceUsd: number;
}

export interface Offer {
  id: string;
  name: string;
  priceUsd: number;
}

/** The normalized result every tool returns: the privacy-safe evidence to reconcile, plus the raw
 *  body and the created resource id (so the loop can remediate — e.g. cancel an over-budget sub). */
export interface ToolResult {
  ok: boolean;
  status: number;
  /** Extracted, redacted evidence for `diff()` — null on a failed call. */
  evidence: MerchantEvidence | null;
  /** The created resource id, when the action created one (subscription/order/booking). */
  ref?: string;
  /** The raw response body, kept for the step trace. */
  raw: unknown;
  error?: string;
}

// ── Tools (typed wrappers over the seam) ──────────────────────────────────────────────────────────

/** GET the subscription catalog. */
export async function listPlans(client: CommerceClient): Promise<Plan[]> {
  const res = await client.request<{ plans?: Plan[] }>({ method: "GET", path: "/v1/plans" });
  return res.ok && res.body?.plans ? res.body.plans : [];
}

/** GET the product catalog. */
export async function listProducts(client: CommerceClient): Promise<Product[]> {
  const res = await client.request<{ products?: Product[] }>({ method: "GET", path: "/v1/products" });
  return res.ok && res.body?.products ? res.body.products : [];
}

/** GET the bookable offers. */
export async function listOffers(client: CommerceClient): Promise<Offer[]> {
  const res = await client.request<{ offers?: Offer[] }>({ method: "GET", path: "/v1/offers" });
  return res.ok && res.body?.offers ? res.body.offers : [];
}

interface SubBody {
  id: string;
  planId: string;
  name: string;
  amountUsd: number;
  period: BillingPeriod;
  merchant: string;
  items: string[];
  createdAt: number;
  status: "active" | "canceled";
}

/** SUBSCRIBE — start a recurring plan. Returns redacted evidence of the ACTUAL charge (which can
 *  differ from the sticker price if the merchant adds a fee — exactly the gap reconcile exists for). */
export async function subscribe(
  client: CommerceClient,
  args: { planId: string; merchant?: string; idempotencyKey?: string },
): Promise<ToolResult> {
  const res = await client.request<{ subscription?: SubBody; error?: string }>({
    method: "POST",
    path: "/v1/subscriptions",
    body: { planId: args.planId },
    idempotencyKey: args.idempotencyKey,
  });
  if (!res.ok || !res.body?.subscription) {
    return { ok: false, status: res.status, evidence: null, raw: res.body, error: res.body?.error ?? `subscribe failed (${res.status})` };
  }
  const s = res.body.subscription;
  const merchant = args.merchant ?? s.merchant ?? "merchant";
  const evidence: MerchantEvidence = {
    source: "merchant",
    merchant,
    amountUsd: s.amountUsd,
    date: isoDate(s.createdAt),
    items: s.items.length ? s.items : [s.name],
    recurring: true,
    recurringPeriod: s.period,
    excerpt: `Subscription ${s.id} — $${s.amountUsd}/${s.period}`,
  };
  return { ok: true, status: res.status, evidence, ref: s.id, raw: res.body };
}

/** Cancel a subscription — the remediation the loop fires when reconcile finds an over-budget charge. */
export async function cancelSubscription(client: CommerceClient, args: { subscriptionId: string }): Promise<ToolResult> {
  const res = await client.request<{ subscription?: SubBody; error?: string }>({
    method: "POST",
    path: `/v1/subscriptions/${encodeURIComponent(args.subscriptionId)}/cancel`,
  });
  return {
    ok: res.ok,
    status: res.status,
    evidence: null,
    raw: res.body,
    error: res.ok ? undefined : res.body?.error ?? `cancel failed (${res.status})`,
  };
}

interface OrderBody {
  id: string;
  amountUsd: number;
  merchant: string;
  items: string[];
  createdAt: number;
}

/** BUY — a one-off purchase. Returns redacted evidence of the actual order. */
export async function buy(
  client: CommerceClient,
  args: { productId: string; quantity?: number; merchant?: string; idempotencyKey?: string },
): Promise<ToolResult> {
  const res = await client.request<{ order?: OrderBody; error?: string }>({
    method: "POST",
    path: "/v1/orders",
    body: { productId: args.productId, quantity: args.quantity ?? 1 },
    idempotencyKey: args.idempotencyKey,
  });
  if (!res.ok || !res.body?.order) {
    return { ok: false, status: res.status, evidence: null, raw: res.body, error: res.body?.error ?? `buy failed (${res.status})` };
  }
  const o = res.body.order;
  const evidence: MerchantEvidence = {
    source: "merchant",
    merchant: args.merchant ?? o.merchant ?? "merchant",
    amountUsd: o.amountUsd,
    date: isoDate(o.createdAt),
    items: o.items,
    recurring: false,
    excerpt: `Order ${o.id} — $${o.amountUsd}`,
  };
  return { ok: true, status: res.status, evidence, ref: o.id, raw: res.body };
}

interface BookingBody {
  id: string;
  amountUsd: number;
  merchant: string;
  items: string[];
  createdAt: number;
}

/** BOOK — reserve an offer (seat / room / appointment). Returns redacted evidence of the booking. */
export async function book(
  client: CommerceClient,
  args: { offerId: string; merchant?: string; idempotencyKey?: string },
): Promise<ToolResult> {
  const res = await client.request<{ booking?: BookingBody; error?: string }>({
    method: "POST",
    path: "/v1/bookings",
    body: { offerId: args.offerId },
    idempotencyKey: args.idempotencyKey,
  });
  if (!res.ok || !res.body?.booking) {
    return { ok: false, status: res.status, evidence: null, raw: res.body, error: res.body?.error ?? `book failed (${res.status})` };
  }
  const bk = res.body.booking;
  const evidence: MerchantEvidence = {
    source: "merchant",
    merchant: args.merchant ?? bk.merchant ?? "merchant",
    amountUsd: bk.amountUsd,
    date: isoDate(bk.createdAt),
    items: bk.items,
    recurring: false,
    excerpt: `Booking ${bk.id} — $${bk.amountUsd}`,
  };
  return { ok: true, status: res.status, evidence, ref: bk.id, raw: res.body };
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ── The deterministic, in-memory mock commerce surface ────────────────────────────────────────────

const DEFAULT_PLANS: Plan[] = [
  { id: "plan_basic", name: "Basic", priceUsd: 8, recurring: true, period: "monthly" },
  { id: "plan_standard", name: "Standard", priceUsd: 15, recurring: true, period: "monthly" },
  { id: "plan_premium", name: "Premium", priceUsd: 30, recurring: true, period: "monthly" },
];

const DEFAULT_PRODUCTS: Product[] = [
  { id: "prod_cable", name: "USB-C cable", priceUsd: 12 },
  { id: "prod_dock", name: "Laptop dock", priceUsd: 89 },
];

const DEFAULT_OFFERS: Offer[] = [
  { id: "offer_econ", name: "Economy seat", priceUsd: 120 },
  { id: "offer_flex", name: "Flexible seat", priceUsd: 180 },
];

export interface MockOptions {
  plans?: Plan[];
  products?: Product[];
  offers?: Offer[];
  merchant?: string;
  /** A hidden fee added to EVERY charge — models merchant-side drip pricing the agent can't predict
   *  from the sticker price. Reconcile catches the resulting overspend; defaults to 0 (honest). */
  surchargeUsd?: number;
  /** Fixed clock for deterministic timestamps. */
  now?: number;
}

export interface MockSnapshot {
  subscriptions: SubBody[];
  orders: OrderBody[];
  bookings: BookingBody[];
  /** Total dollars actually charged across all ACTIVE (non-canceled) records. */
  netChargedUsd: number;
}

/** A mock that ALSO exposes a `snapshot()` for tests (assert remediation + no double-charge). It still
 *  satisfies `CommerceClient`, so it is a true drop-in wherever a `CommerceClient` is expected. */
export type MockCommerceClient = CommerceClient & { snapshot(): MockSnapshot };

export function createMockCommerceClient(opts: MockOptions = {}): MockCommerceClient {
  const plans = opts.plans ?? DEFAULT_PLANS;
  const products = opts.products ?? DEFAULT_PRODUCTS;
  const offers = opts.offers ?? DEFAULT_OFFERS;
  const merchant = opts.merchant ?? "Acme Cloud";
  const surcharge = opts.surchargeUsd ?? 0;
  const now = opts.now ?? Date.UTC(2026, 5, 14);

  const subs = new Map<string, SubBody>();
  const orders = new Map<string, OrderBody>();
  const bookings = new Map<string, BookingBody>();
  const idempotency = new Map<string, { kind: "sub" | "order" | "booking"; id: string }>();
  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}_${(++seq).toString().padStart(4, "0")}`;
  const round2 = (n: number): number => Math.round(n * 100) / 100;

  function json<T>(status: number, body: T): CommerceResponse<T> {
    return { status, ok: status >= 200 && status < 300, body };
  }

  const subCancelRe = /^\/v1\/subscriptions\/([^/]+)\/cancel$/;

  async function request<T>(req: CommerceRequest): Promise<CommerceResponse<T>> {
    const key = `${req.method} ${req.path}`;

    if (key === "GET /v1/plans") return json(200, { plans }) as CommerceResponse<T>;
    if (key === "GET /v1/products") return json(200, { products }) as CommerceResponse<T>;
    if (key === "GET /v1/offers") return json(200, { offers }) as CommerceResponse<T>;

    // Idempotent create: an identical key returns the SAME resource, no second charge.
    const replay = req.idempotencyKey ? idempotency.get(req.idempotencyKey) : undefined;

    if (key === "POST /v1/subscriptions") {
      if (replay?.kind === "sub") return json(200, { subscription: subs.get(replay.id) }) as CommerceResponse<T>;
      const planId = (req.body as { planId?: string } | undefined)?.planId;
      const plan = plans.find((p) => p.id === planId);
      if (!plan) return json(404, { error: `no such plan: ${planId ?? "(none)"}` }) as CommerceResponse<T>;
      const id = nextId("sub");
      const sub: SubBody = {
        id,
        planId: plan.id,
        name: plan.name,
        amountUsd: round2(plan.priceUsd + surcharge),
        period: plan.period,
        merchant,
        items: [plan.name],
        createdAt: now,
        status: "active",
      };
      subs.set(id, sub);
      if (req.idempotencyKey) idempotency.set(req.idempotencyKey, { kind: "sub", id });
      return json(200, { subscription: sub }) as CommerceResponse<T>;
    }

    const cancelMatch = req.method === "POST" ? subCancelRe.exec(req.path) : null;
    if (cancelMatch) {
      const sub = subs.get(decodeURIComponent(cancelMatch[1]));
      if (!sub) return json(404, { error: "no such subscription" }) as CommerceResponse<T>;
      sub.status = "canceled";
      return json(200, { subscription: sub }) as CommerceResponse<T>;
    }

    if (key === "POST /v1/orders") {
      if (replay?.kind === "order") return json(200, { order: orders.get(replay.id) }) as CommerceResponse<T>;
      const b = req.body as { productId?: string; quantity?: number } | undefined;
      const product = products.find((p) => p.id === b?.productId);
      if (!product) return json(404, { error: `no such product: ${b?.productId ?? "(none)"}` }) as CommerceResponse<T>;
      const qty = Math.max(1, Math.floor(b?.quantity ?? 1));
      const id = nextId("order");
      const order: OrderBody = {
        id,
        amountUsd: round2(product.priceUsd * qty + surcharge),
        merchant,
        items: qty > 1 ? [`${product.name} ×${qty}`] : [product.name],
        createdAt: now,
      };
      orders.set(id, order);
      if (req.idempotencyKey) idempotency.set(req.idempotencyKey, { kind: "order", id });
      return json(200, { order }) as CommerceResponse<T>;
    }

    if (key === "POST /v1/bookings") {
      if (replay?.kind === "booking") return json(200, { booking: bookings.get(replay.id) }) as CommerceResponse<T>;
      const offerId = (req.body as { offerId?: string } | undefined)?.offerId;
      const offer = offers.find((o) => o.id === offerId);
      if (!offer) return json(404, { error: `no such offer: ${offerId ?? "(none)"}` }) as CommerceResponse<T>;
      const id = nextId("bk");
      const booking: BookingBody = {
        id,
        amountUsd: round2(offer.priceUsd + surcharge),
        merchant,
        items: [offer.name],
        createdAt: now,
      };
      bookings.set(id, booking);
      if (req.idempotencyKey) idempotency.set(req.idempotencyKey, { kind: "booking", id });
      return json(200, { booking }) as CommerceResponse<T>;
    }

    return json(404, { error: `unknown route: ${key}` }) as CommerceResponse<T>;
  }

  return {
    request,
    snapshot(): MockSnapshot {
      const subscriptions = [...subs.values()];
      const orderList = [...orders.values()];
      const bookingList = [...bookings.values()];
      const netChargedUsd = round2(
        subscriptions.filter((s) => s.status === "active").reduce((n, s) => n + s.amountUsd, 0) +
          orderList.reduce((n, o) => n + o.amountUsd, 0) +
          bookingList.reduce((n, b) => n + b.amountUsd, 0),
      );
      return { subscriptions, orders: orderList, bookings: bookingList, netChargedUsd };
    },
  };
}

// ── The live drop-in: a real fetch-over-HTTP client ──────────────────────────────────────────────

/**
 * A genuine HTTP client implementing the same seam: Bearer auth, JSON bodies, an `Idempotency-Key`
 * header. Point it at any commerce service that speaks these routes. This is what makes the boundary
 * read as a real integration rather than a function call — the agent code is identical; only the
 * client changes.
 */
export function createHttpCommerceClient(opts: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): CommerceClient {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async request<T>(req: CommerceRequest): Promise<CommerceResponse<T>> {
      const url = new URL(req.path.replace(/^\//, ""), opts.baseUrl.endsWith("/") ? opts.baseUrl : opts.baseUrl + "/");
      if (req.query) for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, String(v));
      const headers: Record<string, string> = {
        authorization: `Bearer ${opts.apiKey}`,
        "content-type": "application/json",
      };
      if (req.idempotencyKey) headers["idempotency-key"] = req.idempotencyKey;
      const res = await doFetch(url.toString(), {
        method: req.method,
        headers,
        body: req.method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, ok: res.ok, body: body as T };
    },
  };
}

/**
 * LIVE PATH — Stripe TEST mode is the drop-in.
 *
 * Stripe's API speaks the same request/response *shape* this seam models (it even has /v1/subscriptions
 * and a real `Idempotency-Key` header). A production Steward swaps the mock for an adapter that maps
 * these neutral routes onto Stripe's TEST-mode endpoints, authenticated with STRIPE_TEST_KEY
 * (`sk_test_…`). The agent loop does not change.
 *
 * This factory wires that up against your own commerce service (the thing that talks to Stripe with
 * the secret key server-side); set STEWARD_COMMERCE_URL to its base. It THROWS without a test key so
 * a live run can never silently fall back to no-auth. Real network + real (test) money is the boundary
 * the mock cannot fake — and a real END USER consenting to the charge is the un-fakeable gap beyond it.
 */
export function createStripeTestClient(opts?: { baseUrl?: string; apiKey?: string }): CommerceClient {
  const apiKey = opts?.apiKey ?? process.env.STRIPE_TEST_KEY;
  if (!apiKey) throw new Error("STRIPE_TEST_KEY not set — the live Steward commerce client is disabled (use createMockCommerceClient for tests/demos).");
  if (!apiKey.startsWith("sk_test_")) throw new Error("refusing to run: STRIPE_TEST_KEY must be a TEST-mode key (sk_test_…), never a live key.");
  const baseUrl = opts?.baseUrl ?? process.env.STEWARD_COMMERCE_URL;
  if (!baseUrl) throw new Error("STEWARD_COMMERCE_URL not set — point it at the commerce service that fronts Stripe TEST mode.");
  return createHttpCommerceClient({ baseUrl, apiKey });
}
