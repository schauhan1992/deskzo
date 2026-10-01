import type { LucideIcon } from "lucide-react";
import {
  Archive,
  CreditCard,
  Banknote,
  BadgePercent,
  BookLock,
  Boxes,
  Building2,
  CalendarDays,
  FileSignature,
  FileSpreadsheet,
  Fingerprint,
  Hash,
  KeyRound,
  Landmark,
  LayoutGrid,
  Link2,
  MessageSquareHeart,
  Globe,
  LifeBuoy,
  MailPlus,
  Megaphone,
  Palette,
  ReceiptText,
  ScrollText,
  Shapes,
  Send,
  ShieldCheck,
  Star,
  Tags,
  Trophy,
  MapPin,
  Shuffle,
  Truck,
  UserCog,
  UserRound,
  Users,
  Wrench,
  Sparkles,
  Lock,
  CalendarCheck,
  ListChecks,
} from "lucide-react";

/**
 * Every setting in the app, in one list.
 *
 * ## Why a registry rather than two menus
 *
 * There are two ways to get at a setting — the index of grouped cards, and the sidebar that stands
 * beside every settings page — and they must agree. Written as two lists they would not: the last
 * four features each added a settings screen, and each one reached the horizontal tab strip and
 * nothing else, so the only way to find e-way bills was to already know the URL. One list rendered
 * twice cannot drift.
 *
 * ## Why settings that live elsewhere are in here too
 *
 * The chart of accounts, the holiday calendar, the reception tablets and the marketing templates
 * are all things an admin configures once and then forgets, which is the definition of a setting —
 * but they live inside their own modules because that is where the data is, and moving them would
 * be churn for its own sake. So they are listed here with `external: true`: findable from Settings,
 * still living where they belong. A setting nobody can find is not configurable.
 *
 * ## Gating
 *
 * Each entry names the permission its own page requires — not a blanket "is an admin" flag. The two
 * must agree, because a link whose page then refuses you is the invitation-to-a-locked-door problem
 * that `src/components/layout/sidebar.tsx` already avoids, and the tab strip this replaces did not:
 * it showed all eight tabs to everybody, including the auditor who could open exactly one of them.
 */

export type SettingsItem = {
  key: string;
  label: string;
  /** One line, shown under the label on the index. Says what it decides, not what it is called. */
  description: string;
  href: string;
  icon: LucideIcon;
  /**
   * The permission the destination page itself checks, verbatim.
   *
   * An array means any one of them opens it. `null` means anybody signed in may — used only for a
   * person's own preferences. `check:settings` asserts every key here exists and that it matches
   * what the destination page actually tests, because a link that names the wrong key is invisible
   * to the one person who holds the right one.
   */
  permission: string | string[] | null;
  /** True when the key is a prefix — `data.` opens on any one of ten export and import keys. */
  permissionPrefix?: boolean;
  /** The module that has to be switched on for this to exist at all — or, given several, any of them. */
  module?: string | readonly string[];
  /** Lives outside /settings, inside the module it configures. */
  external?: boolean;
};

export type SettingsGroup = {
  key: string;
  label: string;
  items: SettingsItem[];
};

export type SettingsSection = {
  key: string;
  label: string;
  description: string;
  groups: SettingsGroup[];
};

