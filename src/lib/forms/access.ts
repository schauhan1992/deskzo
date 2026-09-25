import type { Prisma } from "@prisma/client";

/**
 * Who may do what with one form.
 *
 * Four things, asked separately, because they are different trusts:
 *
 *   · **see** the form — its questions, its link, how many have answered;
 *   · **edit** it — change the questions and settings, open and close it;
 *   · **invite** — send personal invitations to customers and record an RSVP taken on the phone;
 *   · **read the responses** — every answer, every name, the attendance register, the export.
 *
 * The owner and anybody holding `forms.manageAll` can do all four, and are the only people who can
 * change who else may. Everybody else gets exactly what their grants say — to them by name, or to
 * their role — and holding any grant at all is what lets them see the form. The switches do not
 * imply one another: somebody can build an event's questions without reading who is coming, or
 * read a requirement assessment's answers without being able to change what it asks.
 *
 * Responses are the sensitive half. They are a customer's answers, usually about their own
 * business, and a grant to read them is a deliberate decision to share them — so it overrides the
 * account scope that governs the rest of the app, and nothing short of it does.
 *
 * Pure: the pages, the actions and `check:forms` all ask the same function.
 */

export type FormGrant = {
  userId: string | null;
  roleKey: string | null;
  canEdit: boolean;
  canViewResponses: boolean;
  canInvite: boolean;
};

export type FormAccess = {
  see: boolean;
  edit: boolean;
  invite: boolean;
  responses: boolean;
  /** Change who else may do these. The owner and forms admins only. */
  share: boolean;
  /** Why — shown on the sharing panel so nobody wonders how somebody got in. */
  via: "owner" | "admin" | "grant" | null;
};

export const NO_ACCESS: FormAccess = { see: false, edit: false, invite: false, responses: false, share: false, via: null };
const FULL = (via: "owner" | "admin"): FormAccess => ({ see: true, edit: true, invite: true, responses: true, share: true, via });

export type FormViewer = { id: string; role: string; manageAll: boolean };

/** The grants that apply to this person: theirs by name, and their role's. */
export function grantsFor<G extends FormGrant>(viewer: Pick<FormViewer, "id" | "role">, grants: G[]): G[] {
  return grants.filter((g) => (g.userId !== null && g.userId === viewer.id) || (g.roleKey !== null && g.roleKey === viewer.role));
}

export function formAccessFor(viewer: FormViewer, form: { ownerUserId: string; grants: FormGrant[] }): FormAccess {
  if (form.ownerUserId === viewer.id) return FULL("owner");
  if (viewer.manageAll) return FULL("admin");

  const mine = grantsFor(viewer, form.grants);
  if (mine.length === 0) return NO_ACCESS;
  // A person grant and a role grant together give the more generous of each switch — the same as
  // two permissions from two places anywhere else in the app.
  return {
    see: true,
    edit: mine.some((g) => g.canEdit),
    invite: mine.some((g) => g.canInvite),
    responses: mine.some((g) => g.canViewResponses),
    share: false,
    via: "grant",
  };
}

type GrantFlag = "canEdit" | "canViewResponses" | "canInvite";

/**
 * The forms this person can see — or, with a flag, the ones where that switch is on for them — as a
 * query, so a list is filtered in the database rather than loaded whole and thrown away.
 *
 * Must agree with `formAccessFor`. `check:forms` holds the two against each other.
 */
export function formsWhere(viewer: FormViewer, flag?: GrantFlag): Prisma.InboundFormWhereInput {
  if (viewer.manageAll) return {};
  const mine: Prisma.FormAccessGrantWhereInput = { OR: [{ userId: viewer.id }, { roleKey: viewer.role }] };
  return {
    OR: [{ ownerUserId: viewer.id }, { grants: { some: flag ? { AND: [mine, { [flag]: true }] } : mine } }],
  };
}

/**
 * A grant as the sharing panel sends it, checked.
 *
 * A grant with every switch off still means "may see it", which is a real and useful level — so an
 * all-off row is kept, not dropped. What is refused is a row that names nobody, or both a person and
 * a role at once (the database refuses that too).
 */
export function cleanGrants(
  input: { userId?: string | null; roleKey?: string | null; canEdit?: boolean; canViewResponses?: boolean; canInvite?: boolean }[],
  ownerUserId: string,
): { ok: true; grants: FormGrant[] } | { ok: false; error: string } {
  const out: FormGrant[] = [];
  const users = new Set<string>();
  const roles = new Set<string>();
  for (const row of input) {
    const userId = row.userId?.trim() || null;
    const roleKey = row.roleKey?.trim() || null;
    if ((userId === null) === (roleKey === null)) return { ok: false, error: "Each row is for one person or one role." };
    // The owner can already do everything. A row for them would only ever take something away in
    // somebody's reading of the panel, never in fact.
    if (userId === ownerUserId) continue;
    if (userId) {
      if (users.has(userId)) return { ok: false, error: "The same person is listed twice." };
      users.add(userId);
    }
    if (roleKey) {
      if (roles.has(roleKey)) return { ok: false, error: "The same role is listed twice." };
      roles.add(roleKey);
    }
    out.push({
      userId,
      roleKey,
      canEdit: row.canEdit === true,
      canViewResponses: row.canViewResponses === true,
      canInvite: row.canInvite === true,
    });
  }
  return { ok: true, grants: out };
}
