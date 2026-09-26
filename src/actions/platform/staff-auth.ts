"use server";

import { redirect } from "next/navigation";
import { completePasswordSetup } from "@/lib/platform/staff";
import { finishEnrolment, signInStaff, signOutStaff, type SignInResult } from "@/lib/platform/staff-session";

/**
 * Signing in to the console — by definition before anybody is signed in, so these are the console's
 * only actions without `requireStaff` (src/actions/platform/console.ts has the rest). Each does one
 * narrow thing to the caller's own console session: sign in, finish enrolling two-factor, choose a
 * password from a one-time link, sign out.
 */

export async function consoleSignIn(input: { email: string; password: string; code?: string }): Promise<SignInResult> {
  return signInStaff(input);
}

export async function consoleFinishEnrolment(code: string) {
  return finishEnrolment(code);
}

export async function consoleSetPassword(token: string, password: string) {
  return completePasswordSetup(token, password);
}

export async function consoleSignOut(): Promise<void> {
  await signOutStaff();
  redirect("/login");
}
