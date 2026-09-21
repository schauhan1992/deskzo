import { notFound } from "next/navigation";
import { getOwnProfile } from "@/actions/profile";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ChangePasswordForm } from "@/components/profile/change-password-form";
import { TwoFactorSetup } from "@/components/profile/two-factor-setup";
import { PhotoManager } from "@/components/profile/photo-manager";
import { ContactForm } from "@/components/profile/contact-form";

export default async function ProfilePage() {
  const [profile, security] = await Promise.all([getOwnProfile(), getCachedSecuritySettings()]);
  if (!profile) notFound();

  const twoFactorEnabled = !!profile.twoFactorEnabledAt;
  const mustSetUpTwoFactor = !!security?.enforceTwoFactor && !twoFactorEnabled;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">My profile</h1>
        <p className="mt-1 text-sm text-muted">Account details, password, and two-factor authentication.</p>
      </div>

      {profile.mustChangePassword && (
        <div className="rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">
          Your administrator created this account with a temporary password — set a new one below before continuing.
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
                Name, role, and department are managed by an admin under Users &amp; Access.
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

        <Card className="self-start">
          <CardHeader className="text-sm font-medium text-text">Two-factor authentication</CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted">
              Adds a 6-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator, etc.) on
              top of your password at sign-in.
            </p>
            <TwoFactorSetup enabled={twoFactorEnabled} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
