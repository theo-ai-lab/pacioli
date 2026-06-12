import { ImageResponse } from "next/og";

export const alt = "Pacioli — Did your AI actually do what it said?";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// On-brand share card. Uses the default font (no fetch) so the build never depends on a font CDN.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "60px 72px",
          background: "#1A1714",
          color: "#ECE5D6",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 19,
            letterSpacing: 7,
            textTransform: "uppercase",
            color: "#A89E8A",
          }}
        >
          <div style={{ display: "flex" }}>Double-entry bookkeeping for AI agents</div>
          <div style={{ display: "flex" }}>Est. MMXXVI</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 30 }}>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 80, fontWeight: 700, lineHeight: 1.06, letterSpacing: -1.5 }}>
            <div style={{ display: "flex" }}>Did your AI actually</div>
            <div style={{ display: "flex" }}>do what it said?</div>
          </div>
          <div style={{ display: "flex", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", border: "2px solid #1E5E3A", color: "#4FAE74", padding: "9px 22px", borderRadius: 6, fontSize: 22, letterSpacing: 3 }}>
              BALANCES
            </div>
            <div style={{ display: "flex", alignItems: "center", border: "2px solid #8A2D2D", color: "#C7574B", padding: "9px 22px", borderRadius: 6, fontSize: 22, letterSpacing: 3 }}>
              OUT OF BALANCE
            </div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ display: "flex", fontSize: 46, fontWeight: 700, letterSpacing: 1 }}>Pacioli</div>
          <div style={{ display: "flex", fontSize: 21, color: "#A89E8A", maxWidth: 520, textAlign: "right" }}>
            Spend trackers show what was charged. Pacioli proves whether your agent told the truth.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
