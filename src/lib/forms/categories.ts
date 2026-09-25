import type { FormCategory, FormFillMode, MarketingTopic } from "@prisma/client";
import type { FormField } from "@/lib/marketing/form-fields";

/**
 * The kinds of form, and what each starts with.
 *
 * A category is more than a label on the list. It picks the starter questions, the sensible
 * defaults — an event is invitation-and-link and makes no lead, an enquiry is a public link that
 * does — and, for EVENT alone, turns on the date, the venue, the RSVP and the attendance register.
 * Everything a category sets can be changed afterwards; the starter is a head start, not a rule.
 *
 * Pure, and importable from the builder on the client, which renders the same list.
 */

export type CategoryDefinition = {
  key: FormCategory;
  label: string;
  /** One line for the picker. */
  blurb: string;
  defaults: {
    fillMode: FormFillMode;
    createsLead: boolean;
    topic: MarketingTopic;
    headline: string;
    intro: string;
    thankYouText: string;
  };
  starter: FormField[];
  /** The invitation's wording, before anybody edits it. Merge fields as the templates use them. */
  invitation: { subject: string; body: string };
};

const f = (
  key: string,
  label: string,
  type: FormField["type"],
  extra: Partial<Omit<FormField, "key" | "label" | "type">> = {},
): FormField => ({
  key,
  label,
  type,
  required: extra.required ?? false,
  options: extra.options ?? [],
  placeholder: extra.placeholder ?? null,
  help: extra.help ?? null,
});

const heading = (key: string, label: string, help?: string): FormField => f(key, label, "HEADING", { help });

/** Who they are — the same four at the top of every starter, because the submit path needs them. */
const whoTheyAre = (companyRequired: boolean): FormField[] => [
  f("name", "Your name", "TEXT", { required: true }),
  f("email", "Work email", "EMAIL", { required: true }),
  f("companyName", "Company", "TEXT", { required: companyRequired }),
  f("phone", "Phone", "PHONE"),
];

const SIGN_OFF = `

Thanks,
{{inviterName|The team}}
{{ourName}}

{{postalAddress|}}
Manage what we send you: {{unsubscribeUrl}}`;

