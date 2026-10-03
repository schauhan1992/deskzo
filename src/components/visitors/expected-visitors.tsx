"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, Copy, Plus, X } from "lucide-react";
import type { VisitorInviteStatus, VisitorPurpose } from "@prisma/client";
import { cancelInvite, createInvite, expireStaleInvites } from "@/actions/visitor";
import { inviteMessage } from "@/lib/visitors/invite-code";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";

type Invite = {
  id: string;
  code: string;
  purpose: VisitorPurpose;
  name: string;
  phone: string | null;
  email: string | null;
  company: string | null;
  note: string | null;
  expectedAt: string | Date;
  expectedCompanions: number;
  status: VisitorInviteStatus;
  host: { id: string; name: string };
  createdBy: { name: string } | null;
  entry: { id: string; checkedInAt: string | Date } | null;
};

const statusTone: Record<VisitorInviteStatus, "green" | "blue" | "default" | "amber"> = {
  PENDING: "blue",
  ARRIVED: "green",
  CANCELLED: "default",
  EXPIRED: "amber",
};

const statusLabels: Record<VisitorInviteStatus, string> = {
  PENDING: "Expected",
  ARRIVED: "Arrived",
  CANCELLED: "Cancelled",
  EXPIRED: "Didn't come",
};

const purposeLabels: Record<VisitorPurpose, string> = {
  MEETING: "Meeting",
  INTERVIEW: "Interview",
  DELIVERY: "Delivery",
  VENDOR: "Vendor",
  OTHER: "Other",
};

export function ExpectedVisitors({
  invites,
  people,
  myUserId,
  companyName,
  canSeeAll,
}: {
  invites: Invite[];
  people: { id: string; name: string }[];
  myUserId: string;
  companyName: string;
  canSeeAll: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();

  const pendingInvites = invites.filter((i) => i.status === "PENDING");
  const rest = invites.filter((i) => i.status !== "PENDING");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          {pendingInvites.length} expected
          {canSeeAll ? " across the company" : ""}
        </p>
        <div className="flex gap-2">
          {rest.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  await expireStaleInvites();
                  router.refresh();
                })
              }
            >
              Tidy up old ones
            </Button>
          )}
          {!adding && (
            <Button onClick={() => setAdding(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Invite a visitor
            </Button>
          )}
        </div>
      </div>

      {adding && (
        <InviteForm
          people={people}
          myUserId={myUserId}
          companyName={companyName}
          onDone={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      )}

      {invites.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted">
            Nobody is expected. Invite someone and they&apos;ll get a code to type at reception.
          </CardContent>
        </Card>
      ) : (
        [...pendingInvites, ...rest].map((i) => (
          <InviteCard key={i.id} invite={i} companyName={companyName} />
        ))
      )}
    </div>
  );
}

