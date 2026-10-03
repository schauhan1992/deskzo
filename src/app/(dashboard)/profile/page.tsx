import { notFound } from "next/navigation";
import { getOwnProfile } from "@/actions/profile";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ChangePasswordForm } from "@/components/profile/change-password-form";
import { TwoFactorSetup } from "@/components/profile/two-factor-setup";
import { PhotoManager } from "@/components/profile/photo-manager";
import { ContactForm } from "@/components/profile/contact-form";
import { myAccess } from "@/actions/access-control";
import { MyAccess } from "@/components/access/my-access";
import { DEVICE_KIND_LABEL } from "@/lib/access/device";
import { placeText } from "@/lib/access/geo";
import { workspaceClock } from "@/lib/time/workspace";
import { getMyConnection } from "@/actions/workplace-connection";
import { getMyCalendar } from "@/actions/calendar";
import { isModuleEnabled } from "@/actions/module";
import { MailboxConnection } from "@/components/profile/mailbox-connection";
import { isModuleEntitled } from "@/lib/modules-access";
import { myLinkedWorkspaces } from "@/actions/linked-sign-in";
import { LinkedWorkspacesCard } from "@/components/linked/linked-workspaces-card";
import { PLATFORM_DOMAIN } from "@/lib/tenancy/host";
import { currentTenant } from "@/lib/tenancy/resolve";

