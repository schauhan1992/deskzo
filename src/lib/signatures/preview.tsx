import { ImageResponse } from "next/og";
import type { ReactNode } from "react";
import { cleanData, DEFAULT_ACCENT, SOCIALS, type SignatureData, type SignatureLayout } from "@/lib/signatures/render";

/**
 * A premium template drawn as a watermarked picture, for the public generator (owner, 10 Oct 2026:
 * "view for reference, using needs a paid plan"). The visitor sees their own name and details in the
 * layout, under a "Premium" watermark, as a PNG — no HTML to copy.
 *
 * Images are placeholders — initials for a photo, a box for a logo, a pattern for a QR code — never
 * the URLs typed into the form: the server fetches nothing a visitor names.
 */

export const PREVIEW_WIDTH = 640;
export const PREVIEW_HEIGHT = 300;

const TEXT = "#333333";
const MUTED = "#6b7280";

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  );
}

function Photo({ layout, d, size, accent }: { layout: SignatureLayout; d: SignatureData; size: number; accent: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: layout.photo === "round" ? size / 2 : 6,
        background: accent,
        color: "#ffffff",
        fontSize: size / 2.6,
        fontWeight: 700,
      }}
    >
      {initials(d.name)}
    </div>
  );
}

function Logo({ d, width, light }: { d: SignatureData; width: number; light?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width,
        height: width / 2.4,
        border: `2px dashed ${light ? "rgba(255,255,255,0.7)" : "#cbd5e1"}`,
        borderRadius: 6,
        color: light ? "#ffffff" : MUTED,
        fontSize: 12,
        textAlign: "center",
      }}
    >
      {(d.company || "Logo").slice(0, 20)}
    </div>
  );
}

function Details({ layout, d, accent, center }: { layout: SignatureLayout; d: SignatureData; accent: string; center?: boolean }) {
  const role = [d.title, d.department, d.company].filter(Boolean).join(" · ");
  const contacts: [string, string][] = [];
  if (d.phone) contacts.push(["P", d.phone]);
  if (d.mobile) contacts.push(["M", d.mobile]);
  if (d.email) contacts.push(["E", d.email]);
  if (d.website) contacts.push(["W", d.website.replace(/^https?:\/\//i, "")]);
  if (d.address) contacts.push(["A", d.address]);
  const socials = SOCIALS.filter((s) => d.socials?.[s.key]);
  const align = center ? "center" : "flex-start";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: align }}>
      <div
        style={{
          display: "flex",
          fontSize: layout.nameStyle === "caps" ? 18 : 20,
          fontWeight: 700,
          letterSpacing: layout.nameStyle === "caps" ? 1.5 : 0,
          color: layout.nameStyle === "accent" ? accent : TEXT,
        }}
      >
        {layout.nameStyle === "caps" ? d.name.toUpperCase() : d.name}
      </div>
      {role && <div style={{ display: "flex", fontSize: 14, color: MUTED, marginTop: 2 }}>{role}</div>}
      <div style={{ display: "flex", flexDirection: "column", alignItems: align, marginTop: 8 }}>
        {contacts.slice(0, 4).map(([label, value]) => (
          <div key={label} style={{ display: "flex", fontSize: 13, color: TEXT, marginTop: 1 }}>
            {layout.contacts === "labelled" && <span style={{ color: accent, fontWeight: 700, marginRight: 6 }}>{label}</span>}
            <span>{value.slice(0, 48)}</span>
          </div>
        ))}
      </div>
      {layout.socials !== "none" && socials.length > 0 && (
        <div style={{ display: "flex", marginTop: 8 }}>
          {socials.map((s) =>
            layout.socials === "badges" ? (
              <div key={s.key} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, marginRight: 5, borderRadius: 4, background: accent, color: "#fff", fontSize: 11, fontWeight: 700 }}>
                {s.badge}
              </div>
            ) : (
              <div key={s.key} style={{ display: "flex", marginRight: 10, fontSize: 12, color: accent }}>
                {s.label}
              </div>
            ),
          )}
        </div>
      )}
      {layout.card && (
        <div style={{ display: "flex", alignItems: "center", marginTop: 10 }}>
          <div style={{ display: "flex", background: accent, color: "#fff", fontSize: 12, fontWeight: 700, padding: "6px 12px", borderRadius: 4 }}>View my digital card</div>
          {layout.card === "button-qr" && <QrPlaceholder />}
        </div>
      )}
    </div>
  );
}

