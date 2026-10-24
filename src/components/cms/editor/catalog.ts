import {
  BadgeCheck,
  BarChart3,
  BookOpen,
  Building2,
  CreditCard,
  FileText,
  Grid3x3,
  HelpCircle,
  Image as ImageIcon,
  LayoutGrid,
  LayoutTemplate,
  LifeBuoy,
  Link2,
  LogIn,
  Mail,
  Megaphone,
  MonitorSmartphone,
  PanelTop,
  PenLine,
  Quote,
  Scale,
  ShieldCheck,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { BLOCK_TYPES, type BlockPropsMap, type BlockType, type SiteBlock } from "@/components/site/blocks/types";
import { DEFAULT_SITE_PAGES } from "@/components/site/defaults";
import { plainInline } from "@/components/cms/editor/inline-markup";
import { newBlockId } from "@/components/cms/editor/doc-utils";
import { indiaClock } from "@/lib/time/zone";

/**
 * What the editor knows about each block type besides its shape (src/components/site/blocks/types.ts):
 * its name and one-line description for the "Add block" menu, an icon, the group it is listed under,
 * the content a new one starts with, and the one-line summary its collapsed card shows.
 *
 * New blocks start with neutral starter words, so the live preview shows the block at once — every
 * one of them is obviously a placeholder, and nothing is published until someone publishes it. The
 * form blocks (pricing, contact, sign-in, signup) start as the site's own default copy of them.
 */

export type BlockGroup = "Top of page" | "Sections" | "Text" | "Live data and forms";

export type BlockInfo = {
  label: string;
  description: string;
  icon: LucideIcon;
  group: BlockGroup;
  /** The page's h1 — a page should have one. */
  pageTop?: boolean;
};

export const BLOCK_INFO: Record<BlockType, BlockInfo> = {
  hero: { label: "Hero", description: "The page's big opening: headline, buttons and a picture. Its heading is the page's main title.", icon: LayoutTemplate, group: "Top of page", pageTop: true },
  pageHeader: { label: "Page header", description: "The top of an inner page: its main title, an introduction and an optional notice.", icon: PanelTop, group: "Top of page", pageTop: true },
  featureGrid: { label: "Feature grid", description: "Cards in two to four columns, each with an icon, a title, words and a link.", icon: Grid3x3, group: "Sections" },
  moduleGrid: { label: "Module groups", description: "The product's modules, grouped. Modules sold in one country are badged automatically.", icon: Building2, group: "Sections" },
  richText: { label: "Text", description: "Headings, paragraphs, lists, tables and notes — for policies, articles and long reads.", icon: FileText, group: "Text" },
  imageText: { label: "Image and text", description: "Words on one side, an image or a product preview on the other.", icon: ImageIcon, group: "Sections" },
  stats: { label: "Figures", description: "A row of big numbers with a label under each.", icon: BarChart3, group: "Sections" },
  faq: { label: "Questions and answers", description: "Questions that open to show their answers.", icon: HelpCircle, group: "Sections" },
  cta: { label: "Call to action", description: "A closing band or panel with a heading and one or two buttons.", icon: Megaphone, group: "Sections" },
  pricingTable: { label: "Pricing table", description: "The plans on sale, read live for the visitor's country. You write the words around them.", icon: CreditCard, group: "Live data and forms" },
  securityHighlights: { label: "Security highlights", description: "Short promises, each with an icon, and a link to read more.", icon: ShieldCheck, group: "Sections" },
  contactForm: { label: "Contact form", description: "The form that fills the leads inbox, with other ways to get in touch beside it.", icon: Mail, group: "Live data and forms" },
  logoCloud: { label: "Customer logos", description: "A row of logos from the media library. Use only real customers who agreed to it.", icon: BadgeCheck, group: "Sections" },
  testimonial: { label: "Quote", description: "A customer's words, with their name and role. Use only real quotes.", icon: Quote, group: "Sections" },
  productPreviews: { label: "Product previews", description: "The drawn product screens (sample data), each with a title and words.", icon: MonitorSmartphone, group: "Sections" },
  workspaceSignin: { label: "Workspace sign-in", description: "Go to a workspace by its name, or find one's workspaces by email.", icon: LogIn, group: "Live data and forms" },
  signupForm: { label: "Signup form", description: "Setting up a new workspace — the signup itself, with words beside it.", icon: UserPlus, group: "Live data and forms" },
  comparisonTable: {
    label: "Comparison table",
    description: "This product beside another, feature by feature, with each claim's source on the other product's own site and the date it was read.",
    icon: Scale,
    group: "Sections",
  },
  relatedLinks: { label: "Related links", description: "Cards linking to other pages on this site, each with a line on what is there.", icon: Link2, group: "Sections" },
  productVsSuite: {
    label: "Product and Deskzo One",
    description: "A product beside Deskzo One: both with their live prices, monthly or yearly, and their own trials — then every module compared. Built from the product list; you write the words around it.",
    icon: Scale,
    group: "Live data and forms",
  },
  signatureGenerator: {
    label: "Email signature generator",
    description: "The free generator: visitors build a signature and copy it into their email. Built in the browser; nothing is sent anywhere.",
    icon: PenLine,
    group: "Live data and forms",
  },
  moduleHighlights: { label: "Page map", description: "For a hub page: groups of links to the pages under it, each with what it covers.", icon: LayoutGrid, group: "Sections" },
  helpGuide: {
    label: "Module guide",
    description: "A Help Center guide to one module, on the outline every guide follows. Its heading is the page's main title; which products include the module is added from the product list. For pages under help/.",
    icon: BookOpen,
    group: "Top of page",
    pageTop: true,
  },
  helpIndex: { label: "Help Center index", description: "Every published guide, grouped by product, with a search box. For the Help Center page.", icon: LifeBuoy, group: "Live data and forms" },
  productStrip: {
    label: "Product strip",
    description: "Every product by its 3D icon, name and line, each linking to its page. Built from the product list, so a new product is in it on its own; you write the words around it.",
    icon: Grid3x3,
    group: "Sections",
  },
};

export const BLOCK_GROUPS: BlockGroup[] = ["Top of page", "Sections", "Text", "Live data and forms"];

/** The site's own copy of a block, where a default page has one — the form blocks start from it. */
function siteDefault<K extends BlockType>(type: K): BlockPropsMap[K] | null {
  for (const page of DEFAULT_SITE_PAGES) {
    const found = page.blocks.find((b) => b.type === type);
    if (found) return structuredClone(found.props) as BlockPropsMap[K];
  }
  return null;
}

const STARTERS: { [K in BlockType]: () => BlockPropsMap[K] } = {
  hero: () => ({
    heading: "A clear promise in one line",
    subheading: "Say who it is for and what changes for them once they use it.",
    primary: { kind: "signup" },
    secondary: { kind: "link", label: "Talk to sales", href: "/contact?topic=sales" },
    media: { kind: "preview", preview: "pipeline" },
  }),
  pageHeader: () => ({ heading: "Page heading", intro: "One or two sentences on what this page covers." }),
  featureGrid: () => ({
    heading: "Section heading",
    intro: "A sentence that sets up the cards below.",
    columns: 3,
    items: [
      { icon: "sparkles", title: "First point", body: "What it does for the reader, in a sentence or two." },
      { icon: "shield", title: "Second point", body: "What it does for the reader, in a sentence or two." },
      { icon: "chart", title: "Third point", body: "What it does for the reader, in a sentence or two." },
    ],
  }),
  moduleGrid: () => ({
    heading: "Section heading",
    groups: [{ icon: "layers", title: "Group name", summary: "What this group covers.", modules: [{ label: "Module name", blurb: "What the module does." }] }],
  }),
  richText: () => ({ content: [{ type: "paragraph", text: "Start writing here." }] }),
  imageText: () => ({
    heading: "A point worth a picture",
    body: ["Explain it in a short paragraph."],
    media: { kind: "preview", preview: "invoice" },
    mediaSide: "right",
  }),
  stats: () => ({ items: [{ value: "123", label: "Replace with a real figure" }] }),
  faq: () => ({ heading: "Questions and answers", items: [{ question: "A question people ask?", answer: ["The answer, in plain words."] }] }),
  cta: () => ({ heading: "Ready to start?", primary: { kind: "signup" }, secondary: { kind: "link", label: "Contact sales", href: "/contact?topic=sales" }, variant: "band" }),
  pricingTable: () =>
    siteDefault("pricingTable") ?? { countryLabel: "Prices for", editionsHeading: "Plans", extrasHeading: "Add-ons", emptyHeading: "No plans on sale here yet", emptyBody: "Get in touch and we will help." },
  securityHighlights: () => ({ heading: "Section heading", items: [{ icon: "shield", title: "A promise", body: "What it means, in plain words." }] }),
  contactForm: () =>
    siteDefault("contactForm") ?? {
      heading: "Send us a message",
      topics: { demo: "Book a demo", sales: "Sales", support: "Support", other: "Something else" },
      submitLabel: "Send",
      successHeading: "Thank you",
      successBody: "We will be in touch.",
    },
  logoCloud: () => ({ heading: "Customers", items: [{ name: "Customer name" }] }),
  testimonial: () => ({ quote: "What a customer said, in their own words.", name: "Their name", role: "Their role" }),
  productPreviews: () => ({ heading: "Section heading", items: [{ preview: "pipeline", title: "Sales pipeline", body: "What the screen shows." }] }),
  workspaceSignin: () =>
    siteDefault("workspaceSignin") ?? {
      goHeading: "Go to your workspace",
      findHeading: "Find your workspaces",
      confirmationHeading: "Check your email",
      confirmationBody: "If that address has workspaces, we have sent it their links.",
    },
  signupForm: () => siteDefault("signupForm") ?? { heading: "Set up your workspace" },
  comparisonTable: () => ({
    heading: "How {siteName} compares",
    intro: "What each product offers, point by point, from each one's own public information.",
    competitor: "Other product's name",
    // Today in India: the day the other product's website is read, which the page states — the public
    // site's dates are India's, whatever zone the console keeps.
    asOf: indiaClock.today(),
    rows: [{ feature: "First feature compared", us: "yes", them: "partial", note: "What differs, in a line." }],
    disclaimer: "Information about other products is from their public websites as of the date above and may have changed since. Product names and trademarks belong to their owners.",
  }),
  relatedLinks: () => ({
    heading: "Related pages",
    links: [
      { label: "Plans and pricing", href: "/pricing", description: "What each plan includes, in your country's currency." },
      { label: "Security", href: "/security", description: "How each company's data is kept apart and protected." },
    ],
  }),
  productVsSuite: () => ({
    product: "crm",
    anchor: "plans",
    heading: "Deskzo CRM on its own, or every product with Deskzo One",
    intro: "Start with the one you need. Deskzo One is every product in one workspace, on one set of records.",
  }),
  signatureGenerator: () => ({
    upsellHeading: "Signatures for your whole team",
    upsellBody: "One design for everybody, filled in from each person's record and kept in step.",
    upsellAction: { kind: "link", label: "Talk to us", href: "/contact?topic=sales" },
    privacyNote: "Nothing you type here leaves your browser.",
  }),
  moduleHighlights: () => ({
    heading: "Section heading",
    groups: [{ title: "Group name", items: [{ label: "Page name", href: "/pricing", description: "What the page covers, in a line." }] }],
  }),
  // The outline, with a line in each section saying what goes there — every one obviously a placeholder.
  helpGuide: () => ({
    module: "",
    heading: "Module name",
    summary: "One or two sentences on what the module does, for the Help Center and the app's Help panel.",
    purpose: [{ type: "paragraph", text: "What the module is for, and the problem it solves." }],
    access: [{ type: "paragraph", text: "Who can use it, in plain words." }],
    permissions: [],
    setup: [{ type: "paragraph", text: "What is done once, and by whom." }],
    tasks: [{ title: "An everyday task", body: [{ type: "list", ordered: true, items: ["The first step.", "The next step."] }] }],
    settings: [],
    faq: [{ question: "A question people ask?", answer: [{ type: "paragraph", text: "The answer, in plain words." }] }],
    related: [],
  }),
  helpIndex: () => siteDefault("helpIndex") ?? { searchLabel: "Search the guides", everyProductHeading: "In every product", emptyText: "The guides are on their way." },
  productStrip: () => siteDefault("productStrip") ?? { heading: "Every product", intro: "A sentence that sets up the products below." },
};

/** A new block of `type`, with a fresh id. Call from an event handler (the id is random). */
export function newBlock<K extends BlockType>(type: K): SiteBlock {
  return { id: newBlockId(), type, props: STARTERS[type]() } as SiteBlock;
}

export function isBlockType(value: unknown): value is BlockType {
  return typeof value === "string" && (BLOCK_TYPES as readonly string[]).includes(value);
}

const clip = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** The one line a collapsed block card shows: its heading, or the first words it has. */
export function blockSummary(block: SiteBlock): string {
  const p = block.props as Record<string, unknown>;
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = p[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  switch (block.type) {
    case "richText": {
      if (block.props.heading?.trim()) return clip(block.props.heading.trim());
      for (const node of block.props.content ?? []) {
        const text = node.type === "heading" ? node.text : node.type === "list" ? plainInline(node.items[0]) : node.type === "table" ? node.columns.join(" · ") : plainInline(node.text);
        if (text.trim()) return clip(text.trim());
      }
      return "";
    }
    case "stats":
      return clip((block.props.items ?? []).map((i) => [i.value, i.label].filter(Boolean).join(" ")).join(" · "));
    case "testimonial":
      return clip(first("quote", "name"));
    case "workspaceSignin":
      return clip(first("goHeading", "findHeading"));
    case "pricingTable":
      return clip(first("editionsHeading", "extrasHeading"));
    case "logoCloud":
      return clip(first("heading") || (block.props.items ?? []).map((i) => i.name).join(", "));
    case "comparisonTable":
      return clip(first("heading") || (block.props.competitor ? `Compared with ${block.props.competitor}` : ""));
    case "relatedLinks":
      return clip(first("heading") || (block.props.links ?? []).map((l) => l.label).join(", "));
    case "moduleHighlights":
      return clip(first("heading") || (block.props.groups ?? []).map((g) => g.title).join(", "));
    case "signatureGenerator":
      return clip(first("heading", "upsellHeading"));
    case "helpGuide":
      return clip([first("heading"), block.props.module ? `(${block.props.module})` : ""].filter(Boolean).join(" "));
    case "helpIndex":
      return clip(first("searchLabel"));
    default:
      return clip(first("heading", "eyebrow", "intro"));
  }
}
