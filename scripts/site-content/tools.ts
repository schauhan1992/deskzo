import type { SiteBlock } from "../../src/components/site/blocks/types";
import { h3, p, related, runs, ul } from "./_build";
import type { SeedPage, SeedSection } from "./types";

/**
 * The website's free tools — today, the email signature generator (owner, 10 Oct 2026: a free version
 * for anybody, which leads to the paid Signatures product). The generator is a block
 * (src/components/site/signature-generator.tsx); the words around it are here, true of what it does:
 * it runs in the visitor's browser, keeps nothing, and its signature carries a "Made with" credit.
 */

const header: SiteBlock = {
  id: "signature-header",
  type: "pageHeader",
  props: {
    eyebrow: "Free tool",
    heading: "Free email signature generator",
    intro:
      "This free email signature generator makes a professional signature for Gmail, Outlook and Apple Mail in a minute: your name, title, phone, photo or logo, social profiles and a button, in your colours. Fill it in, copy it, paste it into your email settings. No sign-up, and nothing you type leaves your browser.",
  },
};

const generator: SiteBlock = {
  id: "signature-generator",
  type: "signatureGenerator",
  props: {
    upsellHeading: "Signatures for your whole team",
    upsellBody:
      "{siteName} Signatures keeps one design for everybody, fills each person's details in from their record, and puts every signature into their Gmail or Zoho Mail — changed there when their details change.",
    upsellAction: { kind: "link", label: "See Deskzo Signatures", href: "/signatures" },
    privacyNote: "Nothing you type here is sent to us or kept: the signature is made in your browser. Pictures you pick from your computer stay in it too.",
  },
};

const advice: SiteBlock = {
  id: "signature-advice",
  type: "richText",
  props: {
    heading: "What makes a good email signature",
    content: [
      p("A good email signature tells people who you are and how to reach you, in a few lines that look the same in every mail program. Keep it short, keep it readable, and make the links work."),
      h3("What should an email signature include?"),
      ul(
        "Your name, job title and company — the three things people look for first.",
        "One or two ways to reach you: a phone number and your website. Your email address is already on the message.",
        "A photo or a logo, small, if it helps people place you.",
        "Social profiles that are about your work, such as LinkedIn.",
        "At most one button — book a meeting, see a demo — and only if you want people to press it.",
      ),
      h3("Why doesn't my picture show in Gmail?"),
      p(
        "Gmail doesn't show a picture that is inside the signature itself, which is what picking a file from your computer does. Put the picture on your website and use its address (starting https://) instead: Gmail, Outlook and Apple Mail all show a picture from a link.",
      ),
      h3("How long can a signature be?"),
      p(runs("Gmail takes a signature of up to 10,000 characters of HTML. The generator counts them as you go, and a picked picture is usually what makes one too long.")),
      h3("Should I add a legal disclaimer?"),
      p("Some companies and industries ask for one. If yours does, add it in Extras; it goes under the signature in small type. Keep it as short as your rules allow."),
    ],
  },
};

const faq: SiteBlock = {
  id: "signature-faq",
  type: "faq",
  props: {
    heading: "Questions about the signature generator",
    items: [
      { question: "Is the email signature generator free?", answer: ["Yes. Make as many signatures as you like, with no account and no trial. Each one carries a small “Made with {siteName}” line at the bottom."] },
      { question: "Is what I type kept anywhere?", answer: ["No. The signature is made in your browser and nothing you type is sent to us. Close the page and it is gone, so copy or download your signature first."] },
      { question: "Which email programs does it work with?", answer: ["Gmail, Outlook (the new one, the web one and classic Outlook for Windows), Apple Mail and most others that take a pasted signature. The steps for each are beside the preview."] },
      { question: "Can I remove the “Made with” line?", answer: ["Not from the free signature. Signatures made by {siteName} Signatures, for a whole team, carry no credit line."] },
      { question: "Can my whole company use the same design?", answer: ["Each person can make their own here with the same colour and layout. {siteName} Signatures keeps one design for everybody, fills each person's details in from their record, and puts the signatures into their Gmail or Zoho Mail for them."] },
    ],
  },
};

const PAGE: SeedPage = {
  slug: "email-signature-generator",
  document: {
    title: "Email signature generator",
    seo: {
      title: "Free email signature generator for Gmail and Outlook",
      description: "A free email signature generator: make a professional signature for Gmail, Outlook and Apple Mail with your photo, logo and links. No sign-up; nothing is stored.",
      keywords: ["free email signature generator", "email signature for Gmail", "Outlook email signature"],
    },
    blocks: [
      header,
      generator,
      advice,
      faq,
      related(
        "signature-related",
        "Also from {siteName}",
        ["/signatures", "/cards", "/crm", "/resources"],
        "A digital business card goes well with a signature: both say who you are, and the card collects the people you meet.",
      ),
    ],
  },
};

export const section: SeedSection = { name: "Tools", pages: [PAGE] };
