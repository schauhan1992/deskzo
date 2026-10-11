/**
 * What replies and forwards carry, where the mail program can tell them from a new message (Outlook's
 * add-in): the whole signature, a short one, or none. Gmail and Zoho Mail keep one signature for both.
 * Pure, so the template editor in the browser and the server read the same list.
 */
export const REPLY_STYLES = [
  { key: "FULL", label: "The whole signature" },
  { key: "SHORT", label: "A short one — name, title, company and phone" },
  { key: "NONE", label: "None" },
] as const;
export type ReplyStyle = (typeof REPLY_STYLES)[number]["key"];
