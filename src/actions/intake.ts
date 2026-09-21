"use server";

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getOrganisation } from "@/lib/organisation";
import { intakeSchema } from "@/lib/validation/intake";
import type { ActionResult } from "@/actions/company";

/**
 * The form a new joiner fills in before they have an account.
 *
 * This is the only module in the app that serves somebody who is not signed in, so the rules are
 * different and worth stating:
 *
 *   · The token *is* the authentication. It is 192 bits of randomness, expires, and is cleared on
 *     submission and on conversion — so a forwarded link is worthless the day after it is used.
 *   · It grants exactly one capability: fill in this one candidate's form. It cannot read anything
 *     else, and what it returns about the candidate is their own name and the company's, which the
 *     holder already knows because they were sent the link.
 *   · What is submitted is stored as a *claim* in `intakeData`. It does not touch the employee
 *     record — there is no employee record yet — and HR applies it at conversion. A form that wrote
 *     straight through would be an unauthenticated write into an HR database.
 *   · A bad token is indistinguishable from an expired or used one, so the page cannot be used to
 *     work out which tokens exist.
 */

/** What the form needs to render itself, and nothing more. */
export async function getIntake(token: string) {
  if (!token || token.length < 10) return null;

  const candidate = await db.candidate.findUnique({
    where: { intakeToken: token },
    select: {
      id: true,
      name: true,
      email: true,
      designation: true,
      expectedJoining: true,
      intakeExpiresAt: true,
      intakeSubmittedAt: true,
      status: true,
    },
  });
  if (!candidate) return null;
  if (candidate.intakeExpiresAt && candidate.intakeExpiresAt < new Date()) return null;
  if (candidate.status === "DECLINED" || candidate.status === "WITHDRAWN" || candidate.status === "JOINED") return null;

  const org = await getOrganisation();
  return {
    name: candidate.name,
    email: candidate.email,
    designation: candidate.designation,
    expectedJoining: candidate.expectedJoining?.toISOString().slice(0, 10) ?? null,
    alreadySubmitted: Boolean(candidate.intakeSubmittedAt),
    companyName: org.legalName || "the company",
  };
}

export async function submitIntake(input: unknown): Promise<ActionResult<null>> {
  const parsed = intakeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const { token, ...data } = parsed.data;

  const candidate = await db.candidate.findUnique({
    where: { intakeToken: token },
    select: { id: true, intakeExpiresAt: true, status: true },
  });
  // Deliberately the same message for every failure — a form that distinguishes "no such link" from
  // "expired link" tells an outsider which tokens are real.
  const refusal = { ok: false as const, error: "This link is no longer valid. Ask your HR contact for a new one." };
  if (!candidate) return refusal;
  if (candidate.intakeExpiresAt && candidate.intakeExpiresAt < new Date()) return refusal;
  if (candidate.status === "DECLINED" || candidate.status === "WITHDRAWN" || candidate.status === "JOINED") return refusal;

  await db.candidate.update({
    where: { id: candidate.id },
    data: {
      intakeData: data as unknown as Prisma.InputJsonValue,
      intakeSubmittedAt: new Date(),
      // Cleared on submission: the form has served its purpose, and a live link afterwards is a way
      // for anybody holding it to overwrite what was sent.
      intakeToken: null,
    },
  });

  return { ok: true, data: null };
}
