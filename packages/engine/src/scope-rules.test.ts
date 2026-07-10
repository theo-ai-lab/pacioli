import { describe, it, expect } from "vitest";
import { unrequestedAddons, violatedSendProhibition, SENT_EVIDENCE } from "./scope-rules";
import type { DiffInput } from "./types";

const base = (over: { constraints?: string[]; scope?: string; items?: string[]; excerpt?: string }): DiffInput => ({
  claim: {
    agent: "a",
    task: "book a flight",
    text: "booked",
    authorized: { mayPurchase: true, scope: over.scope, constraints: over.constraints },
  },
  evidence: {
    source: "pasted",
    merchant: "Air",
    amountUsd: 200,
    date: null,
    items: over.items ?? [],
    recurring: false,
    excerpt: over.excerpt ?? "Confirmation",
  },
});

describe("unrequested add-ons — negation handling", () => {
  it("a NEGATED mention is a prohibition, not a request: 'no trip insurance' still fires", () => {
    const hits = unrequestedAddons(base({ constraints: ["no trip insurance"], items: ["Trip Insurance — $24"] }));
    expect(hits).toEqual(["Trip Insurance — $24"]);
  });

  it("'do not add warranty' still fires on a warranty line item", () => {
    const hits = unrequestedAddons(base({ constraints: ["do not add warranty"], items: ["2-year warranty"] }));
    expect(hits).toEqual(["2-year warranty"]);
  });

  it("an UN-negated mention is a real request and suppresses the finding", () => {
    const hits = unrequestedAddons(base({ constraints: ["please add trip insurance"], items: ["Trip Insurance — $24"] }));
    expect(hits).toEqual([]);
  });

  it("a negation in an UNRELATED earlier clause does not flip a later request", () => {
    // "no checked bags" negates bags, not the separately-requested insurance.
    const hits = unrequestedAddons(
      base({ constraints: ["no checked bags. include trip insurance"], items: ["Trip Insurance — $24"] }),
    );
    expect(hits).toEqual([]);
  });
});

describe("send-prohibition — word-bound guard", () => {
  it("does NOT false-positive on 'consent'/'present' wording", () => {
    const i = base({ scope: "draft only", constraints: ["do not send"], excerpt: "consent form is present in the drafts folder" });
    expect(violatedSendProhibition(i)).toBe(false);
    expect(SENT_EVIDENCE.test("consent present")).toBe(false);
  });

  it("fires when the evidence shows the prohibited send actually happened", () => {
    const i = base({ scope: "draft only", constraints: ["do not send"], excerpt: "Your message was sent to 14 recipients" });
    expect(violatedSendProhibition(i)).toBe(true);
  });

  it("stays silent when a prohibition exists but the evidence is innocuous", () => {
    const i = base({ scope: "draft only", constraints: ["do not send"], excerpt: "Draft saved at 14:02" });
    expect(violatedSendProhibition(i)).toBe(false);
  });
});
