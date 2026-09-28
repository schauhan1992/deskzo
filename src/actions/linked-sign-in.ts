"use server";

import { AuthError } from "next-auth";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { recordAudit } from "@/lib/audit";
import { auth, signIn, signOut } from "@/lib/auth";
import { clientIpFrom } from "@/lib/client-ip";
import { db } from "@/lib/db";
import { formatIstDateTime } from "@/lib/india-time";
import { LinkRefused, linkedSignInEnabled, linkedWorkspacesFor, memberOf, revokeMember, type LinkRefusal, type LinkedWorkspace } from "@/lib/platform/linked/groups";
import { LinkNeedsCode, cancelLinkIntent, completeLinkIntent, createLinkIntent, presentLinkIntent, proveLinkIntent } from "@/lib/platform/linked/intents";
import { LINK_COOKIE_MAX_AGE, MAX_LINKED_WORKSPACES, linkCookieName, type LinkCookie } from "@/lib/platform/linked/keys";
import { SwitchRefused, issueSwitchTicket, presentSwitchTicket, ssoEmailFor, verifySwitchCode, type SwitchRefusal, type SwitchState } from "@/lib/platform/linked/switch";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { UnauthorizedError, currentUser, requireUser, viewAsContext } from "@/lib/session";
import { HOST_MISMATCH, protocolFor, requestHost } from "@/lib/tenancy/host";
import { currentTenant, currentTenantOrNull, tenantOrigin } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Linked sign-in, for the person (spec §8.4): linking their own accounts in other workspaces, switching
 * between them, and unlinking. Thin on purpose — each action works out who is asking, which workspace,
 * this browser's cookies and the caller's address, hands them to src/lib/platform/linked/, sets or
 * clears the cookie that step owns, and turns a refusal into its §2.7 message. Everything decided is
 * decided there.
 *
 * Who is asking: the access gate first (`requireUser`), then the session's own id and sid. Never the id
 * `requireUser` returns — while viewing as, that is the viewed account's, and linking or switching from
 * inside somebody else's session is exactly what must not happen (it is refused as `view-as`).
 *
 * Some steps run with nobody signed in here, by design, and never ask `requireUser`: `/link/start`
 * (openLinkRequest), `/link/complete` (finishLinkRequest, whose token is spent before any session is
 * looked at) and `/switch` (arriveBySwitch, submitSwitchCode, continueSwitchWithMicrosoft). Each of them
 * holds a one-time token, or the cookie secret of the browser that presented one.
 *
 * Nothing here returns a token, a secret or a hash — only the URLs the library builds from the registry.
 */

export type LinkedWorkspaceView = Omit<LinkedWorkspace, "linkedAt" | "lastSwitchedInAt"> & {
  linkedAtText: string;
  lastSwitchedInText: string | null;
  loginUrl: string;
  markUrl: string;
};
/** What `myLinkedWorkspaces` answers: the switcher's and Profile's list, and how "Add a workspace" asks to confirm it's you. */
export type MyLinkedWorkspaces = { enabled: boolean; items: LinkedWorkspaceView[]; reauth: "password" | "password+code" | "sso" };
export type SwitchView =
  | { state: "code"; workspace: string; email: string; triesLeft: number; error?: string }
  | { state: "sso"; workspace: string }
  | { state: "refused"; message: string };

// ─── Messages (spec §2.7) ────────────────────────────────────────────────────────────────────────

type Refusal = LinkRefusal | SwitchRefusal;

/**
 * One message per refusal. `name` is the workspace the message is about ("that workspace" when the
 * library could not name it); `n` the minutes of a lockout or the code tries left. None says whether an
 * address has an account anywhere, and the password, rate-limit and ticket ones say no more than this.
 */
