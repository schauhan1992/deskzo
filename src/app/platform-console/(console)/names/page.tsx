import type { Metadata } from "next";
import Link from "next/link";
import { AtSign, ShieldCheck } from "lucide-react";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { BlockNameButton, BuiltInWords, NameRulesTable, NameTestBox, PlatformHosts } from "@/components/console/names/names-panels";
import { plural } from "@/lib/console-shared/format";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import { consoleStaff } from "@/lib/platform/console-page";
import { namesBoard } from "@/lib/platform/names-console";
import { MIN_SIGNUP_NAME } from "@/lib/workspace-names";

export const metadata: Metadata = { title: "Workspace names" };

/**
 * Workspace names: what a new workspace may be called (src/lib/workspace-names.ts) — the built-in
 * list and staff's own rules on top of it, and a box to test a name against all of it, exactly as
 * signup would. Every staff member may look; owners and admins block and unblock names, and release
 * built-in words or block them again (the buttons are drawn for them alone, and the actions check
 * again). The platform's own addresses are locked: nothing here changes them.
 *
 * Holding an address for one customer is done on an invitation (/invites, "New invitation").
 */
export default async function ConsoleNamesPage() {
  const staff = await consoleStaff(PAGE_ROLES.names);
  const caps = capsFor(staff.role);
  const board = await namesBoard();
  const c = board.counts;

  return (
    <>
      <PageHeader
        title="Workspace names"
        subtitle={`${plural(c.blocks, "name")} blocked by staff · ${plural(c.releases, "word")} released · ${plural(c.platformHosts, "platform address", "platform addresses")} locked`}
        actions={caps.manage ? <BlockNameButton /> : undefined}
      />

      <div className="space-y-6">
        <Banner tone="info" icon={<ShieldCheck className="h-4 w-4" />} title="Customers only ever read “That name is reserved.” — or “That name is taken.”">
          Which rule refused a name, and staff&apos;s reasons, stay here. A block refuses new workspaces only: one that already has the name keeps it. To give one customer a
          particular address — even a reserved word — hold it on their invitation in{" "}
          <Link href="/invites" className="font-medium underline">
            Invitations
          </Link>
          .
        </Banner>

        <Panel title="Test a name" description="What signup would say, and which rule decided — the same check signup and provisioning run, with the rules as they are now.">
          <NameTestBox />
        </Panel>

        <Panel
          title="Staff rules"
          description="Names and words staff have blocked, and built-in words they have released. Blocks are checked before the built-in list."
          padded={false}
        >
          {board.rules.length > 0 ? (
            <NameRulesTable rows={board.rules} manage={caps.manage} />
          ) : (
            <EmptyState
              icon={<AtSign className="h-5 w-5" />}
              title="No staff rules yet."
              body="Only the built-in list below applies. Block a name or a word, or release a built-in word, and it is listed here."
              action={caps.manage ? <BlockNameButton /> : undefined}
            />
          )}
        </Panel>

        <Panel
          title="Built-in names"
          description={`Refused for every new workspace, whoever sets it up. A business signing itself up must also use ${MIN_SIGNUP_NAME} letters or digits at least, made from its registered name.`}
        >
          <div className="space-y-6">
            <PlatformHosts hosts={board.platformHosts} />
            {board.reserved.map((g) => (
              <BuiltInWords
                key={g.key}
                title={`Reserved words — ${g.label.charAt(0).toLowerCase()}${g.label.slice(1)}`}
                description="Refused as a whole address only: the word itself is reserved, a longer name with it inside is not."
                words={g.words}
                manage={caps.manage}
              />
            ))}
            <BuiltInWords
              title="Our name"
              description="Refused anywhere in an address, hyphens ignored — so nobody can pass themselves off as us. The platform's own first workspace has it, and keeps it."
              words={board.ours}
              manage={caps.manage}
            />
            <BuiltInWords
              title="Competitors"
              description="Refused as a word of an address, or how it starts — not inside another word, so “digitallyyours” is fine."
              words={board.competitors}
              manage={caps.manage}
            />
          </div>
        </Panel>
      </div>
    </>
  );
}