export const SETTINGS: SettingsSection[] = [
  {
    key: "organisation",
    label: "Organisation settings",
    description: "Who this company is, who works here, and what the government sees.",
    groups: [
      {
        key: "company",
        label: "Company",
        items: [
          {
            key: "organisation",
            label: "Profile",
            description: "Legal name, PAN, registered office, head-office GSTIN and default bank details — what prints unless a branch says otherwise.",
            href: "/settings/organisation",
            icon: Building2,
            permission: "settings.manage",
          },
          {
            key: "branches",
            label: "Branches & GST registrations",
            description: "Your offices, shops and warehouses, the GSTIN each one bills under, and which is the head office.",
            href: "/settings/branches",
            icon: MapPin,
            permission: "settings.manage",
          },
          {
            key: "branding",
            label: "Branding",
            description: "The app's own name, logo, colour and default theme.",
            href: "/settings/branding",
            icon: Palette,
            permission: "settings.manage",
          },
          {
            key: "letterhead",
            label: "Letterhead",
            description: "The logo and signature block at the top and bottom of a printed document.",
            href: "/settings/letterhead",
            icon: FileSignature,
            permission: "settings.manage",
          },
          {
            key: "billing",
            label: "Plan & billing",
            description: "Your plan, paying for it, invoices, and how much of it is in use. The workspace owner's alone.",
            href: "/settings/billing",
            icon: CreditCard,
            permission: "settings.manage",
          },
          {
            key: "domain",
            label: "Custom domain",
            description: "Reach the workspace at an address of your own, like erp.yourcompany.com — its DNS records and which address links use. The workspace owner's alone.",
            href: "/settings/domain",
            icon: Link2,
            permission: "settings.manage",
          },
          {
            key: "modules",
            label: "Modules",
            description: "Which parts of the app exist. Switching one off hides it everywhere.",
            href: "/settings/modules",
            icon: LayoutGrid,
            permission: "settings.manage",
          },
          {
            key: "copilot",
            label: "AI copilot",
            description: "Claude, ChatGPT or Gemini in the header — the provider, its key, the model and a daily allowance per person.",
            href: "/settings/copilot",
            icon: Sparkles,
            permission: "settings.manage",
          },
          {
            key: "help",
            label: "Help & support",
            description: "The helpline on everybody's dashboard, and the help articles and training videos in the rail.",
            href: "/settings/help",
            icon: LifeBuoy,
            permission: "help.manage",
          },
          {
            key: "updates",
            label: "What's new",
            description: "Post updates everybody sees under Recent Updates and in the rail — now, or at a time you choose.",
            href: "/settings/updates",
            icon: Megaphone,
            permission: "help.manage",
          },
          {
            key: "document-emails",
            label: "Document emails",
            description: "The subject and message sent with an emailed proposal, proforma, tax invoice or credit note.",
            href: "/settings/document-emails",
            icon: MailPlus,
            permission: "settings.manage",
            module: ["sales_documents", "purchase_documents"],
          },
        ],
      },
      {
        key: "people",
        label: "Staff & security",
        items: [
          {
            key: "access",
            label: "Staff & roles",
            description: "Who can sign in, and exactly what each of them may do — their roles and the permissions behind them.",
            href: "/settings/access",
            icon: UserCog,
            permission: "permissions.view",
          },
          {
            key: "security",
            label: "Security & data protection",
            description: "Sign-in rules, two-factor, and the copy and screenshot deterrents.",
            href: "/settings/security",
            icon: ShieldCheck,
            permission: "security.manage",
          },
          {
            key: "locks",
            label: "Account locks",
            description: "Lock one person — or, as super admin, the whole company — out of the CRM behind a notice they can't get past.",
            href: "/settings/locks",
            icon: Lock,
            permission: "users.lock",
          },
          {
            key: "access-control",
            label: "Devices, networks & sign-ins",
            description: "Who may sign in on what and from where, devices waiting for approval, and where everybody signed in from.",
            href: "/settings/security/access",
            icon: Fingerprint,
            permission: ["security.manage", "access.approveDevices", "access.viewSignIns"],
          },
          {
            key: "activity",
            label: "Activity log",
            description: "What has been done in the app, and by whom.",
            href: "/activity",
            icon: ScrollText,
            permission: null,
            external: true,
          },
        ],
      },
      {
        key: "compliance",
        label: "Taxes & compliance",
        items: [
          {
            key: "einvoicing",
            label: "e-Invoicing",
            description: "The IRP connection that stamps an invoice with its IRN and QR code.",
            href: "/settings/einvoicing",
            icon: ReceiptText,
            permission: "settings.manage",
          },
          {
            key: "eway",
            label: "e-Way bills",
            description: "The portal connection, and the threshold for movement inside your own state.",
            href: "/settings/eway",
            icon: Truck,
            permission: "settings.manage",
            module: "sales_documents",
          },
          {
            key: "numbering",
            label: "Document numbering",
            description: "The prefix and running number each kind of document is issued with.",
            href: "/settings/numbering",
            icon: Hash,
            permission: "settings.manage",
            module: ["sales_documents", "purchase_documents"],
          },
          {
            key: "approvals",
            label: "Document approvals",
            description: "Which documents need signing off before they can be issued, and who may sign them.",
            href: "/settings/approvals",
            icon: ShieldCheck,
            permission: "settings.manage",
            module: ["sales_documents", "purchase_documents"],
          },
        ],
      },
      {
        key: "reach",
        label: "Customers & messaging",
        items: [
          {
            key: "portal",
            label: "Customer portal",
            description: "Who gets a login, what they can see, and what they can ask for.",
            href: "/settings/portal",
            icon: Users,
            permission: "portal.manage",
            module: "customer_portal",
          },
          {
            key: "messaging",
            label: "Mail & messaging",
            description: "The providers that send mail, the domain it comes from, and when it may go out.",
            href: "/settings/messaging",
            icon: Send,
            permission: "settings.manage",
            module: "marketing",
          },
          {
            key: "feedback",
            label: "Customer feedback",
            description: "How long a feedback link lasts, and what it says when it opens.",
            href: "/settings/feedback",
            icon: MessageSquareHeart,
            permission: "settings.manage",
            module: "feedback",
          },
        ],
      },
      {
        key: "leads",
        label: "Leads",
        items: [
          {
            key: "lead-assignment",
            label: "Lead assignment",
            description: "Who a new lead goes to — round robin, fewest open leads, by brand, designation, source or state.",
            href: "/settings/lead-assignment",
            icon: Shuffle,
            permission: "settings.manage",
          },
          {
            key: "lead-capture",
            label: "Lead capture API",
            description: "API keys for your websites to send enquiries in as leads, and the documentation to give their developers.",
            href: "/settings/lead-capture",
            icon: KeyRound,
            permission: "settings.manage",
          },
        ],
      },
      {
        key: "lists",
        label: "Lists & taxonomy",
        items: [
          {
            key: "lists",
            label: "Lists",
            description: "Industries, project types, and the vault's own tags. Brands and product families are under Items & Inventory.",
            href: "/settings/lists",
            icon: Tags,
            permission: "settings.manage",
          },
          {
            key: "customer-categories",
            label: "Customer categories",
            description: "How customers are grouped — the icon and colour beside every customer's name, and how to treat them.",
            href: "/settings/customer-categories",
            icon: Shapes,
            permission: "companies.manageCategories",
          },
          {
            key: "pin-directory",
            label: "PIN directory",
            description: "India Post's PIN codes behind every address form — synced from data.gov.in.",
            href: "/settings/pin-directory",
            icon: MapPin,
            permission: "settings.manage",
          },
          {
            key: "world-places",
            label: "World places",
            description: "States, cities and postal codes for addresses outside India — synced from GeoNames.",
            href: "/settings/world-places",
            icon: Globe,
            permission: "settings.manage",
          },
        ],
      },
    ],
  },
  {
    key: "modules",
    label: "Module settings",
    description: "Configuration that belongs to one part of the app, and lives with it.",
    groups: [
      {
        key: "purchase",
        label: "Purchase",
        items: [
          {
            key: "rebate-programmes",
            label: "Rebate programmes",
            description: "The backend rebates OEMs and distributors pay — Adobe 20% on an approved deal registration, Microsoft 2% — suggested on each order.",
            href: "/settings/rebate-programmes",
            icon: BadgePercent,
            // Seen by whoever sees rebates; the page lets only rebates.manage change them.
            permission: "rebates.view",
            module: "orders",
          },
        ],
      },
      {
        key: "finance",
        label: "Accounting",
        items: [
          {
            key: "accounts",
            label: "Chart of accounts",
            description: "The ledger accounts every posting lands in.",
            href: "/accounting/accounts",
            icon: Landmark,
            // Not "accounting.manage" — there is no such key. The chart is edited under
            // ledger.manageAccounts, and naming the wrong one hid this from everybody, super
            // admin included, because an unheld key is indistinguishable from a forbidden one.
            permission: "ledger.manageAccounts",
            module: "accounting",
            external: true,
          },
          {
            key: "books",
            label: "Close the books",
            description: "Locking a period so nobody can post into a month that has been reported.",
            href: "/accounting/books",
            icon: BookLock,
            permission: "books.close",
            module: "accounting",
            external: true,
          },
          {
            key: "revenue-close",
            label: "Revenue & Close",
            description: "Whether revenue and prepaids post themselves each night, how revenue spreads, and how large a monthly change must be to need explaining.",
            href: "/settings/revenue-close",
            icon: CalendarCheck,
            permission: "close.manage",
            module: "revenue_close",
          },
          {
            key: "close-checklist",
            label: "Month-end checklist",
            description: "The tasks every month's close is copied from: their order, owners, due days and automatic checks.",
            href: "/settings/close-checklist",
            icon: ListChecks,
            permission: "close.manage",
            module: "revenue_close",
          },
        ],
      },
      {
        key: "hr",
        label: "People",
        items: [
          {
            key: "holidays",
            label: "Holidays & leave",
            description: "The working calendar, and the kinds of leave people can take.",
            href: "/people/holidays",
            icon: CalendarDays,
            permission: "hr.manage",
            module: "hr",
            external: true,
          },
          {
            key: "devices",
            label: "Biometric terminals",
            description: "The attendance machines that report who came in.",
            href: "/people/devices",
            icon: Fingerprint,
            permission: "hr.manage",
            module: "hr",
            external: true,
          },
          {
            key: "wins",
            label: "Wins, awards & prizes",
            description: "What sales moments celebrate themselves, the fortnight's most-active awards, and the prizes for the top sellers and the most active.",
            href: "/wins/settings",
            icon: Trophy,
            permission: "wins.manage",
            module: "wins",
            external: true,
          },
        ],
      },
      {
        key: "logistics",
        label: "IT assets & logistics",
        items: [
          {
            key: "transporters",
            label: "Transporters",
            description: "The couriers you use, with the GSTIN an e-way bill needs.",
            href: "/logistics/transporters",
            icon: Truck,
            // Either opens it, matching the gate on the transporter actions: despatch is done by
            // the asset team and by order processing, and naming only one of them would hide the
            // screen from half the people who use it.
            permission: ["assets.manage", "orders.process"],
            module: "it_assets",
            external: true,
          },
        ],
      },
      {
        key: "visitors",
        label: "Reception",
        items: [
          {
            key: "kiosks",
            label: "Reception tablets",
            description: "The screens a visitor signs in on, and what each one is allowed to do.",
            href: "/visitors/kiosks",
            icon: Boxes,
            permission: "visitors.manage",
            module: "visitors",
            external: true,
          },
        ],
      },
      {
        key: "marketing",
        label: "Marketing",
        items: [
          {
            key: "templates",
            label: "Templates & journeys",
            description: "What gets sent, to whom, and what starts it.",
            href: "/marketing/templates",
            icon: Megaphone,
            permission: "marketing.manage",
            module: "marketing",
            external: true,
          },
          {
            key: "suppressions",
            label: "Suppression list",
            description: "Who must not be written to, and why.",
            href: "/marketing/suppressions",
            icon: Star,
            permission: "marketing.manage",
            module: "marketing",
            external: true,
          },
        ],
      },
    ],
  },
  {
    key: "data",
    label: "Data & continuity",
    description: "Getting data in, getting it out, and getting it back.",
    groups: [
      {
        key: "portability",
        label: "Data",
        items: [
          {
            key: "data",
            label: "Import & export",
            description: "Your data in a spreadsheet, and a spreadsheet back into your data.",
            href: "/settings/data",
            icon: FileSpreadsheet,
            permission: "data.",
            permissionPrefix: true,
          },
          {
            key: "backups",
            label: "Backups",
            description: "A nightly copy of the database and the uploads, and what to do with one.",
            href: "/settings/backups",
            icon: Archive,
            // The page requires backups.manage. Saying settings.manage got it exactly backwards:
            // offered to people it would refuse, hidden from the one person the key exists for.
            permission: "backups.manage",
          },
          {
            key: "maintenance",
            label: "Maintenance mode",
            description: "Take the app down for everybody but admins — now or at a time you choose — with a message.",
            href: "/settings/maintenance",
            icon: Wrench,
            permission: "settings.manage",
          },
        ],
      },
      {
        key: "mine",
        label: "Yours",
        items: [
          {
            key: "my-access",
            label: "What I can do",
            description: "Every permission this account holds, and where each one came from.",
            href: "/settings/my-access",
            icon: KeyRound,
            // Open to everybody: your own access is not an administrator’s to withhold, and until
            // this page existed most of the company had no way to find out what they were allowed
            // to do.
            permission: null,
          },
          {
            key: "profile",
            label: "My profile",
            description: "Your own name, photo, password and two-factor.",
            href: "/profile",
            icon: UserRound,
            permission: null,
            external: true,
          },
          {
            key: "notifications",
            label: "Notification preferences",
            description: "Which of the app's forty-odd notices reach you, and how.",
            href: "/notifications",
            icon: Banknote,
            permission: null,
            module: "notifications",
            external: true,
          },
        ],
      },
    ],
  },
];

