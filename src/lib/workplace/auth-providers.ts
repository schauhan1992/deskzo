import Google from "next-auth/providers/google";
import Zoho from "next-auth/providers/zoho";
import type { Provider } from "@auth/core/providers";
import { getCachedWorkplaceSettings, googleApp, zohoApp } from "@/lib/workplace/settings";
import { accountAddress } from "@/lib/workplace/sign-in";
import { ZOHO_REGIONS } from "@/lib/workplace/providers";

/**
 * "Sign in with Google" and "Sign in with Zoho", each with the company's own app — for src/lib/auth.ts,
 * beside Microsoft's. Only what is set up and switched on (Settings → Security). Who may come in
 * through them is ssoVerdict's to say (src/lib/workplace/sign-in.ts), in Auth.js's signIn callback;
 * the address is lower-cased here, as accounts are stored.
 */
export async function workplaceSignInProviders(): Promise<Provider[]> {
  const workplace = await getCachedWorkplaceSettings();
  const providers: Provider[] = [];

  const google = workplace?.googleSso ? await googleApp() : null;
  if (google) {
    providers.push(
      Google({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        // `hd` only steers Google's account picker; the ID token's own `hd` is what is checked.
        authorization: { params: { prompt: "select_account", ...(google.domain ? { hd: google.domain } : {}) } },
        profile: (p) => ({ id: p.sub, name: p.name, email: accountAddress(p.email), image: p.picture }),
      }),
    );
  }

  const zoho = workplace?.zohoSso ? await zohoApp() : null;
  if (zoho) {
    // The company's data centre — a Zoho sign-in code can only be spent at the accounts server it came from.
    const accounts = ZOHO_REGIONS[zoho.region].accounts;
    providers.push(
      Zoho({
        clientId: zoho.clientId,
        clientSecret: zoho.clientSecret,
        authorization: { url: `${accounts}/oauth/v2/auth`, params: { scope: "AaaServer.profile.Read" } },
        token: `${accounts}/oauth/v2/token`,
        userinfo: {
          url: `${accounts}/oauth/user/info`,
          // Zoho's own header, not a Bearer one.
          request: async ({ tokens }: { tokens: { access_token?: string } }) => {
            const res = await fetch(`${accounts}/oauth/user/info`, {
              headers: { authorization: `Zoho-oauthtoken ${tokens.access_token ?? ""}` },
              signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) throw new Error(`Zoho's user info answered ${res.status}`);
            return (await res.json()) as Record<string, unknown>;
          },
        },
        // As Zoho documents it: the secret in the form, and the state checked on the way back.
        client: { token_endpoint_auth_method: "client_secret_post" },
        checks: ["state"],
        profile: (p) => ({
          id: String(p.ZUID ?? ""),
          name: String(p.Display_Name ?? [p.First_Name, p.Last_Name].filter(Boolean).join(" ")),
          email: accountAddress(p.Email),
          image: null,
        }),
      }),
    );
  }
  return providers;
}
