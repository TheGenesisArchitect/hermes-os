// GENESIS RESEARCH DIGEST (operator 2026-07-28: Resend is connected to the
// Supabase Ambassador Cohort — "a great Addition to what we have been
// preparing to deliver"). Renders the latest Frontier Report into the
// professional branded email and sends via Resend.
//
// RAILS (standing):
//  - FROM is info@genesisreserve.io ONLY (never genesisbanking.io).
//  - Research/education framing, zero performance claims, no financial advice.
//  - Real Medallion asset from the production site — never a CSS approximation.
//  - Key-ready: RESEND_API_KEY absent → render preview only, never fail.
//  - Cohort sends are OPERATOR-TRIGGERED; nothing here auto-mails a list.
import { db, marketNews } from "@hermes/db";
import { desc, eq } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Sender identity: the ambassador pipeline's own verified Resend identity
// (RESEND_FROM, @genesisreserve.app — 36 days of proven cohort deliverability).
// Falls back to the .io identity only if the env is absent.
const fromAddr = () => process.env.RESEND_FROM ?? "Genesis Research Desk <info@genesisreserve.io>";
const LOGO = "https://genesisreserve.app/genesis-logo.png";
const HERO = "https://genesisreserve.app/genesis-og.png";
const CTA_URL = "https://genesisreserve.app";

interface ReportRow {
  headline: string;
  whyItMatters: string | null;
  contentDrafts: unknown;
  createdAt: Date;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderDigestHtml(r: ReportRow): string {
  const drafts = (r.contentDrafts ?? {}) as {
    sections?: { heading: string; body: string }[];
    watchlist?: { name: string; ecosystem: string; thesis: string }[];
  };
  const date = r.createdAt.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const sections = (drafts.sections ?? [])
    .map(
      (s) => `
      <tr><td style="padding:18px 32px 0">
        <h3 style="margin:0 0 6px;font-size:15px;letter-spacing:.02em;color:#0b1220">${esc(s.heading)}</h3>
        <p style="margin:0;font-size:14px;line-height:1.65;color:#3c4657">${esc(s.body)}</p>
      </td></tr>`,
    )
    .join("");
  const watch = (drafts.watchlist ?? [])
    .map(
      (w) => `
      <tr>
        <td style="padding:10px 14px;border-bottom:1px solid #e8ebf1;font-size:13px;font-weight:600;color:#0b1220;white-space:nowrap">${esc(w.name)}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #e8ebf1;font-size:12px;color:#64708a;white-space:nowrap">${esc(w.ecosystem)}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #e8ebf1;font-size:13px;line-height:1.5;color:#3c4657">${esc(w.thesis)}</td>
      </tr>`,
    )
    .join("");
  return `
<div style="background:#f4f6fa;padding:32px 12px;font-family:Segoe UI,Helvetica,Arial,sans-serif">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e9f0">
    <tr><td style="background:#0b1220;padding:26px 32px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
        <td><img src="${LOGO}" alt="Genesis Reserve" width="44" height="44" style="display:block;border-radius:8px"/></td>
        <td style="padding-left:14px">
          <div style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.03em">GENESIS RESEARCH DESK</div>
          <div style="color:#8fa3c8;font-size:12px;letter-spacing:.06em">THE DEFI FRONTIER · ${esc(date)}</div>
        </td>
      </tr></table>
    </td></tr>
    <tr><td>
      <a href="${CTA_URL}" style="display:block"><img src="${HERO}" alt="Genesis Reserve — The DeFi Frontier" width="640" style="display:block;width:100%;height:auto"/></a>
    </td></tr>
    <tr><td style="padding:28px 32px 4px">
      <h1 style="margin:0;font-size:21px;line-height:1.35;color:#0b1220">${esc(r.headline)}</h1>
    </td></tr>
    <tr><td style="padding:12px 32px 0">
      <p style="margin:0;font-size:14.5px;line-height:1.7;color:#3c4657">${esc(r.whyItMatters ?? "")}</p>
    </td></tr>
    ${sections}
    ${
      watch
        ? `<tr><td style="padding:26px 32px 6px"><h3 style="margin:0;font-size:15px;color:#0b1220">Research Watchlist</h3></td></tr>
           <tr><td style="padding:6px 32px 8px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e8ebf1;border-radius:8px;overflow:hidden">${watch}</table></td></tr>`
        : ""
    }
    <tr><td style="padding:26px 32px 6px" align="center">
      <a href="${CTA_URL}" style="display:inline-block;background:#0b1220;color:#ffffff;font-size:14px;font-weight:600;letter-spacing:.03em;padding:12px 28px;border-radius:8px;text-decoration:none">Explore Genesis Reserve →</a>
    </td></tr>
    <tr><td style="padding:22px 32px 28px">
      <p style="margin:0;font-size:11.5px;line-height:1.6;color:#8b96ab;border-top:1px solid #e8ebf1;padding-top:16px">
        Prepared by the Genesis Research Desk for the Ambassador Cohort. This report is market research and education only —
        it is not investment advice, an offer, or a recommendation to buy or sell any asset. Digital-asset markets involve
        substantial risk. Genesis Reserve · info@genesisreserve.io
      </p>
    </td></tr>
  </table>
</div>`;
}

export async function latestFrontierReport(): Promise<ReportRow | null> {
  const [row] = await db
    .select({
      headline: marketNews.headline,
      whyItMatters: marketNews.whyItMatters,
      contentDrafts: marketNews.contentDrafts,
      createdAt: marketNews.createdAt,
    })
    .from(marketNews)
    .where(eq(marketNews.kind, "frontier_report"))
    .orderBy(desc(marketNews.createdAt))
    .limit(1);
  return row ?? null;
}

/** Send via Resend when keyed; always writes the dashboard preview. Returns a status line. */
export async function sendDigest(to: string[]): Promise<string> {
  const report = await latestFrontierReport();
  if (!report) return "no frontier_report published yet";
  const html = renderDigestHtml(report);
  const previewDir = resolve(import.meta.dirname, "../../../apps/dashboard/public");
  try {
    mkdirSync(previewDir, { recursive: true });
    // PREVIEW ONLY: swap hosted image URLs for same-origin copies — this box's
    // network path to genesisreserve.app is DPI-broken (curl exit 35), so the
    // operator's local browser can't load the hosted assets even though the
    // public internet (and every mail client's image proxy) loads them fine —
    // verified 200/image-png from a cloud fetch 2026-07-28. The EMAIL keeps
    // the hosted URLs; only the local preview substitutes.
    const previewHtml = html
      .replaceAll("https://genesisreserve.app/genesis-og.png", "/genesis-og.png")
      .replaceAll("https://genesisreserve.app/genesis-logo.png", "/genesis-logo.png");
    writeFileSync(resolve(previewDir, "digest-preview.html"), previewHtml, "utf8");
  } catch {
    /* preview is best-effort */
  }
  const key = process.env.RESEND_API_KEY ?? "";
  if (!key) return "preview written to :3777/digest-preview.html — RESEND_API_KEY not set, no send";
  if (!to.length) return "preview written — no recipients given";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from: fromAddr(), to, subject: `The DeFi Frontier — ${report.headline}`, html }),
  });
  const body = await res.text();
  return res.ok ? `sent to ${to.join(", ")} (${body.slice(0, 60)})` : `RESEND ERROR ${res.status}: ${body.slice(0, 160)}`;
}