/** Flattened, for lookups and for the checks. */
export const SETTINGS_ITEMS: SettingsItem[] = SETTINGS.flatMap((s) => s.groups.flatMap((g) => g.items));

/**
 * Whether somebody may open a settings destination.
 *
 * `permissionPrefix` exists for Import & export, which any one of ten `data.*` keys opens — an
 * accountant who may export statements is not an administrator, and gating it on the exact string
 * would hide it from the only person who wants it.
 */
export function mayOpen(item: SettingsItem, permissions: string[]): boolean {
  if (item.permission === null) return true;
  const wanted = Array.isArray(item.permission) ? item.permission : [item.permission];
  return item.permissionPrefix
    ? permissions.some((held) => wanted.some((w) => held.startsWith(w)))
    : wanted.some((w) => permissions.includes(w));
}

function moduleShown(item: SettingsItem, enabledModules: string[]): boolean {
  if (!item.module) return true;
  const wanted: readonly string[] = typeof item.module === "string" ? [item.module] : item.module;
  return wanted.some((key) => enabledModules.includes(key));
}

/** The catalogue as this person would see it: nothing they cannot open, nothing switched off. */
export function visibleSettings(permissions: string[], enabledModules: string[]): SettingsSection[] {
  return SETTINGS.map((section) => ({
    ...section,
    groups: section.groups
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (item) => mayOpen(item, permissions) && moduleShown(item, enabledModules),
        ),
      }))
      .filter((group) => group.items.length > 0),
  })).filter((section) => section.groups.length > 0);
}

