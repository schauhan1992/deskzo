/**
 * What sits above what, decided once.
 *
 * Four different overlays were all `z-50` — dialogs, side panes, anchored popovers and the create
 * menu — so which one won was decided by DOM order rather than by anyone's intent. That works until
 * it does not, and the way it stops working is specific: `AnchoredPopover` and `CreateMenu` portal
 * themselves to `<body>`, while `Dialog` rendered in place. A dialog opened from inside the sticky
 * header inherited the header's stacking context, so its `z-50` only ever meant "z-50 within the
 * header" — and a menu portalled to the body at the same z-index painted straight over the top of
 * it. `create-menu.tsx` carries a comment describing exactly that, which is how a workaround in one
 * component becomes the documentation for a missing scale.
 *
 * Two rules are doing the work here:
 *
 *   1. **A popover sits above a modal.** It is always opened *from* something, so it must float
 *      over whatever that was. Raising dialogs above popovers would put a combobox's dropdown
 *      behind the dialog that contains it, which is the regression this ordering exists to avoid.
 *   2. **The DLP layers sit above everything.** The capture guard and the watermark are the two
 *      things whose entire purpose is that nothing can be put in front of them.
 *
 * Use these rather than a literal. A number typed at a call site is a number nobody can order
 * against the others.
 */

/**
 * A card in the corner that floats over the page without stopping work — today's wishes. Below a
 * splash, which is the one thing meant to interrupt.
 */
export const LAYER_CORNER = "z-[55]";

/** Full-screen interruptions — celebrations, survey prompts. Above the page, below anything modal. */
export const LAYER_SPLASH = "z-[60]";

/** Modal overlays: `Dialog`, `SidePane`, and their backdrops. */
export const LAYER_MODAL = "z-[70]";

/**
 * Anchored popovers, dropdowns and menus.
 *
 * Above modals on purpose — see rule 1. These portal to `<body>`, so without being above they would
 * lose to any modal regardless of which was opened first.
 */
export const LAYER_POPOVER = "z-[75]";

/**
 * The data-loss-prevention watermark and capture guard.
 *
 * Deliberately the top of the scale and deliberately not adjustable from a call site. A watermark
 * something can cover is not a watermark.
 */
export const LAYER_DLP_WATERMARK = "z-[80]";
export const LAYER_DLP_GUARD = "z-[90]";
