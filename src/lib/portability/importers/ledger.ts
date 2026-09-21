import { AccountType } from "@prisma/client";
import { db } from "@/lib/db";
import {
  createRow,
  diff,
  errorRow,
  updateRow,
  RowReader,
  type Importer,
  type ImportContext,
  type Resolved,
} from "./types";

/**
 * The chart of accounts. Journal entries are not importable.
 *
 * A ledger account is a description of how the books are arranged, and a description can legitimately
 * arrive from outside — that is the test areas.ts applies. A journal entry fails it: it is one
 * balanced posting the system made for a document that existed, and an entry typed into a spreadsheet
 * balances against nothing and records something that never happened. entities.ts already files
 * JournalEntry and JournalLine as "archive" on the same reasoning. So the ledger area imports
 * accounts and nothing else; history is carried in the archive bundle, not reconstructed here.
 *
 * ## systemKey is the dangerous field, and it is not here
 *
 * `systemKey` is how the posting engine finds the account it needs — the receivables account, the
 * bank account, the output tax accounts — without depending on a code or a name a business will
 * change. Accept it from a file and one mistyped cell moves "AR" onto the wrong row, after which
 * every invoice posts to the wrong account, silently, until somebody reads a trial balance months
 * later. It is not in `templateColumns`, the exporter does not write it, and a file that carries the
 * column at all is refused row by row with the reason rather than having it quietly ignored. Setting
 * it is a deliberate act on the account's own screen.
 *
 * ## Parents
 *
 * Parent is another account's code, resolved against what already exists — an unknown one is an error
 * rather than a new stub, because a chart with an invented group in it reads as correct and reports
 * wrongly. A parent that already sits underneath this account is refused too: the tree is walked to
 * the top before the change is accepted, since an account that is its own ancestor makes every report
 * that reads the hierarchy recurse forever, and a spreadsheet is the easiest way to create one by
 * accident when two rows swap places.
 *
 * A file that introduces a group and its children together still loads in one pass, because a row may
 * name a parent an *earlier* row in the same file will create — see `pendingKeys` on `ImportContext`.
 * That is what an exported chart looks like, so anything else would mean our own export could not be
 * loaded back. A forward reference is still refused: nothing guarantees the later row is valid, and
 * the alternative — a stub created hopefully — is the invented group above.
 */

type ExistingAccount = {
  id: string;
  name: string;
  type: AccountType;
  parentCode: string;
  isGroup: boolean;
  active: boolean;
  description: string;
  hasSystemKey: boolean;
};

type ResolvedAccount = {
  code: string;
  name?: string;
  type?: AccountType;
  parentId?: string;
  parentCode?: string;
  isGroup?: boolean;
  active?: boolean;
  description?: string;
  existing?: ExistingAccount;
};

/** True when `ancestorId` appears anywhere up the parent chain from `startId`, including itself. */
async function hasAncestor(startId: string, ancestorId: string): Promise<boolean> {
  const seen = new Set<string>();
  let current: string | null = startId;
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    const node: { parentId: string | null } | null = await db.ledgerAccount.findUnique({
      where: { id: current },
      select: { parentId: true },
    });
    current = node?.parentId ?? null;
  }
  return false;
}

/** Whatever somebody's spreadsheet calls it — "System key", "system_key", "systemKey". */
function systemKeyColumn(row: Record<string, string>): string | undefined {
  return Object.keys(row).find((c) => c.trim().toLowerCase().replace(/[\s_-]+/g, "") === "systemkey");
}

