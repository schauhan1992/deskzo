import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Container, Eyebrow } from "@/components/site/ui";
import { PrivacyRequestForm } from "@/components/site/forms/privacy-request-form";
import { getSiteSettings } from "@/lib/platform/site-content";

export const metadata: Metadata = {
  title: "Privacy requests",
  description: "Ask for a copy of your personal data, a correction or erasure, withdraw your consent, nominate someone, or raise a grievance.",
};

/**
 * Privacy requests (owner, 23 Oct 2026): the channel the privacy notice promises for the rights the DPDP Act
 * and the GDPR give a person — handled in the console's Privacy requests, due within 30 days
 * (src/lib/platform/privacy-requests.ts). The grievance officer, from Settings › General, is named here too.
 */
export default async function PrivacyRequestPage() {
  const settings = await getSiteSettings();
  const officer = settings.privacy.officer.trim();
  const email = settings.privacy.email.trim();
  return (
    <>
      <section className="relative overflow-hidden border-b border-line">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_0%_0%,color-mix(in_srgb,var(--brand)_10%,transparent),transparent_70%)]" />
        <Container className="relative py-14 sm:py-20">
          <div className="max-w-3xl">
            <Eyebrow>Your data, your rights</Eyebrow>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">Privacy requests</h1>
            <p className="mt-5 text-base leading-7 text-muted text-pretty sm:text-lg sm:leading-8">
              Ask for a copy of your personal data, have it corrected or erased, withdraw your consent, nominate someone to act for you, or raise a grievance. We
              reply within 30 days — the{" "}
              <Link href="/privacy" className="font-medium text-text underline underline-offset-2">
                privacy notice
              </Link>{" "}
              says how we handle your data.
            </p>
          </div>
        </Container>
      </section>
      <Container className="py-12 sm:py-16">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
            <PrivacyRequestForm />
          </div>
          <aside className="space-y-4 text-sm leading-6 text-muted">
            <div className="rounded-2xl border border-line bg-surface-sunken p-5">
              <p className="flex items-center gap-2 font-semibold text-text">
                <ShieldCheck aria-hidden="true" className="h-4 w-4 text-brand" />
                Grievance officer
              </p>
              {officer ? (
                <p className="mt-2">
                  {officer}
                  {email && (
                    <>
                      <br />
                      <a href={`mailto:${email}`} className="text-text underline underline-offset-2">
                        {email}
                      </a>
                    </>
                  )}
                  {settings.privacy.phone.trim() && (
                    <>
                      <br />
                      {settings.privacy.phone.trim()}
                    </>
                  )}
                  {settings.privacy.address.trim() && <span className="mt-2 block whitespace-pre-line">{settings.privacy.address.trim()}</span>}
                </p>
              ) : (
                <p className="mt-2">To be named. Until then, use this form — every request reaches us.</p>
              )}
            </div>
            <p>
              <strong className="font-medium text-text">Data a company keeps in its own Deskzo</strong> — your employer&apos;s, or a business you deal with — is
              that company&apos;s to answer for. Ask it first; we&apos;ll help if it doesn&apos;t answer.
            </p>
            <p>
              <strong className="font-medium text-text">Another language?</strong> This page and the privacy notice are in English. Ask in your request to receive them
              in any language listed in the Eighth Schedule to the Constitution of India.
            </p>
          </aside>
        </div>
      </Container>
    </>
  );
}