const MESSAGES: Record<Refusal, (w: { name: string; Name: string }, n?: number) => string> = {
  disabled: () => "Switching between workspaces is paused. Sign in to each workspace directly.",
  "not-member": () => "Linked workspaces are only for your own account.",
  "view-as": () => "Linked workspaces are only for your own account. Switch back to yourself first.",
  reauth: () => "That password or code isn't right.",
  "reauth-sso": () => "Sign in with Microsoft again to continue.",
  "rate-limited": () => "Too many tries. Wait a few minutes and try again.",
  "unknown-workspace": () => "There's no workspace at that address.",
  "same-workspace": () => "That's the workspace you're in.",
  "workspace-unavailable": () => "That workspace isn't open right now.",
  "already-linked": () => "That workspace is already linked.",
  conflict: (w) => `Your linked workspaces already include an account in ${w.name}. Unlink it first.`,
  full: () => `You can link up to ${MAX_LINKED_WORKSPACES} workspaces. Unlink one first.`,
  expired: () => "This link request has expired. Start again from your other workspace.",
  used: () => "This link request was already used. Start again from your other workspace.",
  "wrong-browser": () => "Finish linking in the browser where you started.",
  "not-fresh": () => "Sign in again to confirm it's you.",
  "must-change-password": (w) => `Set a new password for ${w.name} first — sign in there directly.`,
  "two-factor-setup": (w) => `${w.Name} requires two-factor. Sign in there directly to set it up.`,
  "super-admin-two-factor": (w) => `Switching into a super admin account needs two-factor on it. Sign in to ${w.name} directly.`,
  // Owner decision 3 (LS-SWITCH): users.manage or security.manage without two-factor.
  "manager-two-factor": (w) => `Switching into an account that manages users or security needs two-factor on it — sign in to ${w.name} directly and set it up first.`,
  support: () => "Platform support accounts can't be linked.",
  stale: (w) => `Your sign-in details for ${w.name} changed, so it was unlinked. Link it again.`,
  inactive: (w) => `Your account in ${w.name} is switched off.`,
  "switching-off": (w) => `Switching into ${w.name} is turned off by its administrators. Sign in there directly.`,
  "billing-hold": (w) => `${w.Name} is on hold for billing. Sign in there directly to pay.`,
  network: (w) => `${w.Name} doesn't allow sign-ins from this network.`,
  "locked-out": (_w, n) => (n && n > 0 ? `Too many attempts. Try again in ${n} ${n === 1 ? "minute" : "minutes"}.` : "Too many attempts. Try again in a few minutes."),
  ticket: () => "This switch has expired. Switch again from your other workspace.",
  // A refused `code` is the fifth wrong one: the switch has ended.
  code: (_w, n) => (n && n > 0 ? `That code didn't work. ${n} ${n === 1 ? "try" : "tries"} left.` : "That code didn't work. No tries left — switch again from your other workspace."),
  cancelled: () => "Linking was cancelled.",
};

function messageFor(code: Refusal, workspace?: string, n?: number): string {
  const named = workspace?.trim();
  return MESSAGES[code]({ name: named || "that workspace", Name: named || "That workspace" }, n);
}

/** A refusal's message, or null for anything else — which the caller rethrows. */
function refusalMessage(err: unknown): string | null {
  return err instanceof LinkRefused || err instanceof SwitchRefused ? messageFor(err.code, err.workspace) : null;
}

/** Asked for after a right password, when the account has two-factor and no code came with it. */
const NEEDS_CODE = "Enter the 6-digit code from your authenticator app.";

// ─── Who, where, and this browser's cookies ──────────────────────────────────────────────────────

/**
 * The person asking, by the session itself (§8.4's identity rule): the access gate first, then the
 * session's own id and sid, and whether it is viewing as somebody else.
 */
async function person(): Promise<{ userId: string; sid: string | undefined; viewingAs: boolean }> {
  await requireUser();
  const session = await auth();
  if (!session?.user) throw new UnauthorizedError();
  return { userId: session.user.id, sid: session.user.sid, viewingAs: !!(await viewAsContext()) };
}

type Here = { tenant: Tenant; secure: boolean; ip: string | null };

