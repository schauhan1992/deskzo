import type { Tone } from "@/lib/console-shared/types";
import type { CheckResult, CheckStatus, EntityScore, KeywordAnalysis, SeoLabel } from "@/lib/seo/types";

/**
 * How the SEO Intelligence screens word and order what the engine (src/lib/seo) answers — the
 * editors' score panels and the dashboard read the same tables here, so "Warning" or "Needs
 * improvement" looks and reads the same everywhere. Nothing here scores anything: the numbers, the
 * labels, the messages and the recommendations are the engine's own.
 *
 * Pure and client-safe.
 */

/** A score band's tone (the existing tone tokens). Always shown with the number and the label — never colour alone. */
export const LABEL_TONE: Record<SeoLabel, Extract<Tone, "success" | "info" | "warning" | "danger">> = { Excellent: "success", Good: "info", "Needs improvement": "warning", Poor: "danger" };

/** The dashboard's disclaimer, word for word. */
export const SEO_DISCLAIMER = "SEO, AEO and GEO scores are internal optimization indicators based on your site's content and technical configuration. They are not scores issued by Google or AI platforms.";

/** The bands, best first, with their ranges — for the distribution and the score filter. */
export const SCORE_BANDS: readonly { label: SeoLabel; param: string; min: number; max: number }[] = [
  { label: "Excellent", param: "excellent", min: 80, max: 100 },
  { label: "Good", param: "good", min: 60, max: 79 },
  { label: "Needs improvement", param: "needs-improvement", min: 40, max: 59 },
  { label: "Poor", param: "poor", min: 0, max: 39 },
];

/** "Overall score 84 out of 100, Excellent" — what a screen reader hears for a score. */
export const scoreSentence = (what: string, score: number, label: SeoLabel) => `${what} ${score} out of 100, ${label}`;

/** A check's status in words, with its tone. */
export const STATUS_WORDS: Record<CheckStatus, { label: string; tone: Tone }> = {
  FAIL: { label: "Failed", tone: "danger" },
  WARNING: { label: "Warning", tone: "warning" },
  PASS: { label: "Passed", tone: "success" },
  INFO: { label: "Suggestion", tone: "info" },
  NOT_APPLICABLE: { label: "Not applicable", tone: "neutral" },
};

const CATEGORY_ORDER = { seo: 0, aeo: 1, geo: 2 } as const;

/** Critical first, then SEO before AEO before GEO, then the heavier check first — each list in a stable order. */
function byImportance(a: CheckResult, b: CheckResult): number {
  const crit = (c: CheckResult) => (c.severity === "critical" ? 0 : 1);
  return crit(a) - crit(b) || CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || b.pointsAvailable - a.pointsAvailable || a.id.localeCompare(b.id);
}

export const allChecks = (score: EntityScore): CheckResult[] => [...score.seo.checks, ...score.aeo.checks, ...score.geo.checks];

export type PanelTab = "issues" | "warnings" | "passed" | "suggestions";

/** The score panel's tabs: Issues (failed, critical first), Warnings, Passed, Suggestions (the engine's INFO answers). */
export const PANEL_TABS: readonly { key: PanelTab; label: string; empty: string }[] = [
  { key: "issues", label: "Issues", empty: "Nothing fails. Well done." },
  { key: "warnings", label: "Warnings", empty: "No warnings." },
  { key: "passed", label: "Passed", empty: "Nothing passes yet." },
  { key: "suggestions", label: "Suggestions", empty: "No suggestions." },
];

export function panelLists(score: EntityScore): Record<PanelTab, CheckResult[]> {
  const checks = allChecks(score);
  const of = (status: CheckStatus) => checks.filter((c) => c.status === status).sort(byImportance);
  return { issues: of("FAIL"), warnings: of("WARNING"), passed: of("PASS"), suggestions: of("INFO") };
}

/** The few that matter most: failures, then warnings, the critical ones first. */
export function topProblems(score: EntityScore, n = 3): CheckResult[] {
  const lists = panelLists(score);
  return [...lists.issues, ...lists.warnings].sort(byImportance).slice(0, n);
}

export type DetailSectionKey = "keywords" | "metadata" | "content" | "technical" | "structured" | "aeo" | "geo" | "social" | "images" | "links" | "indexability";

/** The detail drawer's sections, in the order they are shown. */
export const DETAIL_SECTIONS: readonly { key: DetailSectionKey; title: string }[] = [
  { key: "keywords", title: "Primary keywords" },
  { key: "metadata", title: "Metadata" },
  { key: "content", title: "Content" },
  { key: "technical", title: "Technical SEO" },
  { key: "structured", title: "Structured data" },
  { key: "aeo", title: "AEO — answers" },
  { key: "geo", title: "GEO — generative search" },
  { key: "social", title: "Social metadata" },
  { key: "images", title: "Images" },
  { key: "links", title: "Links" },
  { key: "indexability", title: "Indexability" },
];

const INDEXABILITY = new Set(["seo.robots", "seo.indexable", "seo.robots-conflict", "seo.sitemap"]);

/** Which section a check belongs in. Every check lands in exactly one. */
export function sectionOf(check: CheckResult): DetailSectionKey {
  if (check.group === "keywords") return "keywords";
  if (check.group === "structured-data") return "structured";
  if (INDEXABILITY.has(check.id)) return "indexability";
  if (check.id.startsWith("seo.images.")) return "images";
  if (check.id.startsWith("seo.links.")) return "links";
  if (check.category === "aeo") return "aeo";
  if (check.category === "geo") return "geo";
  if (check.group === "metadata") return "metadata";
  if (check.group === "social") return "social";
  if (check.group === "technical" || check.group === "url") return "technical";
  return "content";
}

/** Every check by section, each section's scored checks first (failed, warned, passed, suggested), the ones that don't apply last. */
export function detailSections(score: EntityScore): { key: DetailSectionKey; title: string; checks: CheckResult[]; notApplicable: CheckResult[] }[] {
  const rank: Record<CheckStatus, number> = { FAIL: 0, WARNING: 1, PASS: 2, INFO: 3, NOT_APPLICABLE: 4 };
  const checks = allChecks(score);
  return DETAIL_SECTIONS.map((s) => {
    const mine = checks.filter((c) => sectionOf(c) === s.key).sort((a, b) => rank[a.status] - rank[b.status] || byImportance(a, b));
    return { ...s, checks: mine.filter((c) => c.status !== "NOT_APPLICABLE"), notApplicable: mine.filter((c) => c.status === "NOT_APPLICABLE") };
  });
}

/** Where a keyword can appear, as the placement grid lists it. `full` rows are shown in the detail's table only. */
export const PLACEMENTS: readonly { key: keyof KeywordAnalysis & `in${string}`; label: string; full?: boolean }[] = [
  { key: "inTitle", label: "Title" },
  { key: "inDescription", label: "Description" },
  { key: "inUrl", label: "Address (URL)" },
  { key: "inH1", label: "H1" },
  { key: "inFirstSection", label: "First section" },
  { key: "inBody", label: "Body text" },
  { key: "inImageAlt", label: "Image alt text" },
  { key: "inHeadings", label: "Other headings", full: true },
];
