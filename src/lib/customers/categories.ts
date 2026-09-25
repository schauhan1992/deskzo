import { CATEGORY_ICONS, DEFAULT_CATEGORY_COLOR, DEFAULT_CATEGORY_ICON } from "@/lib/customers/category-icons";

/**
 * Customer categories — where a customer sits, so everybody who deals with them knows who they are
 * and how to treat them. No database in here.
 *
 * Two levels: a category ("Strategic") and, under it, sub-categories ("Key account"). A customer sits
 * in one node — a category, or one of its sub-categories — and shows as a chip beside their name:
 * the icon and colour, "Strategic › Key account", and the handling notes under it on their page.
 *
 * A sub-category may leave its icon and colour empty and wear its category's, and its handling note
 * is read after its category's rather than instead of it: "a Strategic account" is always true of a
 * key account, and the key-account note says what is true on top of that.
 */

export const MAX_CATEGORY_NAME = 40;
export const MAX_CATEGORY_GUIDANCE = 400;

/** The columns a chip needs — select this wherever a company's category is shown. */
export const CATEGORY_SELECT = {
  id: true,
  name: true,
  icon: true,
  color: true,
  guidance: true,
  parent: { select: { id: true, name: true, icon: true, color: true, guidance: true } },
} as const;

type Node = { id: string; name: string; icon: string | null; color: string | null; guidance: string | null };
export type CategoryWithParent = Node & { parent: Node | null };

/** What a chip shows: everything already resolved from the category it belongs to. */
export type CategoryView = {
  id: string;
  /** "Strategic › Key account", or just "Strategic". */
  label: string;
  name: string;
  parentName: string | null;
  icon: string;
  color: string;
  /** The category's note, then the sub-category's — whichever are written. */
  guidance: string[];
};

export function resolveCategory(c: CategoryWithParent | null | undefined): CategoryView | null {
  if (!c) return null;
  const p = c.parent;
  return {
    id: c.id,
    label: p ? `${p.name} › ${c.name}` : c.name,
    name: c.name,
    parentName: p?.name ?? null,
    icon: c.icon ?? p?.icon ?? DEFAULT_CATEGORY_ICON,
    color: c.color ?? p?.color ?? DEFAULT_CATEGORY_COLOR,
    guidance: [p?.guidance, c.guidance].filter((g): g is string => !!g && g.trim().length > 0),
  };
}

// ─── The tree ────────────────────────────────────────────────────────────────

export type FlatCategory = Node & { parentId: string | null; sortOrder: number };
export type CategoryTree<T extends FlatCategory = FlatCategory> = T & { children: T[] };

const byOrder = (a: FlatCategory, b: FlatCategory) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

export function categoryTree<T extends FlatCategory>(rows: T[]): CategoryTree<T>[] {
  return rows
    .filter((r) => !r.parentId)
    .sort(byOrder)
    .map((top) => ({ ...top, children: rows.filter((r) => r.parentId === top.id).sort(byOrder) }));
}

/**
 * The choices for a list's category filter: each category (which takes in its sub-categories), each
 * sub-category on its own, and the customers in none.
 */
export function categoryFilterOptions(tree: CategoryTree[]): { value: string; label: string }[] {
  return [
    ...tree.flatMap((top) => [{ value: top.id, label: top.name }, ...top.children.map((c) => ({ value: c.id, label: `${top.name} › ${c.name}` }))]),
    { value: "none", label: "No category" },
  ];
}

/** A category and everything under it — what "customers in Strategic" means for a filter. */
export function categoryAndChildren(id: string, rows: Pick<FlatCategory, "id" | "parentId">[]): string[] {
  return [id, ...rows.filter((r) => r.parentId === id).map((r) => r.id)];
}

// ─── Checking what somebody typed ────────────────────────────────────────────

const HEX = /^#[0-9a-f]{6}$/i;

export function checkCategory(
  input: { id?: string; parentId: string | null; name: string; icon: string | null; color: string | null; guidance: string | null },
  context: {
    /** Every category, as it stands now. */
    rows: Pick<FlatCategory, "id" | "parentId" | "name">[];
  },
): { ok: true; value: { parentId: string | null; name: string; icon: string | null; color: string | null; guidance: string | null } } | { ok: false; error: string } {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "Give it a name." };
  if (name.length > MAX_CATEGORY_NAME) return { ok: false, error: `Keep the name to ${MAX_CATEGORY_NAME} characters — the chip has to fit beside a customer's name.` };
  if (name.includes("›")) return { ok: false, error: "A name can't contain ›  — that's what separates a category from its sub-category." };

  const parentId = input.parentId || null;
  if (parentId) {
    const parent = context.rows.find((r) => r.id === parentId);
    if (!parent) return { ok: false, error: "That category isn't there any more." };
    if (parent.parentId) return { ok: false, error: "Sub-categories go one level deep — put this under a category, not a sub-category." };
    if (input.id && parent.id === input.id) return { ok: false, error: "A category can't sit under itself." };
    if (input.id && context.rows.some((r) => r.parentId === input.id)) {
      return { ok: false, error: "This category has sub-categories of its own, so it can't become one. Move or delete them first." };
    }
  }

  const clash = context.rows.find((r) => r.id !== input.id && (r.parentId ?? null) === parentId && r.name.toLowerCase() === name.toLowerCase());
  if (clash) return { ok: false, error: parentId ? `There's already a “${name}” under that category.` : `There's already a category called “${name}”.` };

  const icon = input.icon || null;
  if (icon && !CATEGORY_ICONS[icon]) return { ok: false, error: "Pick one of the icons offered." };
  if (!parentId && !icon) return { ok: false, error: "A category needs an icon — its sub-categories can borrow it." };

  const color = input.color || null;
  if (color && !HEX.test(color)) return { ok: false, error: "Pick one of the colours offered." };
  if (!parentId && !color) return { ok: false, error: "A category needs a colour — its sub-categories can borrow it." };

  const guidance = input.guidance?.trim() || null;
  if (guidance && guidance.length > MAX_CATEGORY_GUIDANCE) return { ok: false, error: `Keep the handling note to ${MAX_CATEGORY_GUIDANCE} characters — it is read at a glance.` };

  return { ok: true, value: { parentId, name, icon, color: color?.toLowerCase() ?? null, guidance } };
}
