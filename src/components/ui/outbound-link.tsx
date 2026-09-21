import type { AnchorHTMLAttributes } from "react";

/**
 * A link that leaves the ERP — a customer's website, their LinkedIn, a WhatsApp thread.
 *
 * Every one of them is stripped of its referrer. Without that, following a link from a company
 * record hands the far end a `Referer` of something like `/companies/clx…?tab=domain`, which tells
 * a prospect's web server — and their analytics, and anyone who later reads those logs — that
 * somebody at Wroffy was looking at them and roughly what they were looking at. On a LinkedIn
 * profile or a competitor's site that is genuinely sensitive: it is our pipeline leaking out
 * through a request header.
 *
 * Both `rel="noreferrer"` and `referrerPolicy` are set. `noreferrer` is the one that matters and
 * carries `noopener` with it in current browsers; the policy attribute is written out as well
 * because embedded webviews are inconsistent about which of the two they honour, and because it
 * survives someone later editing `rel` to add `nofollow` and dropping a word by accident.
 *
 * Use this for anything with an off-site `href`. Internal navigation is `next/link`.
 */
export function OutboundLink({
  href,
  children,
  ...rest
}: { href: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "rel" | "target" | "referrerPolicy">) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" {...rest}>
      {children}
    </a>
  );
}

/**
 * Makes a typed-in address safe to put in an href.
 *
 * These are entered by hand, so "www.acme.co.in" and "acme.co.in" are both common — and a bare
 * value with no scheme is treated by the browser as a path on this site, which quietly turns an
 * outbound link into a broken internal one.
 */
export function externalHref(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Anything that still has no dot was never an address — better no link than a broken one.
  if (!trimmed.includes(".")) return null;
  return `https://${trimmed}`;
}

/**
 * A WhatsApp thread with a number as it was typed, digits only — wa.me rejects anything else.
 *
 * The optional message is here rather than in the calling component so that the wa.me address
 * exists in exactly one place. Written out anywhere else it escapes the referrer guarantee this
 * file is responsible for, and `npm run check:links` will say so.
 */
export function whatsappHref(phone: string, message?: string) {
  const thread = `https://wa.me/${phone.replace(/[^0-9]/g, "")}`;
  return message ? `${thread}?text=${encodeURIComponent(message)}` : thread;
}
