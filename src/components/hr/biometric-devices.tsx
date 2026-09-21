"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Fingerprint, Link2, Plus, RefreshCw, Upload } from "lucide-react";
import type { listBiometricDevices, mappedEnrolments, recentPunches, unmappedEnrolments } from "@/actions/biometric";
import {
  clearEnrolment,
  importPunchFile,
  mapEnrolment,
  reprocessPunches,
  saveBiometricDevice,
  setBiometricDeviceActive,
} from "@/actions/biometric";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { formatDateTime } from "@/lib/utils";
import { PUNCH_TYPE_LABELS, VERIFY_MODE_LABELS } from "@/lib/hr/iclock";

type Device = Awaited<ReturnType<typeof listBiometricDevices>>[number];
type Unmapped = Awaited<ReturnType<typeof unmappedEnrolments>>[number];
type Mapped = Awaited<ReturnType<typeof mappedEnrolments>>[number];
type Punch = Awaited<ReturnType<typeof recentPunches>>[number];

export function BiometricDevices({
  devices,
  unmapped,
  mapped,
  punches,
  people,
  serverUrl,
}: {
  devices: Device[];
  unmapped: Unmapped[];
  mapped: Mapped[];
  punches: Punch[];
  people: { id: string; name: string }[];
  serverUrl: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);

  function reprocess() {
    setNotice(null);
    startTransition(async () => {
      const result = await reprocessPunches();
      // Told apart. Both outcomes used to land in the same muted line, so "you can't do that" and
      // "1,400 punches processed" were the same sentence in the same grey.
      setNotice(
        result.ok
          ? {
              tone: "success",
              message: `${result.data.punches} punch(es) processed into ${result.data.days} day(s)${result.data.skipped > 0 ? `, ${result.data.skipped} day(s) left alone (leave or a manual correction)` : ""}.`,
            }
          : { tone: "error", message: result.error },
      );
      router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <SetupCard serverUrl={serverUrl} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <DeviceDialog />
          {devices.length > 0 && <ImportDialog devices={devices} />}
        </div>
        <div className="flex items-center gap-2">
          <ActionNoticeRegion notice={notice} />
          <Button size="sm" variant="ghost" disabled={pending} onClick={reprocess}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Reprocess
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <CardHeader className="text-sm font-medium text-text">Terminals</CardHeader>
        <table className="w-full text-sm">
          <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Name</th>
              <th className="px-4 py-2.5">Serial</th>
              <th className="px-4 py-2.5">Last seen</th>
              <th className="px-4 py-2.5">Last punch</th>
              <th className="px-4 py-2.5 text-right">Punches</th>
              <th className="px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5">
                  <span className="font-medium text-text">{d.name}</span>
                  {d.location && <div className="text-xs text-subtle">{d.location}</div>}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-muted">{d.serialNumber}</td>
                <td className="px-4 py-2.5 text-xs text-muted">
                  {d.lastSeenAt ? formatDateTime(d.lastSeenAt) : <span className="text-warning">never</span>}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted">{d.lastPunchAt ? formatDateTime(d.lastPunchAt) : "—"}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted">{d._count.punches}</td>
                <td className="px-4 py-2.5">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await setBiometricDeviceActive(d.id, !d.active);
                        router.refresh();
                      })
                    }
                    title={d.active ? "Disable — its uploads will be refused" : "Enable"}
                  >
                    <Badge tone={d.active ? "green" : "default"}>{d.active ? "Active" : "Disabled"}</Badge>
                  </button>
                </td>
              </tr>
            ))}
            {devices.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-subtle">
                  No terminals registered. Until a serial is registered here, anything it sends is refused.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="text-sm font-medium text-text">
            Unmapped enrolment numbers
            {unmapped.length > 0 && <span className="ml-1.5 text-xs font-normal text-warning">{unmapped.length}</span>}
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-subtle">
              Numbers the terminals have sent that belong to nobody yet. Their punches are kept — mapping one
              recovers everything already collected against it.
            </p>
            {unmapped.length === 0 && <p className="text-sm text-subtle">Every number seen so far is mapped.</p>}
            {unmapped.map((u) => (
              <MapRow key={u.deviceUserId} row={u} people={people} />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-sm font-medium text-text">Mapped</CardHeader>
          <CardContent className="space-y-1.5">
            {mapped.length === 0 && <p className="text-sm text-subtle">Nobody has a biometric number yet.</p>}
            {mapped.map((m) => (
              <div key={m.userId} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <Link href={`/people/${m.user.id}`} className="text-text hover:underline">
                  {m.user.name}
                  {!m.user.active && <span className="ml-1 text-xs text-subtle">(inactive)</span>}
                </Link>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted">#{m.biometricId}</span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        await clearEnrolment(m.userId);
                        router.refresh();
                      })
                    }
                    className="text-xs text-subtle hover:text-danger"
                  >
                    unmap
                  </button>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden p-0">
        <CardHeader className="text-sm font-medium text-text">Recent punches</CardHeader>
        <table className="w-full text-sm">
          <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">When</th>
              <th className="px-4 py-2.5">Who</th>
              <th className="px-4 py-2.5">Terminal</th>
              <th className="px-4 py-2.5">Type</th>
              <th className="px-4 py-2.5">Verified by</th>
            </tr>
          </thead>
          <tbody>
            {punches.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 font-mono text-xs text-text">
                  {String(p.punchedAt).slice(0, 19).replace("T", " ")}
                </td>
                <td className="px-4 py-2.5">
                  {p.user ? (
                    <Link href={`/people/${p.user.id}`} className="text-text hover:underline">
                      {p.user.name}
                    </Link>
                  ) : (
                    <span className="text-warning">#{p.deviceUserId} — unmapped</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">{p.device.name}</td>
                <td className="px-4 py-2.5 text-muted">
                  {p.punchType !== null ? (PUNCH_TYPE_LABELS[p.punchType] ?? p.punchType) : "—"}
                </td>
                <td className="px-4 py-2.5 text-muted">
                  {p.verifyMode !== null ? (VERIFY_MODE_LABELS[p.verifyMode] ?? p.verifyMode) : "—"}
                </td>
              </tr>
            ))}
            {punches.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-subtle">
                  Nothing received yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/** What to type into the terminal's keypad, and the warning that goes with it. */
function SetupCard({ serverUrl }: { serverUrl: string }) {
  let host = serverUrl;
  let port = "80";
  try {
    const parsed = new URL(serverUrl);
    host = parsed.hostname;
    port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    // Leave the raw value — better to show something than nothing.
  }

  return (
    <Card>
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <Fingerprint className="h-4 w-4" />
        Pointing a terminal at this server
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          On the terminal: <span className="text-text">Menu → Comm → Cloud Server / ADMS</span>, then set:
        </p>
        <div className="grid grid-cols-1 gap-2 rounded-base border border-line bg-surface-sunken px-3 py-2 font-mono text-xs sm:grid-cols-3">
          <div>
            <div className="text-subtle">Server address</div>
            <div className="text-text">{host}</div>
          </div>
          <div>
            <div className="text-subtle">Server port</div>
            <div className="text-text">{port}</div>
          </div>
          <div>
            <div className="text-subtle">Enable domain name</div>
            <div className="text-text">OFF (unless using a hostname)</div>
          </div>
        </div>
        <p className="text-xs text-muted">
          Register the terminal&apos;s serial below first — until then its uploads are refused. The serial is on the
          sticker underneath, and on the device under <span className="text-text">Menu → System → Device Info</span>.
        </p>
        <p className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
          The protocol these terminals speak carries no authentication — the firmware offers no way to add one. Keep
          this server reachable only from the office network or over a VPN, never open to the internet.
        </p>
      </CardContent>
    </Card>
  );
}

function MapRow({ row, people }: { row: Unmapped; people: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function map() {
    if (!userId) return;
    setError(null);
    startTransition(async () => {
      const result = await mapEnrolment(userId, row.deviceUserId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(`${result.data.linked} punch(es) recovered into ${result.data.days} day(s).`);
      router.refresh();
    });
  }

  if (done) return <p className="text-xs text-success">#{row.deviceUserId} mapped — {done}</p>;

  return (
    <div className="rounded-base border border-line p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-text">#{row.deviceUserId}</span>
        <span className="text-xs text-subtle">
          {row.punches} punch(es)
          {row.lastSeen && ` · last ${String(row.lastSeen).slice(0, 10)}`}
        </span>
        {/*
          One of these per unmapped enrolment, so the device number goes in the name — a column of
          selects all called "Who is this?" tells a reader nothing about which one they are on.
        */}
        <Select
          aria-label={`Person for enrolment #${row.deviceUserId}`}
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="h-8 flex-1 text-xs"
        >
          <option value="">Who is this?</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={pending || !userId} onClick={map}>
          <Link2 className="mr-1 h-3 w-3" />
          Map
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

function DeviceDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ serialNumber: "", name: "", location: "", timezone: "Asia/Kolkata" });

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveBiometricDevice(form);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setForm({ serialNumber: "", name: "", location: "", timezone: "Asia/Kolkata" });
      router.refresh();
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Register terminal
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Register a biometric terminal">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="serial">Serial number</Label>
            <Input
              id="serial"
              value={form.serialNumber}
              onChange={(e) => setForm((f) => ({ ...f, serialNumber: e.target.value.toUpperCase() }))}
              placeholder="CJXK194860123"
              className="font-mono"
            />
            <p className="text-xs text-subtle">
              Exactly as the device reports it — this is the only thing identifying it, and a mismatch means every
              upload is refused.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="devName">Name</Label>
              <Input
                id="devName"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Main gate"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="devLoc">Location</Label>
              <Input
                id="devLoc"
                value={form.location}
                onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                placeholder="Noida office, ground floor"
              />
            </div>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button disabled={pending || !form.serialNumber || !form.name} onClick={save}>
              {pending ? "Saving…" : "Register"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function ImportDialog({ devices }: { devices: Device[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? "");
  const [contents, setContents] = useState("");

  function submit() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await importPunchFile(deviceId, contents);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const d = result.data;
      setNotice(
        `${d.parsed} row(s) read, ${d.stored} new, ${d.linked} matched to people, ${d.days} attendance day(s) written${d.rejected > 0 ? `. ${d.rejected} row(s) unreadable.` : "."}`,
      );
      setContents("");
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Upload className="mr-1.5 h-3.5 w-3.5" />
        Import a file
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Import attendance from a file">
        <div className="space-y-4">
          <p className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">
            For sites where the terminal can&apos;t reach this server. Export from eTimeTrackLite (or pull the .dat off
            the device) and paste it here — it&apos;s the same tab-separated format the terminals push, so the same
            reader handles it. Re-importing the same file is harmless.
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="impDevice">Which terminal did it come from?</Label>
            <Select id="impDevice" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.serialNumber})
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="impBody">File contents</Label>
            <textarea
              id="impBody"
              rows={8}
              value={contents}
              onChange={(e) => setContents(e.target.value)}
              placeholder={"1\t2026-09-18 09:15:00\t0\t1\t0\t0\n2\t2026-09-18 09:22:14\t0\t1\t0\t0"}
              className="w-full rounded-base border border-line-strong bg-surface px-3 py-2 font-mono text-xs text-text"
            />
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}
          {notice && <p className="text-sm text-success">{notice}</p>}

          <div className="flex gap-2">
            <Button disabled={pending || !contents.trim() || !deviceId} onClick={submit}>
              {pending ? "Importing…" : "Import"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
