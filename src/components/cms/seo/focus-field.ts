/**
 * Jumping from an SEO check to the field it is about. The editors mark the fields a check can name
 * with `data-field-path` ("seo.description", "seo.keywords[1]", "slug", "coverMediaId"); a block is
 * found by its card (`data-block-card`). The editor switches to the tab that holds it first, then —
 * once that tab has rendered — calls this to bring the field into view and put the cursor in it.
 *
 * Browser-only: call it from an event handler or an effect, never while rendering.
 */

const FOCUSABLE = 'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

const visible = (el: Element) => !el.closest("[hidden]") && (el as HTMLElement).getClientRects().length > 0;

/** "seo.keywords[1]" → itself, "seo.keywords", then "seo": the nearest field that is marked. */
function candidates(path: string): string[] {
  const out: string[] = [];
  let p = path;
  while (p) {
    out.push(p);
    const stripped = p.replace(/\[[^\]]*\]$/, "");
    p = stripped !== p ? stripped : p.includes(".") ? p.slice(0, p.lastIndexOf(".")) : "";
  }
  return out;
}

function flash(el: HTMLElement) {
  try {
    el.animate([{ boxShadow: "0 0 0 3px var(--focus)" }, { boxShadow: "0 0 0 3px transparent" }], { duration: 1600, easing: "ease-out" });
  } catch {
    // No Web Animations: the focus ring alone says where it is.
  }
}

function land(target: HTMLElement) {
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  const control = target.matches(FOCUSABLE) ? target : target.querySelector<HTMLElement>(FOCUSABLE);
  if (control && visible(control)) control.focus({ preventScroll: true });
  else {
    // Read-only (a disabled fieldset) or not a control at all: the field's own box takes the focus.
    if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  flash(target);
}

/** Brings the marked field into view and focuses it. `within` narrows the search (a dialog). False when nothing matched. */
export function focusFieldPath(path: string, within: ParentNode = document): boolean {
  for (const p of candidates(path)) {
    const matches = [...within.querySelectorAll<HTMLElement>("[data-field-path]")].filter((el) => el.dataset.fieldPath === p && visible(el));
    if (matches[0]) {
      land(matches[0]);
      return true;
    }
  }
  return false;
}

/** Focuses a block's card — its open/close button — once the block list has brought it into view. */
export function focusBlockCard(blockId: string): boolean {
  const card = [...document.querySelectorAll<HTMLElement>("[data-block-card]")].find((el) => el.dataset.blockCard === blockId);
  if (!card) return false;
  card.querySelector<HTMLElement>("[data-action=toggle]")?.focus({ preventScroll: true });
  flash(card);
  return true;
}
