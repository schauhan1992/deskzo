/**
 * The contact form's rules, shared by the form (src/components/site/forms/contact-form.tsx) and the
 * action that checks them again (src/actions/platform/site.ts).
 */

export const CONTACT_TOPICS = ["demo", "sales", "support", "other"] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

export const CONTACT_LIMITS = { name: 120, company: 160, phone: 32, email: 254, messageMin: 10, message: 4000 } as const;

export type ContactField = "name" | "email" | "company" | "phone" | "topic" | "message";

export type ContactInput = {
  name: string;
  email: string;
  company: string;
  phone?: string;
  topic: string;
  message: string;
  /** Left empty by people; filled by bots that fill every field. */
  website?: string;
};

export type ContactResult = { ok: true } | { ok: false; error: string; field?: ContactField };