/**
 * The workspace this request is for, whether its cookies are `__Host-` and Secure (https, as the
 * session cookie's rule in src/lib/auth-session.ts), and the caller's address. Null when the request's
 * host can't be trusted: no cookie is set or read for it, and no step proceeds.
 */
async function here(): Promise<Here | null> {
  const head = await headers();
  const host = requestHost(head);
  if (!host || host === HOST_MISMATCH) return null;
  const tenant = await currentTenantOrNull();
  return tenant ? { tenant, secure: protocolFor(host) === "https", ip: clientIpFrom(head) } : null;
}

const cookieAttributes = (secure: boolean) => ({ httpOnly: true, sameSite: "lax" as const, secure, path: "/" });

async function readCookie(cookie: LinkCookie, secure: boolean): Promise<string | null> {
  return (await cookies()).get(linkCookieName(cookie, secure))?.value ?? null;
}

async function setCookie(cookie: LinkCookie, secure: boolean, value: string): Promise<void> {
  (await cookies()).set(linkCookieName(cookie, secure), value, { ...cookieAttributes(secure), maxAge: LINK_COOKIE_MAX_AGE[cookie] });
}

/** Cleared with the attributes it was set with — a browser ignores a `__Host-` cookie's removal without Secure and Path=/. */
async function clearCookie(cookie: LinkCookie, secure: boolean): Promise<void> {
  (await cookies()).delete({ name: linkCookieName(cookie, secure), ...cookieAttributes(secure) });
}

const isSupportAddress = (email: string) => email.trim().toLowerCase().endsWith("@platform.invalid");
const text = (value: unknown) => (typeof value === "string" ? value : "");

// ─── The list ────────────────────────────────────────────────────────────────────────────────────

function viewOf(w: LinkedWorkspace): LinkedWorkspaceView {
  const { linkedAt, lastSwitchedInAt, ...rest } = w;
  return {
    ...rest,
    linkedAtText: formatIstDateTime(linkedAt),
    lastSwitchedInText: lastSwitchedInAt ? formatIstDateTime(lastSwitchedInAt) : null,
    loginUrl: `${w.origin}/login`,
    markUrl: `${w.origin}/api/brand/mark`,
  };
}

/**
 * The person's own linked workspaces — this one first — for the switcher and Profile, and how "Add a
 * workspace" asks them to confirm it's them: a password, a password and a code, or (their workspace
 * enforcing Microsoft sign-in, and they not an admin) a fresh Microsoft sign-in. Not enabled while
 * viewing as, for platform support, for a workspace outside the control plane, or while paused.
 *
 * While paused the links are still listed (`enabled: false`), so Profile can show them and let the
 * person unlink: a pause stops switching and linking, not the way out. Switching is refused on the
 * server during a pause whatever this returns, and the header's switcher is not drawn at all.
 */
export async function myLinkedWorkspaces(): Promise<MyLinkedWorkspaces> {
  const me = await person();
  const off: MyLinkedWorkspaces = { enabled: false, items: [], reauth: "password" };
  if (me.viewingAs) return off;
  const tenant = await currentTenant();
  if (tenant.source !== "control") return off;
  const paused = !(await linkedSignInEnabled());
  const account = await db.user.findUnique({ where: { id: me.userId }, select: { kind: true, email: true, role: true, twoFactorEnabledAt: true } });
  if (!account || account.kind !== "MEMBER" || isSupportAddress(account.email)) return off;
  const [linked, security] = await Promise.all([linkedWorkspacesFor(tenant.id, me.userId), getCachedSecuritySettings()]);
  const reauth = security?.enforceSso && account.role !== "ADMIN" ? "sso" : account.twoFactorEnabledAt ? "password+code" : "password";
  return { enabled: !paused, items: linked.map(viewOf), reauth };
}

// ─── Linking (spec §4.2) ─────────────────────────────────────────────────────────────────────────

/**
 * L1, "Add a workspace": confirms it's the person (password and code, or a Microsoft sign-in under ten
 * minutes old with `sso`), then sends the browser to the target's `/link/start`. This browser keeps
 * the `link` cookie, which alone can finish the link (L4). `needs: "code"` comes back only after a
 * right password, so the dialog can ask for the code; `needs: "sso"` when a Microsoft sign-in is the
 * way to confirm it (`reauthWithMicrosoft`).
 */
