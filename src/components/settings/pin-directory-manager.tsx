"use client";

import { useEffect, useState, useTransition } from "react";
import {
  getPinDirectory,
  removePinDirectoryApiKey,
  savePinDirectoryApiKey,
  startPinDirectorySync,
  type PinDirectoryState,
} from "@/actions/reference-data";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";

/** India time, stated — the server and the browser must print the same thing for hydration. */
const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso))
    : "—";

/**
 * The PIN directory's settings: what is loaded, the API key, and a Sync button.
 *
 * While a sync runs, this asks for the row every two seconds and draws the bar from it. The worker
 * doing the sync is a separate process (see `startPinDirectorySync`), so closing this page does not
 * stop it — coming back shows where it has got to.
 */
export function PinDirectoryManager({ initial }: { initial: PinDirectoryState }) {
  const [state, setState] = useState(initial);
  const [keyInput, setKeyInput] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const { loaded, sync } = state;
  const running = sync.status === "RUNNING" && !sync.stale;

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      getPinDirectory()
        .then((result) => {
          if (result.ok) setState(result.data);
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [running]);

  function refresh() {
    return getPinDirectory().then((result) => {
      if (result.ok) setState(result.data);
    });
  }

  function run(action: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      after?.();
      await refresh();
    });
  }

  const percent = sync.total ? Math.min(100, Math.round((sync.fetched / sync.total) * 100)) : null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="text-sm font-medium text-text">What is loaded</CardHeader>
        <CardContent className="space-y-2 text-sm">
          {loaded ? (
            <>
              <p className="text-text">
                <span className="font-medium">{loaded.postOffices.toLocaleString("en-IN")}</span> post offices across{" "}
                <span className="font-medium">{loaded.pincodes.toLocaleString("en-IN")}</span> PIN codes
              </p>
              <p className="text-muted">
                From {loaded.source}, loaded {when(loaded.loadedAt)}. The Department of Posts updates it monthly.
              </p>
              {Object.keys(loaded.unresolvedStates).length > 0 && (
                <p className="text-xs text-warning">
                  Some state names in it did not match a GST state, so those PINs will not fill a state in:{" "}
                  {Object.entries(loaded.unresolvedStates)
                    .map(([name, n]) => `${name} (${n})`)
                    .join(", ")}
                  .
                </p>
              )}
            </>
          ) : (
            <p className="text-muted">
              Not loaded yet. Address forms still work — typed PINs just aren&apos;t looked up until it is.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Sync from data.gov.in</CardHeader>
        <CardContent className="space-y-4 text-sm">
          {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-danger">{error}</p>}

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-medium text-text">API key</span>
              {sync.hasApiKey ? <Badge tone="green">Saved</Badge> : <Badge>Not set</Badge>}
            </div>

            {sync.hasApiKey && !replacing ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-muted">Stored encrypted. It is never shown again — to change it, replace it.</p>
                <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => setReplacing(true)}>
                  Replace
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending || running}
                  onClick={() => run(removePinDirectoryApiKey)}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(
                    () => savePinDirectoryApiKey(keyInput),
                    () => {
                      setKeyInput("");
                      setReplacing(false);
                    },
                  );
                }}
              >
                <div className="min-w-64 flex-1 space-y-1.5">
                  <Label htmlFor="pin-api-key">data.gov.in API key</Label>
                  {/* A password field so it is not left readable on screen, and never autofilled. */}
                  <Input
                    id="pin-api-key"
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste the key from your data.gov.in account"
                  />
                </div>
                <Button type="submit" size="sm" disabled={pending || !keyInput.trim()}>
                  Save key
                </Button>
                {replacing && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setReplacing(false)}>
                    Cancel
                  </Button>
                )}
              </form>
            )}
            <p className="text-xs text-subtle">
              Free from data.gov.in: sign in, then My Account → Generate API key. It is used for nothing but this sync.
            </p>
          </div>

          <div className="space-y-2 border-t border-line pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={pending || running || !sync.hasApiKey}
                onClick={() => run(startPinDirectorySync)}
              >
                {running ? "Syncing…" : "Sync now"}
              </Button>
              <p className="text-xs text-subtle">
                A few minutes. It runs on the server — you can leave this page. The directory is replaced in one step
                at the end; addresses already saved are not changed.
              </p>
            </div>

            {running && (
              <div className="space-y-1">
                <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className="h-full rounded-full bg-brand transition-[width] duration-500"
                    style={{ width: `${percent ?? 5}%` }}
                  />
                </div>
                <p className="text-xs text-muted">
                  {sync.message}
                  {sync.total ? ` ${sync.fetched.toLocaleString("en-IN")} of ${sync.total.toLocaleString("en-IN")}` : ""}
                </p>
              </div>
            )}

            {sync.stale && (
              <p className="text-xs text-warning">
                The sync started {when(sync.startedAt)} stopped without finishing. Press Sync now to start it again.
              </p>
            )}
            {sync.status === "SUCCEEDED" && (
              <p className="text-xs text-success">
                {sync.message} <span className="text-subtle">({when(sync.finishedAt)})</span>
              </p>
            )}
            {sync.status === "FAILED" && (
              <p className="text-xs text-danger">
                Last sync failed: {sync.message} <span className="text-subtle">({when(sync.finishedAt)})</span>
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
