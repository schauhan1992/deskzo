import { getIntake } from "@/actions/intake";
import { Card } from "@/components/ui/card";
import { IntakeForm } from "@/components/hr/intake-form";

/**
 * The new-joiner form, reached without signing in.
 *
 * Every failure — no such token, expired, already used, candidate withdrawn — renders the same
 * page. Distinguishing them would turn this into an oracle for working out which tokens are real.
 */
export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = await getIntake(token);

  if (!info) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This link is no longer valid</h1>
        <p className="mt-2 text-sm text-muted">
          It may have expired, or already been used. Ask your HR contact to send you a new one.
        </p>
      </Card>
    );
  }

  return <IntakeForm token={token} info={info} />;
}