export async function startLinkingWorkspace(input: {
  workspace: string;
  password?: string;
  totpCode?: string;
  sso?: boolean;
}): Promise<{ ok: true; url: string } | { ok: false; error: string; needs?: "code" | "sso" }> {
  const me = await person();
  const at = await here();
  if (!at) return { ok: false, error: messageFor("disabled") };
  try {
    const asked = await createLinkIntent({
      source: at.tenant,
      userId: me.userId,
      sid: me.sid,
      viewingAs: me.viewingAs,
      workspace: text(input?.workspace),
      password: typeof input?.password === "string" ? input.password : undefined,
      totpCode: typeof input?.totpCode === "string" ? input.totpCode : undefined,
      sso: input?.sso === true,
      ip: at.ip,
      origin: await tenantOrigin(at.tenant),
    });
    await setCookie("link", at.secure, asked.browserSecret);
    return { ok: true, url: asked.url };
  } catch (err) {
    // Before the generic mapping: it is also a `reauth` refusal.
    if (err instanceof LinkNeedsCode) return { ok: false, error: NEEDS_CODE, needs: "code" };
    if (err instanceof LinkRefused && err.code === "reauth-sso") return { ok: false, error: messageFor("reauth-sso"), needs: "sso" };
    const message = refusalMessage(err);
    if (message === null) throw err;
    return { ok: false, error: message };
  }
}

/**
 * A fresh Microsoft sign-in, to confirm it's the person before linking — back to Profile with the
 * dialog open on the address they typed. Throws the redirect.
 */
export async function reauthWithMicrosoft(workspace: string): Promise<void> {
  const me = await person();
  if (me.viewingAs) return;
  const typed = text(workspace).trim().slice(0, 300);
  try {
    await signIn("microsoft-entra-id", { redirectTo: `/profile?link=${encodeURIComponent(typed)}#linked-workspaces` });
  } catch (err) {
    // Microsoft sign-in could not start: the dialog stays as it was. Anything else — the redirect itself — goes on.
    if (err instanceof AuthError) return;
    throw err;
  }
}

/**
 * L2, the target's `/link/start`: presents the request in this browser (the `link-in` cookie), and
 * signs out any session here — the proof must be a fresh sign-in. The page then goes to
 * `/login?callbackUrl=%2Flink%2Fconfirm`. Public; the library limits it per caller.
 */
export async function openLinkRequest(token: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const at = await here();
  if (!at) return { ok: false, error: messageFor("disabled") };
  try {
    const presented = await presentLinkIntent(at.tenant, text(token), at.ip);
    await setCookie("link-in", at.secure, presented.targetSecret);
  } catch (err) {
    const message = refusalMessage(err);
    if (message === null) throw err;
    return { ok: false, error: message };
  }
  if (await auth()) await signOut({ redirect: false });
  return { ok: true };
}

/** L3 refusals after which the request can no longer be confirmed, so its cookie goes too. The others can be put right within its ten minutes. */
const CONFIRM_ENDED = new Set<LinkRefusal>(["used", "expired", "wrong-browser"]);

/**
 * L3, the target's `/link/confirm`: the account that has just signed in here approves. Returns the way
 * back to the source's `/link/complete` (the completion token in its fragment).
 */
export async function confirmLinkRequest(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const me = await person();
  const at = await here();
  if (!at) return { ok: false, error: messageFor("disabled") };
  try {
    const proven = await proveLinkIntent(at.tenant, { targetSecret: await readCookie("link-in", at.secure), userId: me.userId, sid: me.sid, viewingAs: me.viewingAs, ip: at.ip });
    await clearCookie("link-in", at.secure);
    return { ok: true, url: proven.url };
  } catch (err) {
    const message = refusalMessage(err);
    if (message === null) throw err;
    if (err instanceof LinkRefused && CONFIRM_ENDED.has(err.code)) await clearCookie("link-in", at.secure);
    return { ok: false, error: message };
  }
}

