/**
 * Pacioli — GET /api/metrics. Prometheus-format metrics from the receipt store.
 *
 * Zero dependency: plain-text exposition (no prom-client). Honors PACIOLI_API_KEY when configured —
 * an operator who sets a key reasonably expects it to cover the WHOLE API surface, and reconciliation
 * volume / backend durability are operational intel. Without a key the endpoint is public (demo mode).
 */
import { getStore } from "@/lib/store/receipt-store";
import { apiKeyMatches } from "@/lib/api/auth";

export async function GET(req: Request): Promise<Response> {
  const required = process.env.PACIOLI_API_KEY;
  if (required && !apiKeyMatches(req.headers.get("x-api-key"), required)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const store = await getStore();
  const s = store.stats();
  const lines = [
    "# HELP pacioli_store_info Storage backend in use (memory = non-durable fallback).",
    "# TYPE pacioli_store_info gauge",
    `pacioli_store_info{backend="${store.backend}"} 1`,
    "# HELP pacioli_reconciliations_total Total reconciliation events recorded (replays of the same content-addressed receipt each count; non-durable and evictable under the memory backend).",
    "# TYPE pacioli_reconciliations_total counter",
    `pacioli_reconciliations_total ${s.events}`,
    "# HELP pacioli_receipts_unique Unique content-addressed receipts currently stored.",
    "# TYPE pacioli_receipts_unique gauge",
    `pacioli_receipts_unique ${s.total}`,
    "# HELP pacioli_receipts_flagged Unique stored receipts whose deterministic verdict was out of balance.",
    "# TYPE pacioli_receipts_flagged gauge",
    `pacioli_receipts_flagged ${s.flagged}`,
    "# HELP pacioli_findings_by_type Findings by type across stored receipts (deterministic + stored judge findings).",
    "# TYPE pacioli_findings_by_type gauge",
    ...Object.entries(s.byType).map(([t, n]) => `pacioli_findings_by_type{type="${t}"} ${n}`),
  ];
  return new Response(lines.join("\n") + "\n", {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
