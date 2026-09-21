"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Globe, Link2, Plus, ShieldOff } from "lucide-react";
import {
  createPortalLogin,
  portalLogins,
  revokePortalLogin,
  setCompanyPortalAccess,
  type PortalLoginRow,
} from "@/actions/portal";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { formatDate, formatDateTime } from "@/lib/utils";

/**
 * Granting one customer a portal, and handing out their links.
 *
 * The three-way access control is the fiddly bit and it is spelled out rather than reduced to a
 * toggle: "follow the default" is a real and usually correct answer, and a two-state switch would
 * force every company into an explicit yes or no — after which changing the default would reach
 * nobody.
 */

export function CompanyPortalPanel({
  companyId,
  initialOverride,
  initialStatus,
  initialLogins,
  contacts,
}: {
  companyId: string;
  initialOverride: boolean | null;
  initialStatus: { allowed: boolean; because: string | null };
  initialLogins: PortalLoginRow[];
  contacts: { id: string; name: string; email: string | null }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState<boolean | null>(initialOverride);
  const [status, setStatus] = useState(initialStatus);
  const [logins, setLogins] = useState<PortalLoginRow[]>(initialLogins);
  const [contactId, setContactId] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const rows = await portalLogins(companyId);
    if (rows.ok) setLogins(rows.data);
  };

  const changeAccess = (value: string) => {
    const next = value === "default" ? null : value === "on";
    setBusy(true);
    setError(null);
    startTransition(async () => {
      const result = await setCompanyPortalAccess({ companyId, enabled: next });
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOverride(next);
      // The verdict depends on the global settings too, so it is re-read rather than guessed at.
      router.refresh();
      setStatus({ allowed: next === true || (next === null && status.allowed), because: null });
    });
  };

  const issue = () => {
    setBusy(true);
    setError(null);
    startTransition(async () => {
      const result = await createPortalLogin({ companyId, contactId: contactId || null });
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setContactId("");
      await refresh();
    });
  };

  const revoke = (loginId: string) => {
    setBusy(true);
    startTransition(async () => {
      await revokePortalLogin({ loginId });
      setBusy(false);
      await refresh();
    });
  };

  /**
   * Copied as an absolute URL built in the browser.
   *
   * The server stores a path, because it does not reliably know its own public hostname and a link
   * with the wrong one baked in is worse than no link. The browser does know, because it is looking
   * at it.
   */
  const copy = async (url: string, id: string) => {
    const absolute = `${window.location.origin}${url}`;
    try {
      await navigator.clipboard.writeText(absolute);
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard access is refused on an unfocused document, over plain HTTP, and by policy. A
      // prompt is ugly and always works.
      window.prompt("Copy this link:", absolute);
    }
  };

  const active = logins.filter((l) => !l.revokedAt);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-text">
          <Globe className="h-4 w-4 text-muted" />
          Customer portal
        </div>
        {status.allowed ? (
          <Badge tone="green">
            {active.length} live link{active.length === 1 ? "" : "s"}
          </Badge>
        ) : (
          <Badge tone="default">
            <ShieldOff className="h-3 w-3" />
            No access
          </Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {error && (
          <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="portal-access" className="text-sm text-muted">
            Access
          </label>
          <Select
            id="portal-access"
            className="h-8 w-auto text-[13px]"
            disabled={busy}
            value={override === null ? "default" : override ? "on" : "off"}
            onChange={(e) => changeAccess(e.target.value)}
          >
            <option value="default">Follow the default</option>
            <option value="on">Always on for this customer</option>
            <option value="off">Never for this customer</option>
          </Select>
        </div>

        {status.because && <p className="text-sm text-muted">{status.because}</p>}

        {status.allowed && (
          <>
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {/* The question is asked by the placeholder option, which vanishes on the first pick. */}
              <Select
                aria-label="Who is the link for?"
                className="h-8 min-w-48 flex-1 text-[13px]"
                value={contactId}
                disabled={busy}
                onChange={(e) => setContactId(e.target.value)}
              >
                <option value="">Who is the link for?</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.email ? ` — ${c.email}` : ""}
                  </option>
                ))}
              </Select>
              <Button size="sm" disabled={busy || !contactId} onClick={issue}>
                <Plus className="h-3.5 w-3.5" />
                Create a link
              </Button>
            </div>

            {logins.length > 0 && (
              <ul className="divide-y divide-line">
                {logins.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="text-sm text-text">
                        {l.personName}
                        {l.revokedAt && <span className="ml-2 text-xs text-muted">revoked</span>}
                      </p>
                      <p className="text-xs text-muted">
                        {l.visits === 0 ? "Never opened" : `Opened ${l.visits}×`}
                        {l.lastSeenAt ? `, last ${formatDateTime(l.lastSeenAt)}` : ""}
                        {l.expiresAt ? ` · expires ${formatDate(l.expiresAt)}` : " · no expiry"}
                      </p>
                    </div>
                    {!l.revokedAt && (
                      <div className="flex shrink-0 gap-1">
                        <Button size="sm" variant="secondary" onClick={() => copy(l.url, l.id)}>
                          {copied === l.id ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                          {copied === l.id ? "Copied" : "Copy link"}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => revoke(l.id)}>
                          Revoke
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {logins.length === 0 && (
              <p className="flex items-start gap-2 text-sm text-muted">
                <Link2 className="mt-0.5 h-4 w-4 shrink-0" />
                No links yet. Pick a contact and create one, then email it to them.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