/** "Cancel" on `/link/confirm`: the request this browser presented ends as cancelled. */
export async function cancelLinkRequest(): Promise<void> {
  await requireUser();
  const at = await here();
  if (!at) return;
  await cancelLinkIntent(at.tenant, await readCookie("link-in", at.secure));
  await clearCookie("link-in", at.secure);
}

/**
 * L4, the source's `/link/complete`: records the link. Not behind `requireUser` — that would throw
 * before the token is spent, and the spend comes first (§4.2 L4). The session is only an input:
 * none, or one the access gate holds, is refused after the spend like another browser. `memberId`
 * (additive) is what `switchToWorkspace` takes for "Switch to <name>"; `switchUrl` is always null.
 */
export async function finishLinkRequest(
  completion: string,
): Promise<{ ok: true; workspace: string; memberId: string; switchUrl: string | null } | { ok: false; error: string }> {
  const session = await auth();
  const gateOk = !!(await currentUser());
  const viewingAs = !!(await viewAsContext());
  const at = await here();
  if (!at) return { ok: false, error: messageFor("disabled") };
  try {
    const linked = await completeLinkIntent(at.tenant, {
      completion: text(completion),
      browserSecret: await readCookie("link", at.secure),
      userId: session?.user && gateOk ? session.user.id : null,
      sid: session?.user?.sid,
      viewingAs,
      ip: at.ip,
    });
    return { ok: true, workspace: linked.workspace, memberId: linked.memberId, switchUrl: null };
  } catch (err) {
    const message = refusalMessage(err);
    if (message === null) throw err;
    return { ok: false, error: message };
  } finally {
    // Spent either way: this browser's secret has nothing left to finish.
    await clearCookie("link", at.secure);
  }
}

// ─── Switching (spec §4.3) ───────────────────────────────────────────────────────────────────────

/** S1: a one-minute ticket into one of the person's linked workspaces — the browser goes to the URL. */
export async function switchToWorkspace(memberId: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const me = await person();
  const tenant = await currentTenant();
  try {
    const issued = await issueSwitchTicket(tenant, { userId: me.userId, sid: me.sid, memberId: text(memberId), viewingAs: me.viewingAs, ip: clientIpFrom(await headers()) });
    return { ok: true, url: issued.url };
  } catch (err) {
    const message = refusalMessage(err);
    if (message === null) throw err;
    return { ok: false, error: message };
  }
}

/** A switch that has ended, as the page shows it. A refused `code` is the fifth wrong one. */
function refusedView(state: Extract<SwitchState, { state: "refused" }>): SwitchView {
  return { state: "refused", message: messageFor(state.reason, state.workspace, state.reason === "code" ? 0 : state.retryInMinutes) };
}

/** S4, through the "linked" provider — which checks everything again — then `/dashboard`. Throws the redirect. */
async function signInLinked(proof: string): Promise<SwitchView> {
  try {
    await signIn("linked", { proof, redirectTo: "/dashboard" });
  } catch (err) {
    // The provider signed nobody in.
    if (err instanceof AuthError) return { state: "refused", message: messageFor("ticket") };
    throw err;
  }
  return { state: "refused", message: messageFor("ticket") };
}

/**
 * S2, the target's `/switch`: the ticket is spent here and the target's checks run. Ready → a new
 * session and `/dashboard`; already signed in here as that account (and let through by the gate) →
 * `/dashboard`; a two-factor code or a Microsoft sign-in → this browser keeps the `switch` cookie and
 * the page asks for it.
 */
