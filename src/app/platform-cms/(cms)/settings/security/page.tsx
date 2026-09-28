import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Clock, KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { CmsRolePill } from "@/components/cms/common/status";
import { cmsPage } from "@/lib/cms/guard";
import { CMS_ROUTES } from "@/lib/cms/nav";
import { CMS_IDLE_MS, CMS_MAX_MS, CMS_MIN_PASSWORD, cmsTwoFactorPolicy } from "@/lib/cms/session";
import { CMS_ADMINS } from "@/lib/cms/types";
import { listCmsUsers } from "@/lib/cms/users";
import { LOCKOUT_MS, MAX_FAILURES, WINDOW_MS } from "@/lib/security/lockout";
import { platformEnv } from "@/lib/platform/console-page";
import { SettingsTabs } from "../settings-tabs";
import { TwoFactorPolicy } from "./two-factor-policy";

export const metadata: Metadata = { title: "Security" };

const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * Settings › Security, for admins only (anybody else gets "not found"): the CMS's two-factor policy,
 * who would be asked to set up an authenticator, and the rules every CMS sign-in follows — stated
 * from the same constants the server enforces, so the page can never promise a limit the code does
 * not keep.
 */
export default async function CmsSecurityPage() {
  const session = await cmsPage(CMS_ADMINS);
  const [policy, users] = await Promise.all([cmsTwoFactorPolicy(), listCmsUsers({ activeOnly: true })]);
  const without = users.filter((u) => !u.twoFactor);
  const env = platformEnv();

  return (
    <>
      <PageHeader title="Security" subtitle="How people sign in to the CMS. CMS accounts are separate from the console and from every workspace." />
      <SettingsTabs active="security" admin />

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Panel title="Two-factor" description="A code from an authenticator app on top of the password.">
            <TwoFactorPolicy
              mode={policy.mode}
              chosen={policy.chosen}
              production={env.key === "production"}
              withoutAuthenticator={without.length}
              meEnrolled={session.enrolled}
            />
          </Panel>

          <Panel
            title="Without an authenticator"
            description={
              without.length === 0
                ? "Everybody who can sign in has one."
                : policy.mode === "required"
                  ? "Asked to set one up at their next sign-in."
                  : "Signing in with a password alone while two-factor is optional."
            }
            padded={without.length === 0}
            actions={
              <Link href={CMS_ROUTES.users} className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
                Manage users
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </Link>
            }
          >
            {without.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-success">
                <ShieldCheck aria-hidden="true" className="h-4 w-4" />
                All set.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {without.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-text">
                        {u.name}
                        {u.id === session.user.id && <span className="ml-1.5 rounded-full bg-surface-sunken px-1.5 text-[11px] font-medium text-muted">you</span>}
                      </span>
                      <span className="block truncate text-xs text-muted">{u.email}</span>
                    </span>
                    <CmsRolePill role={u.role} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <Panel title="Sign-in rules" description="The same for everybody; set in code, not here.">
          <ul className="space-y-4 text-sm">
            <Rule icon={<Clock className="h-4 w-4" />} title="Sessions end on their own">
              After {minutes(CMS_IDLE_MS)} minutes without use, or {minutes(CMS_MAX_MS) / 60} hours after signing in — whichever comes first.
            </Rule>
            <Rule icon={<LockKeyhole className="h-4 w-4" />} title="Wrong passwords lock out">
              {MAX_FAILURES} wrong tries within {minutes(WINDOW_MS)} minutes lock that account — and that address — for {minutes(LOCKOUT_MS)} minutes.
            </Rule>
            <Rule icon={<KeyRound className="h-4 w-4" />} title="Nobody types anybody's password">
              Passwords are at least {CMS_MIN_PASSWORD} characters, chosen by each person from a one-time emailed link. Admins send links, never passwords.
            </Rule>
          </ul>
        </Panel>
      </div>
    </>
  );
}

function Rule({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-sunken text-muted">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-text">{title}</p>
        <p className="mt-0.5 text-xs text-muted">{children}</p>
      </div>
    </li>
  );
}