/**
 * Which entry a path is looking at.
 *
 * Longest match wins, so `/settings/data` does not claim `/settings` — the same prefix problem the
 * main sidebar solves by special-casing `/settings`, solved here by length instead, which does not
 * need a special case for the next route that nests.
 */
export function activeSettingsKey(pathname: string): string | null {
  const matches = SETTINGS_ITEMS.filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  if (matches.length === 0) return null;
  return matches.reduce((best, i) => (i.href.length > best.href.length ? i : best)).key;
}

/**
 * The same filter, expressed as keys.
 *
 * An entry carries its icon as a React component, and a component is a function — which cannot be
 * sent from a server component to a client one. So the server works out *which* entries a person
 * may see and sends the keys; the sidebar imports this module itself and rebuilds the tree from
 * them. Nothing crosses the boundary but strings.
 */
export function visibleSettingsKeys(permissions: string[], enabledModules: string[]): string[] {
  return SETTINGS_ITEMS.filter(
    (item) => mayOpen(item, permissions) && moduleShown(item, enabledModules),
  ).map((item) => item.key);
}

/** The catalogue narrowed to a set of keys, with empty groups and sections dropped. */
export function settingsForKeys(keys: string[]): SettingsSection[] {
  const allowed = new Set(keys);
  return SETTINGS.map((section) => ({
    ...section,
    groups: section.groups
      .map((group) => ({ ...group, items: group.items.filter((i) => allowed.has(i.key)) }))
      .filter((group) => group.items.length > 0),
  })).filter((section) => section.groups.length > 0);
}
