# Pacioli — Design System

> One physical referent governs every choice: the **paper ledger + thermal receipt + rubber stamp.**
> If a real ledger wouldn't do it, neither do we. That single rule is the defense against generic template UI.

Pacioli reconciles what an AI agent *claimed* it did against what the evidence shows. The interface
makes that reconciliation legible the way double-entry bookkeeping always has: two columns, entered
twice, and a verdict when they don't reconcile. The aesthetic is **editorial-ledger meets thermal
receipt** — a dark desk, warm bone paper, a serif display voice, tabular mono numerals, and exactly
two semantic colors.

---

## 1. Color

Never pure `#000` or `#fff` — both bloom (halation) on the opposite surface and read cheap. Every pair
below is chosen to sit in the comfortable ~10–15:1 band: well past WCAG AA, short of harsh. Status
colors are verified ≥ AA as text on paper and clear the 3:1 non-text bar (WCAG 2.2 SC 1.4.11).

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `desk` | `#1A1714` | dark ledger surface (the desk) | — |
| `desk-2` | `#211C18` | desk gradient stop | — |
| `cream` | `#ECE5D6` | text on desk | ~13:1 on desk |
| `cream-dim` | `#A89E8A` | muted labels on desk | ~6.5:1 on desk |
| `paper` | `#F4EFE3` | bone ledger stock (the receipt) | — |
| `paper-2` | `#ECE4D3` | paper gradient stop | — |
| `paper-edge` | `#DDD2BA` | perforation / paper edge | — |
| `ink` | `#2A2622` | body ink | ~12:1 on paper |
| `ink-2` | `#5C5346` | secondary / faded ledger ink | ~5.6:1 on paper |
| `ink-3` | `#8A7E6B` | fine print / hairline rules | ~3.1:1 (non-text floor) |
| `ledger-green` | `#1E5E3A` | **balances** — claimed = actual | ~5.5:1 on paper |
| `oxblood` | `#8A2D2D` | **out of balance** — needs your eyes | ~6.8:1 on paper |

**Two colors, and they never carry meaning alone** (WCAG SC 1.4.1). Green/red is always paired with a
word (`BALANCES` / `OUT OF BALANCE`), a glyph (`✓` / `≠`), and column position — so the ~8% of users
with red-green color vision deficiency still read the verdict. The verdict survives in grayscale.

## 2. Type

A real pairing with a point of view — the opposite of a default `Inter` + indigo gradient.

- **Display & verdict — Spectral** (an oldstyle editorial serif, Plantin-adjacent). Wordmark, headings,
  the receipt title, the stamp. Authority through restraint; it whispers, it doesn't shout.
- **Numerals, IDs, the ledger grid — IBM Plex Mono.** *Tabular figures* so the Claimed | Actual columns
  align to the digit. Mono is reserved **only** for numbers, codes, and the receipt body — never for prose
  (the Linear discipline).

## 3. Layout

The **double-entry grid is the layout primitive — not a stack of rounded cards.** Structure comes from
hairline ledger rules, *sharp* corners (receipts and ledgers aren't rounded), perforated edges, and an
asymmetric `Claimed | spine | Actual` three-column grid. Hierarchy is deliberate: the verdict row is
heavier than data rows; the stamp deliberately breaks the grid. Depth is paper texture and bone-on-desk
layering — never a uniform drop-shadow on every element.

## 4. Motion — exactly two signature interactions, then stop

All motion is transform/opacity only, 200–500ms, ease-out. No spring, no bounce, no confetti
(bounce easing is the most common template tell). A thermal printer is mechanical and deliberate.

1. **Receipt print** — the result feeds in top-down like thermal paper: a clip/height reveal,
   ~350–500ms ease-out, rows staggering at ~30–40ms (total capped ~600ms), a single darker scanline and
   a sub-pixel jitter that snaps crisp on settle. Numerals settle into tabular alignment; they never bounce.
2. **Stamp press** — the verdict lands once: scale `1.15 → 1.0` over ~180–250ms ease-out at a *fixed* −5°
   rotation, with rough ink edges. It fires only on the actual verdict — never on hover or idle.

**`prefers-reduced-motion`** is a first-class path: the receipt and stamp render instantly at their final
state (no print-feed, no scan, no scale), and the verdict is always mirrored to `aria-live`/`role="status"`
so it reaches screen readers and reduced-motion users as text the instant it computes. Decorative motion
is removed; **information never is**.

## 5. The generic-UI audit — a per-screen checklist

The three tells that make a UI read templated, and our structural defenses:

1. **Default type + safe gradient/grays** → real serif+mono pairing, **zero gradients**, two functional
   colors derived from a physical referent.
2. **"Everything is a card"** (one radius, one padding, one shadow, centered hero) → the ledger *grid*,
   sharp corners, hairline rules, perforation, asymmetric columns, deliberate hierarchy.
3. **Voiceless copy + icon soup + canned fades** → domain idiom ("Claimed vs Actual", "OUT OF BALANCE"),
   the metaphor itself as iconography (stamps, perforations, rules), and the two earned motions above.

*Design references that hold this bar: the Plaid banknote rebrand, Robinhood (Porto Rocha) serif+mono
restraint, Klim's Martina Plantijn, Linear's "whisper, don't shout", and the WCAG 2.2 / inclusive
dark-mode guidance behind the contrast choices.*