function QrPlaceholder() {
  const cells: ReactNode[] = [];
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const on = (r * 7 + c) % 3 === 0 || r === 0 || c === 0 || r === 6 || c === 6;
      cells.push(<div key={`${r}-${c}`} style={{ display: "flex", width: 6, height: 6, background: on ? "#111827" : "#ffffff" }} />);
    }
  }
  return <div style={{ display: "flex", flexWrap: "wrap", width: 42, height: 42, marginLeft: 10, padding: 0 }}>{cells}</div>;
}

function Layout({ layout, d }: { layout: SignatureLayout; d: SignatureData }) {
  const accent = d.accent ?? DEFAULT_ACCENT;
  const frame: Record<string, string | number> =
    layout.divider === "top" ? { borderTop: `3px solid ${accent}`, paddingTop: 10 } : layout.divider === "left-bar" ? { borderLeft: `5px solid ${accent}`, paddingLeft: 14 } : {};
  let body: ReactNode;
  if (layout.arrangement === "centered") {
    body = (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Photo layout={layout} d={d} size={72} accent={accent} />
        <div style={{ display: "flex", marginTop: 8 }}>
          <Details layout={layout} d={d} accent={accent} center />
        </div>
      </div>
    );
  } else if (layout.arrangement === "side" || layout.arrangement === "split") {
    const split = layout.arrangement === "split";
    body = (
      <div style={{ display: "flex", alignItems: "center" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: split ? 16 : "0 16px 0 0",
            background: split ? accent : "transparent",
            borderRight: layout.divider === "vertical" ? `2px solid ${accent}` : "none",
            marginRight: 16,
            alignSelf: "stretch",
          }}
        >
          {layout.side === "photo" ? <Photo layout={layout} d={d} size={84} accent={accent} /> : <Logo d={d} width={110} light={split} />}
        </div>
        <Details layout={layout} d={d} accent={accent} />
      </div>
    );
  } else {
    body = (
      <div style={{ display: "flex", flexDirection: "column" }}>
        <Details layout={layout} d={d} accent={accent} />
        {layout.logo === "below" && (
          <div style={{ display: "flex", marginTop: 10 }}>
            <Logo d={d} width={120} />
          </div>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", ...frame }}>{body}</div>
      {layout.banner && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", marginTop: 12, width: 460, height: 48, borderRadius: 6, background: `${accent}22`, color: accent, fontSize: 13, fontWeight: 700 }}>
          Your banner here — this month&apos;s offer
        </div>
      )}
      {layout.disclaimer && (
        <div style={{ display: "flex", marginTop: 8, width: 520, fontSize: 10, color: "#9ca3af" }}>{(d.disclaimer || "Your company's disclaimer goes here.").slice(0, 160)}</div>
      )}
    </div>
  );
}

/** The watermarked PNG for one premium template, filled with the visitor's details. */
export function renderPremiumPreview(layout: SignatureLayout, raw: SignatureData): ImageResponse {
  const d = cleanData(raw);
  return new ImageResponse(
    (
      <div style={{ display: "flex", position: "relative", width: "100%", height: "100%", background: "#ffffff", padding: 24, fontFamily: "Geist, sans-serif" }}>
        <Layout layout={layout} d={d} />
        {/* The watermark: across the whole picture, under nothing. */}
        <div style={{ display: "flex", position: "absolute", top: 0, left: 0, width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}>
          <div style={{ display: "flex", transform: "rotate(-14deg)", fontSize: 58, fontWeight: 700, letterSpacing: 8, whiteSpace: "nowrap", color: "rgba(37, 99, 235, 0.13)" }}>PREMIUM PREVIEW</div>
        </div>
        <div style={{ display: "flex", position: "absolute", right: 12, bottom: 10, fontSize: 12, color: "rgba(17,24,39,0.55)" }}>Premium template — included with Deskzo Signatures</div>
      </div>
    ),
    {
      width: PREVIEW_WIDTH,
      height: PREVIEW_HEIGHT,
      headers: { "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" },
    },
  );
}