export const FORM_CATEGORIES: CategoryDefinition[] = [
  {
    key: "EVENT",
    label: "Event or roundtable",
    blurb: "A customer roundtable, a launch, a webinar. Invitations, RSVPs and who actually came.",
    defaults: {
      fillMode: "BOTH",
      createsLead: false,
      topic: "EVENTS",
      headline: "Customer roundtable",
      intro: "A small, closed-door conversation with peers about what is working, what isn't, and what is next.",
      thankYouText: "Thank you — your place is confirmed. We'll send a reminder closer to the day.",
    },
    starter: [
      ...whoTheyAre(true),
      f("designation", "Your role", "TEXT", { placeholder: "IT Head, CFO, Director…" }),
      heading("aboutSession", "About the session", "Helps us shape the conversation around what you care about."),
      f("interests", "What would you like to discuss?", "MULTISELECT", {
        options: [
          "Microsoft 365 and Copilot",
          "Security and compliance",
          "Cloud and infrastructure",
          "Design software (Autodesk, Adobe)",
          "Devices and hardware refresh",
          "Licensing and cost control",
        ],
      }),
      f("panelQuestion", "Anything you'd like the panel to cover?", "TEXTAREA"),
      f("dietary", "Dietary preference", "SELECT", { options: ["Vegetarian", "Non-vegetarian", "Vegan", "Jain"] }),
    ],
    invitation: {
      subject: "You're invited: {{formName}}",
      body: `Hi {{firstName|there}},

We'd like you to join us for {{formName}}.

  When   {{eventDate|to be confirmed}}
  Where  {{eventVenue|to be confirmed}}

Seats are limited, so please let us know whether you can make it — it takes a minute:
{{formLink}}${SIGN_OFF}`,
    },
  },
  {
    key: "ASSESSMENT",
    label: "Requirement assessment",
    blurb: "What a customer runs today and what they need next — the questions before a proposal.",
    defaults: {
      fillMode: "BOTH",
      createsLead: true,
      topic: "OFFERS",
      headline: "IT requirement assessment",
      intro: "Ten minutes now saves a week of back-and-forth later. Answer what you can — rough is fine.",
      thankYouText: "Thank you. Your account manager will go through this and come back with a recommendation.",
    },
    starter: [
      ...whoTheyAre(true),
      f("designation", "Your role", "TEXT"),
      heading("organisation", "Your organisation"),
      f("employees", "How many people use a computer at work?", "NUMBER", { required: true }),
      f("sites", "How many offices or sites?", "NUMBER"),
      heading("today", "What you run today"),
      f("currentSuite", "Email and office suite", "RADIO", {
        options: ["Microsoft 365", "Google Workspace", "On-premises Exchange / Office", "Something else, or none"],
      }),
      f("licences", "Licences you hold today", "TEXTAREA", { help: "Product and seat count, as far as you know — e.g. M365 Business Standard × 40." }),
      f("renewalDate", "When is your next renewal?", "DATE"),
      heading("needs", "What you need"),
      f("needAreas", "Which of these are on the table?", "MULTISELECT", {
        required: true,
        options: [
          "New licences or more seats",
          "Migration (e.g. Google to Microsoft)",
          "Security and backup",
          "Laptops, desktops and devices",
          "Design software (Autodesk, Adobe)",
          "Managed support or AMC",
          "Network and Wi-Fi",
        ],
      }),
      f("requirement", "Describe the requirement", "TEXTAREA", { required: true }),
      f("budget", "Budget", "SELECT", { options: ["Under ₹1 lakh", "₹1–5 lakh", "₹5–25 lakh", "Over ₹25 lakh", "Not decided yet"] }),
      f("timeline", "When do you need it?", "SELECT", { options: ["This month", "Within 3 months", "3 to 6 months", "Just exploring"] }),
      f("decisionMaker", "Who signs off?", "RADIO", { options: ["Me", "My manager or IT head", "Finance or procurement", "A committee"] }),
    ],
    invitation: {
      subject: "A few questions before we put a proposal together",
      body: `Hi {{firstName|there}},

So that what we propose fits what {{companyName}} actually runs, could you answer a few questions? It takes about ten minutes, and rough answers are fine:
{{formLink}}${SIGN_OFF}`,
    },
  },
  {
    key: "ENQUIRY",
    label: "Enquiry",
    blurb: "A public “get in touch” form. Every answer becomes a lead for somebody to pick up.",
    defaults: {
      fillMode: "LINK",
      createsLead: true,
      topic: "OFFERS",
      headline: "Talk to us",
      intro: "Tell us what you need and the right person will get back to you.",
      thankYouText: "Thank you — somebody will be in touch.",
    },
    starter: [...whoTheyAre(false), f("message", "What do you need?", "TEXTAREA")],
    invitation: {
      subject: "{{formName}}",
      body: `Hi {{firstName|there}},

{{formLink}}${SIGN_OFF}`,
    },
  },
  {
    key: "SURVEY",
    label: "Survey",
    blurb: "Ask customers something and count the answers — satisfaction, priorities, a quick poll.",
    defaults: {
      fillMode: "BOTH",
      createsLead: false,
      topic: "NEWSLETTER",
      headline: "Two minutes of your time",
      intro: "Your answers go straight to the people who can act on them.",
      thankYouText: "Thank you — that genuinely helps.",
    },
    starter: [
      ...whoTheyAre(false),
      f("overall", "How are we doing overall?", "RATING", { required: true }),
      f("bestThing", "What should we keep doing?", "TEXTAREA"),
      f("improve", "What should we do better?", "TEXTAREA"),
    ],
    invitation: {
      subject: "Two minutes: {{formName}}",
      body: `Hi {{firstName|there}},

Could you spare two minutes to tell us how we're doing? We read every answer:
{{formLink}}${SIGN_OFF}`,
    },
  },
  {
    key: "OTHER",
    label: "Something else",
    blurb: "A blank form with just a name and an email. Build the rest yourself.",
    defaults: {
      fillMode: "LINK",
      createsLead: false,
      topic: "OFFERS",
      headline: "",
      intro: "",
      thankYouText: "Thank you.",
    },
    starter: [f("name", "Your name", "TEXT", { required: true }), f("email", "Work email", "EMAIL", { required: true })],
    invitation: {
      subject: "{{formName}}",
      body: `Hi {{firstName|there}},

{{formLink}}${SIGN_OFF}`,
    },
  },
];

export const CATEGORY_KEYS = FORM_CATEGORIES.map((c) => c.key);

export function categoryOf(key: FormCategory): CategoryDefinition {
  return FORM_CATEGORIES.find((c) => c.key === key) ?? FORM_CATEGORIES[FORM_CATEGORIES.length - 1]!;
}

export const FILL_MODES: { key: FormFillMode; label: string; blurb: string }[] = [
  { key: "LINK", label: "Anyone with the link", blurb: "Share it anywhere — a website, a post, a WhatsApp group." },
  { key: "INVITE", label: "Invited people only", blurb: "Only the personal links you send work. The public address says it isn't available." },
  { key: "BOTH", label: "Both", blurb: "Personal invitations to the people you choose, and a link for everyone else." },
];

export function allowsLink(mode: FormFillMode): boolean {
  return mode === "LINK" || mode === "BOTH";
}

export function allowsInvites(mode: FormFillMode): boolean {
  return mode === "INVITE" || mode === "BOTH";
}
