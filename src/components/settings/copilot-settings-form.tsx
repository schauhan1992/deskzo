"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { AiProvider } from "@prisma/client";
import { listCopilotModels, saveCopilotSettings } from "@/actions/copilot";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

export type CopilotSettingsView = {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  dailyTokenLimit: number;
  hasKey: Record<AiProvider, boolean>;
  providers: { key: AiProvider; label: string; defaultModel: string; keyHint: string }[];
  usage: { name: string; today: number; month: number; requests: number }[];
};

const LIMITS = [100_000, 300_000, 1_000_000, 3_000_000];

export function CopilotSettingsForm({ settings }: { settings: CopilotSettingsView }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [provider, setProvider] = useState<AiProvider>(settings.provider);
  const [model, setModel] = useState(settings.model);
  const [limit, setLimit] = useState(String(settings.dailyTokenLimit));
  const [keys, setKeys] = useState<Partial<Record<AiProvider, string>>>({});
  const [remove, setRemove] = useState<AiProvider[]>([]);
  const [models, setModels] = useState<Partial<Record<AiProvider, string[]>>>({});
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const current = settings.providers.find((p) => p.key === provider)!;
  const keySaved = settings.hasKey[provider] && !remove.includes(provider);

  function pickProvider(next: AiProvider) {
    setProvider(next);
    // A model name belongs to one provider; carry it across only if it came from there.
    if (next !== settings.provider) setModel(settings.providers.find((p) => p.key === next)?.defaultModel ?? "");
    else setModel(settings.model);
  }

  function loadModels() {
    setNotice(null);
    startTransition(async () => {
      const r = await listCopilotModels(provider, keys[provider]);
      if (!r.ok) setNotice({ tone: "error", text: r.error });
      else {
        setModels((m) => ({ ...m, [provider]: r.data }));
        setNotice({ tone: "success", text: `${r.data.length} models available with this key — pick one below.` });
      }
    });
  }

  function save() {
    setNotice(null);
    startTransition(async () => {
      const r = await saveCopilotSettings({ enabled, provider, model, dailyTokenLimit: Number(limit), keys, removeKeys: remove });
      if (!r.ok) {
        setNotice({ tone: "error", text: r.error });
        return;
      }
      setKeys({});
      setRemove([]);
      setNotice({ tone: "success", text: enabled ? "Saved — the copilot is on for everybody with access." : "Saved. The copilot is off." });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 pt-4 text-sm">
          <label className="flex items-center gap-2 text-text">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="font-medium">The copilot is on</span>
            <span className="text-muted">— the Copilot button shows in the header for everyone with the “Use the AI copilot” permission</span>
          </label>

          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Provider</p>
            <div className="flex flex-wrap gap-2">
              {settings.providers.map((p) => (
                <label
                  key={p.key}
                  className={`flex cursor-pointer items-center gap-2 rounded-base border px-3 py-2 ${provider === p.key ? "border-brand bg-brand-subtle/40" : "border-line"}`}
                >
                  <input type="radio" name="copilot-provider" checked={provider === p.key} onChange={() => pickProvider(p.key)} />
                  <span className="text-text">{p.label}</span>
                  <span className={`text-[11px] ${settings.hasKey[p.key] ? "text-success" : "text-subtle"}`}>{settings.hasKey[p.key] ? "key saved" : "no key"}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="copilot-key">{current.label} API key</Label>
              <Input
                id="copilot-key"
                type="password"
                autoComplete="off"
                value={keys[provider] ?? ""}
                onChange={(e) => setKeys((k) => ({ ...k, [provider]: e.target.value }))}
                placeholder={keySaved ? "Saved — type a new one to replace it" : current.keyHint}
              />
              <p className="text-[11px] text-subtle">
                Stored encrypted and never shown again.{" "}
                {settings.hasKey[provider] && (
                  <button
                    type="button"
                    className="underline underline-offset-2"
                    onClick={() => setRemove((r) => (r.includes(provider) ? r.filter((x) => x !== provider) : [...r, provider]))}
                  >
                    {remove.includes(provider) ? "Keep the saved key" : "Remove the saved key"}
                  </button>
                )}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="copilot-model">Model</Label>
              <div className="flex gap-2">
                <Input id="copilot-model" list="copilot-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Load the list, or type a model name" />
                <Button type="button" variant="secondary" size="sm" className="h-9 shrink-0" disabled={pending || (!keySaved && !keys[provider]?.trim())} onClick={loadModels}>
                  Load models
                </Button>
              </div>
              <datalist id="copilot-models">
                {(models[provider] ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <p className="text-[11px] text-subtle">
                {provider === "ANTHROPIC" ? "claude-opus-5 is the most reliable at multi-step questions; claude-sonnet-5 is faster and cheaper." : "“Load models” asks the provider which models this key can use."}
              </p>
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="copilot-limit">Daily allowance per person (tokens)</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input id="copilot-limit" type="number" min={1000} step={1000} value={limit} onChange={(e) => setLimit(e.target.value)} className="w-40" />
              {LIMITS.map((l) => (
                <button key={l} type="button" onClick={() => setLimit(String(l))} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-surface-sunken">
                  {l.toLocaleString("en-IN")}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-subtle">
              A question that looks things up and draws a report typically uses 15,000–40,000 tokens. Resets at midnight India time. Cached tokens count a tenth, as they&apos;re billed.
            </p>
          </div>

          <div className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-[12px] text-muted">
            To answer, the copilot sends the question and the records it looks up to the chosen provider. It only ever looks up what the person asking can already see,
            and it never exports, sends or changes anything — tasks and notes are drafted for the person to confirm. Check the provider&apos;s data-use terms before
            switching it on.
          </div>

          {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
          <Button disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </CardContent>
      </Card>

      <Card className="overflow-x-auto p-0">
        <CardHeader className="text-sm font-semibold text-text">Usage</CardHeader>
        {settings.usage.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted">Nobody has used the copilot in the last 30 days.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-y border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">Person</th>
                <th className="px-4 py-2 text-right">Today</th>
                <th className="px-4 py-2 text-right">Last 30 days</th>
                <th className="px-4 py-2 text-right">Requests</th>
              </tr>
            </thead>
            <tbody>
              {settings.usage.map((u) => (
                <tr key={u.name} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 text-text">{u.name}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{u.today.toLocaleString("en-IN")}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{u.month.toLocaleString("en-IN")}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{u.requests.toLocaleString("en-IN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