export default async function ProfilePage({
  searchParams,
}: {
  /** `mailbox` and `via`: how connecting a mailbox went, and with which provider. `outlook` is the same, from before Gmail and Zoho. */
  searchParams: Promise<{ mailbox?: string; via?: string; outlook?: string; link?: string }>;
}) {
  // A connection is for emailing documents, and for the calendar — either is reason enough for the card.
  const [mailUse, calendarOn] = await Promise.all([
    isModuleEntitled("sales_documents").then(async (has) => has || (await isModuleEntitled("purchase_documents"))),
    isModuleEnabled("calendar"),
  ]);
  const [profile, security, access, mail, calendar, linked, { mailbox, via, outlook, link }, clock] = await Promise.all([
    getOwnProfile(),
    getCachedSecuritySettings(),
    myAccess(),
    mailUse || calendarOn ? getMyConnection() : null,
    calendarOn ? getMyCalendar() : null,
    // One card on this page, never a reason for the page to fail: a control plane out of reach just hides it.
    myLinkedWorkspaces().catch(() => null),
    searchParams,
    workspaceClock(),
  ]);
  if (!profile) notFound();

  const twoFactorEnabled = !!profile.twoFactorEnabledAt;
  const mustSetUpTwoFactor = !!security?.enforceTwoFactor && !twoFactorEnabled;

  // Linked workspaces (spec §2.4). Not enabled with nothing listed is viewing as somebody, platform support, a
  // workspace outside the control plane or a pause: no card at all.
  const showLinked = !!linked && (linked.enabled || linked.items.length > 0);
  // `?link=` is where "Sign in with Microsoft again" comes back to (§2.2): the add dialog reopens on the address typed
  // before it. Only shown to the person, never trusted — the action resolves it through the registry — so only
  // something shaped like an address is taken.
  const typedLink = typeof link === "string" ? link.trim().toLowerCase() : "";
  const openWith = showLinked && /^[a-z0-9.-]{1,255}$/.test(typedLink) ? { workspace: typedLink, sso: true } : null;
  const workspaceName = showLinked ? (await currentTenant()).name : undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">My profile</h1>
        <p className="mt-1 text-sm text-muted">Account details, password, and two-factor authentication.</p>
      </div>

      {profile.mustChangePassword && (
        <div className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">
          You signed in with a temporary password from your administrator. Choose your own below before continuing — use
          the temporary one as your current password.
        </div>
      )}
      {mustSetUpTwoFactor && (
        <div className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">
          Your administrator requires two-factor authentication for all accounts — set it up below.
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Photo</CardHeader>
            <CardContent>
              <PhotoManager user={{ id: profile.id, name: profile.name, photoUpdatedAt: profile.photoUpdatedAt }} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">Contact</CardHeader>
            <CardContent>
              <ContactForm email={profile.email} phone={profile.phone} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">Account</CardHeader>
            <CardContent className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div className="flex justify-between sm:block">
                <span className="text-muted">Name</span>
                <span className="text-text sm:ml-2">{profile.name}</span>
              </div>
              <div className="flex justify-between sm:block">
                <span className="text-muted">Email</span>
                <span className="text-text sm:ml-2">{profile.email}</span>
              </div>
              <div className="flex justify-between sm:block">
                <span className="text-muted">Role</span>
                <span className="text-text sm:ml-2">{profile.role}</span>
              </div>
              <div className="flex justify-between sm:block">
                <span className="text-muted">Department</span>
                <span className="text-text sm:ml-2">{profile.department?.name ?? "—"}</span>
              </div>
              <div className="flex justify-between sm:block">
                <span className="text-muted">Reporting manager</span>
                <span className="text-text sm:ml-2">{profile.manager?.name ?? "—"}</span>
              </div>
              <p className="col-span-full pt-1 text-xs text-subtle">
                Name, role, and department are managed by an admin under Staff &amp; roles.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">Password</CardHeader>
            <CardContent>
              <ChangePasswordForm />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6 self-start">
        <Card>
          <CardHeader className="text-sm font-medium text-text">Two-factor authentication</CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted">
              Adds a 6-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator, etc.) on
              top of your password at sign-in.
            </p>
            <TwoFactorSetup enabled={twoFactorEnabled} />
          </CardContent>
        </Card>

        {/* The id is where the header switcher's "Manage" lands (/profile#linked-workspaces); scroll-mt clears the sticky header. */}
        {showLinked && linked && (
          <Card id="linked-workspaces" className="scroll-mt-20">
            <CardHeader className="text-sm font-medium text-text">Linked workspaces</CardHeader>
            <CardContent>
              <LinkedWorkspacesCard initial={linked} domain={PLATFORM_DOMAIN} openWith={openWith} currentName={workspaceName} />
            </CardContent>
          </Card>
        )}

        {/* Not shown while viewing as somebody: whose mailbox is connected is theirs alone. */}
        {mail && (
          <Card id="mailbox" className="scroll-mt-20">
            <CardHeader className="text-sm font-medium text-text">{calendarOn ? (mailUse ? "Your mailbox and calendar" : "Your calendar") : "Your mailbox"}</CardHeader>
            <CardContent>
              <MailboxConnection
                providers={mail.providers}
                connection={mail.connection}
                mailUse={mailUse}
                calendar={calendar}
                outcome={mailbox ?? outlook ?? null}
                via={mailbox ? (via ?? null) : outlook ? "microsoft" : null}
              />
            </CardContent>
          </Card>
        )}
        </div>
      </div>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Your devices and sign-ins</CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted">
            Every sign-in is recorded with its network and approximate location — this is what the security admins see. A session
            you don&apos;t recognise, end it here and change your password.
          </p>
          <MyAccess
            devices={access.devices.map((d) => ({
              id: d.id,
              label: d.label,
              kindLabel: DEVICE_KIND_LABEL[d.kind],
              statusLabel: d.status === "APPROVED" ? "Approved" : d.status === "PENDING" ? "Waiting for approval" : d.status === "REJECTED" ? "Rejected" : "Revoked",
              tone: d.status === "APPROVED" ? "green" : d.status === "PENDING" ? "amber" : "red",
              lastText: clock.dateTime(d.lastSeenAt),
              place: d.lastPlace,
            }))}
            signIns={access.signIns.map((s) => ({
              id: s.id,
              atText: clock.dateTime(s.at),
              place: placeText(s),
              ip: s.ip,
              device: s.device?.label ?? null,
              current: s.current,
              ended: s.endedAt !== null,
              located: s.gpsAt !== null,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