export async function arriveBySwitch(token: string): Promise<SwitchView> {
  const session = await auth();
  const signedInOk = !!(await currentUser());
  const at = await here();
  if (!at) return { state: "refused", message: messageFor("disabled") };
  const state = await presentSwitchTicket(at.tenant, text(token), { signedInUserId: session?.user?.id ?? null, signedInOk, ip: at.ip });
  switch (state.state) {
    case "signed-in":
      return redirect("/dashboard");
    case "ready":
      return signInLinked(state.proof);
    case "code":
      await setCookie("switch", at.secure, state.presentSecret);
      return { state: "code", workspace: state.workspace, email: state.email, triesLeft: state.triesLeft };
    case "sso":
      await setCookie("switch", at.secure, state.presentSecret);
      return { state: "sso", workspace: state.workspace };
    case "refused":
      await clearCookie("switch", at.secure);
      return refusedView(state);
  }
}

/**
 * S3: the two-factor code, from the browser holding the `switch` cookie. Right → a new session and
 * `/dashboard`; wrong → the code step again with the tries left; Microsoft sign-in enforced in the
 * meantime → the Microsoft step (the cookie stays for it); ended → the reason.
 */
export async function submitSwitchCode(code: string): Promise<SwitchView> {
  const at = await here();
  if (!at) return { state: "refused", message: messageFor("disabled") };
  const state = await verifySwitchCode(at.tenant, await readCookie("switch", at.secure), text(code), at.ip);
  switch (state.state) {
    case "ready":
      await clearCookie("switch", at.secure);
      return signInLinked(state.proof);
    case "signed-in":
      await clearCookie("switch", at.secure);
      return redirect("/dashboard");
    case "code":
      return { state: "code", workspace: state.workspace, email: state.email, triesLeft: state.triesLeft, error: messageFor("code", state.workspace, state.triesLeft) };
    case "sso":
      return { state: "sso", workspace: state.workspace };
    case "refused":
      await clearCookie("switch", at.secure);
      return refusedView(state);
  }
}

/**
 * The Microsoft step of a switch into a workspace that signs in with Microsoft: an ordinary Microsoft
 * sign-in, the account's address as its hint, back to `/dashboard`. Throws the redirect.
 */
export async function continueSwitchWithMicrosoft(): Promise<void> {
  const at = await here();
  if (!at) return;
  const email = await ssoEmailFor(at.tenant, await readCookie("switch", at.secure));
  await clearCookie("switch", at.secure);
  try {
    await signIn("microsoft-entra-id", { redirectTo: "/dashboard" }, email ? { login_hint: email } : undefined);
  } catch (err) {
    if (err instanceof AuthError) return;
    throw err;
  }
}

// ─── Unlinking (spec §4.7) ───────────────────────────────────────────────────────────────────────

/**
 * Profile's "Unlink" on another workspace: that account leaves the person's group. Only a workspace in
 * the caller's own list, and never the caller's own member (that is `leaveLinkedWorkspaces`).
 */
export async function unlinkWorkspace(memberId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await person();
  if (me.viewingAs) return { ok: false, error: messageFor("view-as") };
  const tenant = await currentTenant();
  const other = (await linkedWorkspacesFor(tenant.id, me.userId)).find((w) => !w.current && w.memberId === memberId);
  if (!other) return { ok: false, error: messageFor("not-member") };
  if (await revokeMember(other.memberId, "user", `user:${me.userId}`)) {
    await recordAudit({ userId: me.userId, action: "DELETE", entityType: "LinkedSignIn", entityId: other.memberId, entityLabel: "Unlinked a linked workspace" });
  }
  revalidatePath("/profile");
  return { ok: true };
}

/** Profile's "Unlink <this workspace> from all": this account leaves its group. Nothing to do when it is in none. */
export async function leaveLinkedWorkspaces(): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await person();
  if (me.viewingAs) return { ok: false, error: messageFor("view-as") };
  const tenant = await currentTenant();
  const mine = await memberOf(tenant.id, me.userId);
  if (mine && (await revokeMember(mine.id, "left", `user:${me.userId}`))) {
    await recordAudit({ userId: me.userId, action: "DELETE", entityType: "LinkedSignIn", entityId: mine.id, entityLabel: "Unlinked this account from its linked workspaces" });
  }
  revalidatePath("/profile");
  return { ok: true };
}