async function resolve(row: Record<string, string>, ctx: ImportContext): Promise<Resolved<ResolvedAccount>> {
  const forbidden = systemKeyColumn(row);
  if (forbidden) {
    return {
      error: `The "${forbidden}" column can't be imported. A system key is how the application finds the account it posts to — receivables, bank, output tax — so a wrong one misroutes every future posting without any error. Delete the column and set the key on the account's own screen if it needs changing.`,
    };
  }

  const r = new RowReader(row);
  const code = r.text("Code");
  if (!code) return { error: "Code is required." };

  const type = r.enum("Type", AccountType);
  const isGroup = r.boolean("Group");
  const active = r.boolean("Active");
  if (r.error) return { error: r.error };

  const found = await db.ledgerAccount.findUnique({
    where: { code },
    include: { parent: { select: { code: true } } },
  });
  const existing: ExistingAccount | undefined = found
    ? {
        id: found.id,
        name: found.name,
        type: found.type,
        parentCode: found.parent?.code ?? "",
        isGroup: found.isGroup,
        active: found.active,
        description: found.description ?? "",
        hasSystemKey: found.systemKey !== null,
      }
    : undefined;

  const name = r.text("Name") || undefined;
  if (!existing && !name) return { error: `Name is required on a new account (Code ${code}).` };
  if (!existing && !type) {
    return { error: `Type is required on a new account (Code ${code}). One of: ${Object.keys(AccountType).join(", ")}.` };
  }

  const parentCode = r.text("Parent") || undefined;
  let parentId: string | undefined;
  if (parentCode) {
    if (parentCode === code) return { error: `${code} is listed as its own Parent.` };
    const parent = await db.ledgerAccount.findUnique({ where: { code: parentCode }, select: { id: true } });
    if (!parent) {
      // An exported chart lists every parent above its children, so a code we have not stored yet
      // may still be arriving two rows up. Only earlier rows count — see ImportContext. The id is
      // left unset: by the time apply() re-reads this row the parent has been written, and this
      // same lookup finds it.
      if (!ctx.pendingKeys.has(parentCode)) {
        return { error: `No ledger account with code "${parentCode}" (Parent). Import the parent account first, or correct the code.` };
      }
    } else {
      if (existing && (await hasAncestor(parent.id, existing.id))) {
        return { error: `Parent "${parentCode}" already sits underneath ${code}, so this would make the account its own ancestor.` };
      }
      parentId = parent.id;
    }
  }

  // Deactivating an account the posting engine looks up by key stops future postings dead, and the
  // failure surfaces on somebody's invoice rather than here. Note what is being refused: the *edit*,
  // not the value. An account somebody has already deactivated on its own screen exports as
  // `Active=false`, and refusing that row when it is handed straight back would break the round trip
  // over a change nobody is asking for.
  if (existing?.hasSystemKey && active === false && existing.active) {
    return { error: `${code} carries a system key, so the application posts to it. Deactivating it from a spreadsheet would stop those postings — do it on the account's own screen if that is really the intent.` };
  }

  return {
    value: {
      code,
      name,
      type,
      parentId,
      parentCode,
      isGroup,
      active,
      description: r.text("Description") || undefined,
      existing,
    },
  };
}

export const ledgerImporter: Importer = {
  templateColumns: ["Code", "Name", "Type", "Parent", "Group", "Active", "Description"],

  async plan(row, line, ctx) {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) return errorRow(line, row.Code || row.Name || "", resolved.error);
    const a = resolved.value;
    const label = `${a.code} ${a.name ?? a.existing?.name ?? ""}`.trim();

    if (!a.existing) {
      return createRow(line, a.code, label, {
        Code: a.code,
        Name: a.name,
        Type: a.type,
        Parent: a.parentCode,
        Group: a.isGroup,
        Active: a.active,
        Description: a.description,
      });
    }

    const was = a.existing;
    return updateRow(line, a.code, label, [
      a.name ? diff("Name", was.name, a.name) : null,
      a.type ? diff("Type", was.type, a.type) : null,
      a.parentCode ? diff("Parent", was.parentCode, a.parentCode) : null,
      a.isGroup !== undefined ? diff("Group", was.isGroup, a.isGroup) : null,
      a.active !== undefined ? diff("Active", was.active, a.active) : null,
      a.description ? diff("Description", was.description, a.description) : null,
    ]);
  },

  async apply(row, ctx) {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) throw new Error(resolved.error);
    const a = resolved.value;

    const data = {
      ...(a.name ? { name: a.name } : {}),
      ...(a.type ? { type: a.type } : {}),
      ...(a.parentId ? { parentId: a.parentId } : {}),
      ...(a.isGroup !== undefined ? { isGroup: a.isGroup } : {}),
      ...(a.active !== undefined ? { active: a.active } : {}),
      ...(a.description ? { description: a.description } : {}),
    };

    if (a.existing) {
      await db.ledgerAccount.update({ where: { id: a.existing.id }, data });
      return;
    }

    // resolve() has already refused a new account without a name or a type. systemKey is absent by
    // construction: a new account carries none until somebody sets one deliberately.
    await db.ledgerAccount.create({ data: { ...data, code: a.code, name: a.name!, type: a.type! } });
  },
};
