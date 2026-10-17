"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MonitorPlay, Trash2 } from "lucide-react";
import { pairTvScreen, removeTvScreen, updateTvScreen, type TvScreenRow } from "@/actions/tv";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";

const ONLINE_MS = 3 * 60_000;

/**
 * TV screens (owner, 17 Oct 2026): pair a TV by the code it shows, choose whose wins it shows — a branch's,
 * or the whole company's — rename it or take it off. A TV checks in about once a minute, so one seen in
 * the last few minutes is on.
 */
export function TvScreensManager({
  screens,
  branches,
  initialCode,
  origin,
}: {
  screens: TvScreenRow[];
  branches: { id: string; name: string }[];
  initialCode: string;
  origin: string;
}) {
  const router = useRouter();
  const clock = useClock();
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState("");
  const [branchId, setBranchId] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const run = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string, after?: () => void) =>
    start(async () => {
      setMessage(null);
      const result = await work();
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      after?.();
      setMessage({ tone: "ok", text: done });
      router.refresh();
    });

  const branchName = (id: string | null | undefined) => (id ? (branches.find((b) => b.id === id)?.name ?? "A branch") : "Whole company");

  return (
    <div className="space-y-6">
      <Card className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <MonitorPlay className="mt-0.5 h-5 w-5 text-brand" />
          <div className="text-sm text-muted">
            On the TV&apos;s browser, open <span className="font-mono text-text">{origin}/tv</span> — it shows a six-digit code. Type it here (or scan the TV&apos;s QR code
            with your phone), and the TV opens the wins board by itself. Nobody signs in on the TV, and it can show the board and nothing else.
          </div>
        </div>
        <form
          className="grid gap-3 sm:grid-cols-[10rem_1fr_14rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => pairTvScreen({ code, name, branchId: branchId || null }), "Paired — the TV opens its board in a few seconds.", () => {
              setCode("");
              setName("");
            });
          }}
        >
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted">Code on the TV</span>
            <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="123456" className="font-mono tracking-widest" disabled={pending} />
          </label>
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mumbai sales floor TV" maxLength={60} disabled={pending} />
          </label>
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted">Shows the wins of</span>
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} disabled={pending}>
              <option value="">The whole company</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" disabled={pending || code.length !== 6 || name.trim().length < 2}>
            {pending ? "Pairing…" : "Pair TV"}
          </Button>
        </form>
        {message && <p className={`text-sm ${message.tone === "ok" ? "text-success" : "text-danger"}`}>{message.text}</p>}
      </Card>

      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Screen</th>
              <th className="px-3 py-2.5 font-medium">Shows</th>
              <th className="px-3 py-2.5 font-medium">Last seen</th>
              <th className="px-3 py-2.5 font-medium">Paired by</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {screens.map((s) => {
              const seen = s.lastSeenAt ? new Date(s.lastSeenAt) : null;
              // eslint-disable-next-line react-hooks/purity -- "on" is how long ago it checked in, read as the page draws.
              const on = !!seen && Date.now() - seen.getTime() < ONLINE_MS;
              return editing === s.id ? (
                <EditRow key={s.id} screen={s} branches={branches} pending={pending} onCancel={() => setEditing(null)} onSave={(n, b) => run(() => updateTvScreen({ id: s.id, name: n, branchId: b || null }), "Saved.", () => setEditing(null))} />
              ) : (
                <tr key={s.id}>
                  <td className="px-4 py-2.5 font-medium text-text">{s.name}</td>
                  <td className="px-3 py-2.5 text-muted">Wins · {branchName(s.branch?.id)}</td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${on ? "bg-success" : "bg-line-strong"}`} />
                      <span className={on ? "text-text" : "text-muted"}>{on ? "On now" : seen ? clock.dateTimeShort(seen) : "Not yet"}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-muted">{s.pairedBy ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">
                    <button type="button" className="text-xs font-medium text-brand hover:underline" onClick={() => setEditing(s.id)} disabled={pending}>
                      Edit
                    </button>
                    <button
                      type="button"
                      aria-label={`Take ${s.name} off`}
                      className="ml-3 align-middle text-muted hover:text-danger"
                      disabled={pending}
                      onClick={() => window.confirm(`Take "${s.name}" off? The TV goes back to showing a code.`) && run(() => removeTvScreen(s.id), "Taken off — the TV shows a code within a minute.")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {screens.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-subtle">
                  No TVs yet. Open {origin}/tv on one to get its code.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function EditRow({
  screen,
  branches,
  pending,
  onCancel,
  onSave,
}: {
  screen: TvScreenRow;
  branches: { id: string; name: string }[];
  pending: boolean;
  onCancel: () => void;
  onSave: (name: string, branchId: string) => void;
}) {
  const [name, setName] = useState(screen.name);
  const [branchId, setBranchId] = useState(screen.branch?.id ?? "");
  return (
    <tr className="bg-surface-sunken/50">
      <td className="px-4 py-2">
        <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} disabled={pending} />
      </td>
      <td className="px-3 py-2" colSpan={3}>
        <Select aria-label="Shows the wins of" value={branchId} onChange={(e) => setBranchId(e.target.value)} disabled={pending}>
          <option value="">The whole company</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right">
        <Button type="button" size="sm" onClick={() => onSave(name, branchId)} disabled={pending || name.trim().length < 2}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </td>
    </tr>
  );
}
