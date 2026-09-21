"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, ExternalLink, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { deleteKiosk, rotateKioskToken, saveKiosk } from "@/actions/visitor";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { Checkbox } from "@/components/ui/bulk-select";
import { OutboundLink } from "@/components/ui/outbound-link";
import { formatDateTime } from "@/lib/utils";

type Kiosk = {
  id: string;
  name: string;
  token: string;
  active: boolean;
  lastUsedAt: string | Date | null;
  _count: { entries: number };
};

/**
 * Setting up a reception tablet.
 *
 * The link is the whole of the security, so this screen says so rather than presenting it as an
 * ordinary URL to be pasted around. Rotating it is one click and immediate, because the only
 * remedy for a link that has gone somewhere unexpected is a different link.
 */
export function KioskManager({ kiosks, origin }: { kiosks: Kiosk[]; origin: string }) {
  const router = useRouter();
  const [adding, setAdding] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-4">
      <Card className="border-warning/40 bg-warning-bg">
        <CardContent className="flex items-start gap-2.5 py-3 text-sm text-warning">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            A kiosk link needs no login. Anybody who opens it can see every employee&apos;s name and department —
            that&apos;s what lets a visitor say who they&apos;re here to see. No contact details, nothing about
            customers. Treat the link like a key to the lobby, and rotate it if it goes anywhere unexpected.
          </p>
        </CardContent>
      </Card>

      {kiosks.map((k) => (
        <KioskCard key={k.id} kiosk={k} origin={origin} />
      ))}

      <Card>
        <CardHeader className="text-sm font-medium text-text">Add a desk</CardHeader>
        <CardContent className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1 space-y-1.5">
            <Label htmlFor="new-kiosk">Where is it?</Label>
            <Input id="new-kiosk" value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Main reception" />
          </div>
          <Button
            disabled={pending || !adding.trim()}
            onClick={() =>
              startTransition(async () => {
                const result = await saveKiosk({ name: adding });
                if (!result.ok) {
                  alert(result.error);
                  return;
                }
                setAdding("");
                router.refresh();
              })
            }
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Create
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function KioskCard({ kiosk, origin }: { kiosk: Kiosk; origin: string }) {
  const router = useRouter();
  const [token, setToken] = useState(kiosk.token);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const url = `${origin}/kiosk/${token}`;

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text">{kiosk.name}</span>
              {!kiosk.active && <Badge tone="default">Off</Badge>}
            </div>
            <p className="text-xs text-subtle">
              {kiosk._count.entries} sign-ins
              {kiosk.lastUsedAt ? ` · last used ${formatDateTime(new Date(kiosk.lastUsedAt))}` : " · never used"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <Checkbox
                checked={kiosk.active}
                onChange={async () => {
                  await saveKiosk({ id: kiosk.id, name: kiosk.name, active: !kiosk.active });
                  router.refresh();
                }}
              />
              In service
            </label>
            <IconButton
              icon={Trash2}
              label="Delete"
              tone="danger"
              onClick={async () => {
                const result = await deleteKiosk(kiosk.id);
                if (!result.ok) alert(result.error);
                router.refresh();
              }}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Tablet link</Label>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-base bg-surface-sunken px-3 py-2 font-mono text-xs text-text">
              {url}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              {copied ? "Copied" : "Copy"}
            </Button>
            {/*
              The kiosk link carries its token in the path, and a bare `rel="noreferrer"` is one
              careless edit away from leaking it in a Referer header. This is the component that
              belts and braces it.
            */}
            <OutboundLink href={url}>
              <Button size="sm" variant="secondary">
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                Open
              </Button>
            </OutboundLink>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  if (!confirm("Rotate the link? The tablet will stop working until it's re-opened on the new URL.")) return;
                  const result = await rotateKioskToken(kiosk.id);
                  if (!result.ok) {
                    alert(result.error);
                    return;
                  }
                  setToken(result.data.token);
                  router.refresh();
                })
              }
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Rotate
            </Button>
          </div>
        </div>

        <InstallSteps url={url} />
      </CardContent>
    </Card>
  );
}

/**
 * How to turn the link into the app on the tablet.
 *
 * Written out rather than hidden behind a button that claims to "generate an app", because that is
 * not what happens — there is no file to download. The browser installs it from the manifest, and
 * the instructions differ per platform, so the honest version of that button is these four lines.
 */
function InstallSteps({ url }: { url: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-base border border-line p-3">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between text-left text-sm text-text">
        <span className="font-medium">Put it on the tablet as an app</span>
        <span className="text-xs text-muted">{open ? "Hide" : "Show me how"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3 text-xs leading-5 text-muted">
          <ol className="list-decimal space-y-1.5 pl-4">
            <li>Open the link above in Chrome on the tablet.</li>
            <li>
              Menu <span className="text-text">⋮</span> → <span className="text-text">Add to Home screen</span> →{" "}
              <span className="text-text">Install</span>. On an iPad it&apos;s Share →{" "}
              <span className="text-text">Add to Home Screen</span>.
            </li>
            <li>Open it from the home screen icon, not the browser.</li>
            <li>In the tablet&apos;s settings, switch off the screen lock and set the display to stay on.</li>
          </ol>
          <p className="rounded-base bg-surface-sunken p-2.5">
            Launched from the icon it runs full screen with no address bar, so the link isn&apos;t on show in the
            lobby — which matters here, because the link <em>is</em> the password.
          </p>
          <p className="break-all font-mono text-[11px] text-subtle">{url}</p>
        </div>
      )}
    </div>
  );
}