function InviteCard({ invite, companyName }: { invite: Invite; companyName: string }) {
  const router = useRouter();
  const clock = useClock();
  const [copied, setCopied] = useState(false);
  const when = new Date(invite.expectedAt);

  const message = inviteMessage({
    name: invite.name,
    code: invite.code,
    hostName: invite.host.name,
    companyName,
    expectedAt: when,
    formatWhen: (d) => clock.dateTimeShort(d),
  });

  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-text">{invite.name}</span>
              <Badge tone="default">{purposeLabels[invite.purpose]}</Badge>
              <Badge tone={statusTone[invite.status]}>{statusLabels[invite.status]}</Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {[invite.company, invite.phone, invite.email].filter(Boolean).join(" · ")}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
              <CalendarClock className="h-3 w-3" />
              {clock.dateTimeShort(when)} · to see {invite.host.name}
              {invite.expectedCompanions > 0 && ` · with ${invite.expectedCompanions} other${invite.expectedCompanions === 1 ? "" : "s"}`}
              {invite.createdBy && ` · booked by ${invite.createdBy.name}`}
            </p>
            {invite.note && <p className="mt-1 text-xs text-muted">{invite.note}</p>}
            {invite.entry && (
              <p className="mt-1 text-xs text-success">
                Signed in {clock.dateTimeShort(invite.entry.checkedInAt)}
              </p>
            )}
          </div>

          {invite.status === "PENDING" && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <code className="rounded-base bg-surface-sunken px-3 py-2 font-mono text-sm tracking-widest text-text">
                {invite.code}
              </code>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(message);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
                {copied ? "Copied" : "Copy message"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (!confirm(`Cancel ${invite.name}'s visit? Their code stops working.`)) return;
                  const result = await cancelInvite(invite.id);
                  if (!result.ok) alert(result.error);
                  router.refresh();
                }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>

        {invite.status === "PENDING" && (
          <p className="border-t border-line pt-2 text-xs text-subtle">
            {/* Said plainly, because nothing sends it for them. */}
            Send the message yourself — by WhatsApp or email. The code works on the day and the following
            morning, and only at a reception tablet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function InviteForm({
  people,
  myUserId,
  companyName,
  onDone,
}: {
  people: { id: string; name: string }[];
  myUserId: string;
  companyName: string;
  onDone: () => void;
}) {
  // "When" is typed on the workspace's clock, whatever the browser's is: `createInvite` reads it on the same one.
  const clock = useClock();
  const [f, setF] = useState({
    name: "",
    phone: "",
    email: "",
    company: "",
    note: "",
    expectedAt: "",
    expectedCompanions: "0",
  });
  const [hostUserId, setHostUserId] = useState(myUserId);
  const [purpose, setPurpose] = useState<VisitorPurpose>("MEETING");
  const [created, setCreated] = useState<{ code: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (k: keyof typeof f, v: string) => setF((prev) => ({ ...prev, [k]: v }));

  if (created) {
    const message = inviteMessage({
      name: f.name,
      code: created.code,
      hostName: people.find((p) => p.id === hostUserId)?.name ?? "your host",
      companyName,
      // The server has read this already and accepted it, so it parses; "—" if it somehow didn't.
      expectedAt: clock.parseInput(f.expectedAt) ?? new Date(Number.NaN),
      formatWhen: (d) => clock.dateTimeShort(d),
    });
    return (
      <Card>
        <CardHeader className="text-sm font-medium text-text">Invitation created</CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-base bg-surface-sunken p-4 text-center">
            <p className="text-xs uppercase tracking-wide text-subtle">Their code</p>
            <p className="font-mono text-3xl tracking-[0.3em] text-text">{created.code}</p>
          </div>
          <Textarea aria-label="Invitation message" rows={9} readOnly value={message} className="font-mono text-xs" />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={async () => {
                await navigator.clipboard.writeText(message);
              }}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              Copy the message
            </Button>
            <Button variant="secondary" onClick={onDone}>
              Done
            </Button>
          </div>
          <p className="text-xs text-subtle">
            Nothing is emailed automatically — send this however you normally reach them.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Invite a visitor</CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="i-name">Who&apos;s coming</Label>
            <Input id="i-name" value={f.name} onChange={(e) => set("name", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="i-when">When ({clock.zone.replace(/_/g, " ")} time)</Label>
            <Input id="i-when" type="datetime-local" value={f.expectedAt} onChange={(e) => set("expectedAt", e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="i-phone">Phone</Label>
            <Input id="i-phone" value={f.phone} onChange={(e) => set("phone", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="i-email">Email</Label>
            <Input id="i-email" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="i-company">Company</Label>
            <Input id="i-company" value={f.company} onChange={(e) => set("company", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="i-purpose">What for</Label>
            <Select id="i-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value as VisitorPurpose)}>
              {(Object.keys(purposeLabels) as VisitorPurpose[]).map((p) => (
                <option key={p} value={p}>{purposeLabels[p]}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="i-with">Others with them</Label>
            <Input
              id="i-with"
              type="number"
              min={0}
              value={f.expectedCompanions}
              onChange={(e) => set("expectedCompanions", e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="i-host">Here to see</Label>
          <Select id="i-host" value={hostUserId} onChange={(e) => setHostUserId(e.target.value)}>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === myUserId ? `${p.name} (you)` : p.name}
              </option>
            ))}
          </Select>
          {hostUserId !== myUserId && (
            <p className="text-xs text-subtle">They&apos;ll be told you booked this for them.</p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="i-note">What it&apos;s about</Label>
          <Input id="i-note" value={f.note} onChange={(e) => set("note", e.target.value)} />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button
            disabled={pending || !f.name.trim() || !f.expectedAt}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await createInvite({
                  hostUserId,
                  purpose,
                  ...f,
                  expectedCompanions: Number(f.expectedCompanions) || 0,
                });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setCreated({ code: result.data.code });
              })
            }
          >
            {pending ? "Creating…" : "Create the invitation"}
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
