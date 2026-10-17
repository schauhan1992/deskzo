import { note, ol, p, perm, qa, runs, setting, task, ul } from "./_build";
import type { SeedGuide } from "./types";

/**
 * Credential Vault — written from src/app/(dashboard)/vault (the vault and its archive),
 * src/components/vault (the list, the open/edit/share/trail dialogs, the password generator, the archive
 * dialogs), src/actions/vault.ts (who may open, change, share, delete and restore), src/lib/vault/policy.ts
 * (sharing, change reminders, billing expiry, the 60-day archive), src/lib/notify.ts (expiry reminders),
 * src/lib/handover/areas.ts (a leaver's logins) and Settings › Lists (credential-tags-manager.tsx).
 */
export const guide: SeedGuide = {
  slug: "help/credential-vault",
  title: "Credential Vault",
  seo: {
    title: "Credential Vault: the company's logins, shared safely",
    description: "How to store the company's logins, open one with your own password, share it with a colleague or a team, and see who opened it and when.",
    keywords: ["credential vault", "shared passwords", "password manager"],
  },
  guide: {
    module: "vault",
    heading: "Credential Vault",
    summary: "The company's own logins — registrars, hosting panels, partner portals, tax accounts — kept encrypted, opened with your own password, shared on purpose, and every opening recorded and reported to the owner.",
    purpose: [
      p("The credential vault is where the company keeps the logins it runs on, instead of in a spreadsheet or somebody's head: the domain registrar, the hosting panel, the bank's portal, the tax account. A record can be the company's own, or a client's account you look after for them."),
      p("Each record belongs to the person who added it. When somebody else needs it, the owner shares it — with a colleague or with a whole department, to open only or to open and edit, for good or until a date."),
      p("Opening a password asks for your own sign-in password, every time. The opening is recorded on the record, and the owner is told whenever anybody else opens it. The vault also generates strong passwords, reminds you when a password is due for a change or a subscription is about to lapse, and warns you when the same password is used on more than one record."),
      note("The page says it plainly: logins are encrypted where they are stored, and opening one is controlled and recorded — but it is a shared cupboard with a good lock, not a hardware vault. Somebody with access to the server itself could still decrypt them."),
    ],
    access: [
      p("Anybody allowed to use the vault sees their own records and the ones shared with them — nothing else. On each record what you can do depends on how you came by it:"),
      ul(
        runs({ b: "Your own" }, " — you added it, or it was handed to you. You can open, edit, share and delete it."),
        runs("Shared with you as ", { b: "Can open" }, " — you can open it, and see who else has."),
        runs("Shared with you as ", { b: "Can open, edit and share" }, " — you can also change it and share it on. You can't delete it: only its owner, or an administrator, can."),
        runs("Shared with your department — everybody in that department has it while they are in it. Somebody who joins the team gets it, and somebody who leaves the team loses it, without anybody changing the share."),
      ),
      p("A share with an end date stops on that date by itself."),
      p(runs("People allowed to see every vault record can open any record, even one nobody shared with them. The record then says ", { b: "Admin override — the owner will be told" }, ", the opening is recorded as an override, and the owner is notified. Only they can see the vault's archive and restore from it.")),
    ],
    permissions: [
      perm("section.vault", "Shows Credential Vault in the menu and lets people open its pages. Every role has it until an admin unticks it for one."),
      perm(
        "vault.use",
        "Lets somebody store their own logins and open the ones shared with them. It gives nothing on records nobody has shared with them. Management, Sales, Support, Accounts and Purchase have it by default, as do admins.",
      ),
      perm(
        "vault.viewAll",
        "Lets somebody open any record, including ones nobody shared with them, and see, restore and destroy what is in the archive. Each time it is used on a record not shared with them, it is recorded as an override and the owner is told. No built-in role has it by default; admins hold it, as they hold every permission unless it is taken away. Give it to as few people as the work allows.",
      ),
      perm("vault.manageTags", "Lets somebody edit the vault's categories and access types in Settings › Lists. Management has it by default, as do admins."),
    ],
    setup: [
      p(runs("Once the module is switched on in ", { b: "Settings › Modules" }, ", the vault is ready: people add their own logins from the first day.")),
      p(runs("An admin can set up the lists records are filed under in ", { b: "Settings › Lists" }, ", under ", { b: "Credential vault tags" }, ": ", { b: "Categories" }, " (what kind of service it is — Hosting, say) and ", { b: "Access types" }, " (what kind of access the login gives — Billing, say).")),
      p(runs("For sharing with a department to work, people need a department, set in ", { b: "Settings › Users" }, ". Who may use the vault, and who may see every record, is set per role in ", { b: "Settings › Roles & Permissions" }, ".")),
    ],
    tasks: [
      task(
        "Add a login",
        ol(
          runs("Open ", { b: "My work › Credential vault" }, " and select ", { b: "Add a credential" }, "."),
          runs("Under ", { b: "What it opens" }, ", name it so a colleague can tell — “GoDaddy — acme.com”."),
          runs("Under ", { b: "Whose account is it" }, ", choose ", { b: "Ours" }, " or ", { b: "A client's" }, ". For a client's, pick ", { b: "Which client" }, "."),
          runs("Fill in what you know: ", { b: "Category" }, ", ", { b: "Access type" }, ", ", { b: "Username" }, ", ", { b: "Email" }, ", ", { b: "Login URL" }, ", and ", { b: "Two-step goes to" }, " — the phone that gets the sign-in codes."),
          runs("Type the ", { b: "Password" }, ", or select ", { b: "Generate" }, " for a strong one. Add a ", { b: "Recovery key" }, " if the service gave you one."),
          runs("Optionally, set ", { b: "Billing expires" }, ", ", { b: "Recommend a change after (days)" }, " and ", { b: "Remarks" }, "."),
          runs("Select ", { b: "Save" }, "."),
        ),
        p(runs("To choose how a password is generated, select the length button beside ", { b: "Generate" }, ": set the ", { b: "Length" }, ", the kinds of characters, and ", { b: "Skip lookalikes" }, " to leave out characters easily misread, like O and 0.")),
      ),
      task(
        "Open a password",
        ol(
          runs("On the record, select ", { b: "Password" }, " — or ", { b: "Recovery key" }, ", if it has one."),
          runs("Type ", { b: "Your password" }, " — the one you sign in with — and select ", { b: "Show password" }, "."),
          runs("Read or copy it, then select ", { b: "Done" }, "."),
        ),
        p("It isn't kept: opening it again asks for your password again. Nothing is copied for you, and every opening is recorded on the record. If it isn't your record, its owner is told you opened it."),
      ),
      task(
        "Share a login",
        ol(
          runs("On the record, select ", { b: "Share" }, "."),
          runs("Under ", { b: "Share with" }, ", search for a colleague by name or email, or for a team."),
          runs("Under ", { b: "They can" }, ", choose ", { b: "Can open" }, " or ", { b: "Can open, edit and share" }, "."),
          runs("To give access for a while only, set ", { b: "Until (optional)" }, "."),
          runs("Select ", { b: "Share" }, "."),
        ),
        p(runs("A colleague you share with is notified. To take a share back, open ", { b: "Share" }, " again and remove them from ", { b: "Already shared with" }, ".")),
      ),
      task(
        "See who opened a login",
        p(runs("Select ", { b: "Who opened it" }, " on the record for its openings, latest first — who, when, the password or the recovery key, and how they had access. The record's card also shows who opened it last and how many times it has been opened. Anybody who can see the record can see this.")),
      ),
      task(
        "Change a stored password",
        ol(
          runs("On the record, select ", { b: "Edit" }, "."),
          runs("Type the new one under ", { b: "New password (blank keeps the current one)" }, ", or generate it."),
          runs("Select ", { b: "Save" }, "."),
        ),
        p("The record is dated as changed, which resets its change reminder. If you changed somebody else's record, its owner is told."),
      ),
      task(
        "Delete a login, and get it back",
        ol(
          runs("On the record, select ", { b: "Delete" }, "."),
          runs("Say why under ", { b: "Why (optional)" }, " — it's the first thing anybody asks when they find it missing."),
          runs("Select ", { b: "Delete and archive" }, "."),
        ),
        p(runs("The record goes to the archive for 60 days, then it is destroyed for good. Everyone it was shared with loses it, and its owner is told if somebody else deleted it. Somebody allowed to see every vault record can open the ", { b: "Archive" }, " from the vault's page and select ", { b: "Restore" }, " — or ", { b: "Destroy now" }, " to remove it straight away.")),
      ),
      task(
        "Find a login",
        p(runs("Type in ", { b: "Search name, username, email or URL…" }, ", or narrow the list by category, by ", { b: "Ours" }, " or ", { b: "A client's" }, ", or by owner. ", { b: "Pin to the top" }, " keeps a record above the rest — only for you. Records whose billing runs out within a month float to the top for everybody.")),
      ),
    ],
    settings: [
      setting(
        "Credential vault tags",
        "Settings › Lists",
        p("The two lists records are filed under: Categories and Access types. A tag can be switched off rather than deleted; one that records use can't be deleted at all. Changing them needs the Manage vault categories permission."),
      ),
      setting(
        "Recommend a change after (days)",
        "In each record",
        p("How often the password should be changed. The record says when a change is due, from a fortnight before, and how many days overdue it is after. Leave it empty for no reminder."),
      ),
      setting(
        "Billing expires",
        "In each record",
        p("When the subscription behind the login runs out. From a month before, its owner gets a reminder every few days, and one more once it has lapsed. Records expiring within a month float to the top of everybody's list."),
      ),
      setting("Whose account is it", "In each record", p("Ours, or a client's — with the client named, so you can find every login you hold for one customer.")),
      setting("They can, and Until (optional)", "In the Share dialog", p("Whether the person or team can only open the record, or open, edit and share it — and, optionally, the date their access ends.")),
    ],
    faq: [
      qa(
        "I don't see Credential vault in the menu.",
        p("Either the module is switched off for your company, your role has had the section hidden, or you don't have the permission to use the vault. Ask an admin: the switch is in Settings › Modules, and the section and the permission are in Settings › Roles & Permissions."),
      ),
      qa("It says “That password isn't right”.", p("The vault wants the password you sign in with, not the stored one. A wrong one is recorded in the workspace's audit log as a failed try.")),
      qa("It says “This account has no password set”.", p("Opening a login needs a password on your own account. If you only ever sign in another way, ask an admin about setting a password for you.")),
      qa("Can an admin read my stored passwords?", p("Somebody allowed to see every vault record can — but each time it is marked on the record as an admin override, recorded, and you are notified. A login shared with them counts as a share, not an override.")),
      qa(
        "What happens to a colleague's logins when they leave?",
        p(runs("When their handover is done, the logins they own move to whoever takes them over, and each is marked to be changed within fifteen days — they still know the password. Logins shared with them move to their successor. See ", ["People & HR", "/help/people-hr"], ".")),
      ),
      qa("Why does it say “Same password on 2 other records”?", p("The same password is stored on other records you can see. Records you can't see aren't counted.")),
      qa("Why isn't the login address a link?", p("It is shown, never linked, on purpose: a stored address is only text, and one wrong click is all a fake login page needs. Copy it into the browser yourself.")),
      qa("I deleted a login by mistake.", p("It is in the archive for 60 days. Ask somebody allowed to see every vault record to restore it from Archive.")),
    ],
    related: ["hr", "projects", "notifications"],
  },
};
