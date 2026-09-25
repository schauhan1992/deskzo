"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import type { IpRuleAction } from "@prisma/client";
import { deleteIpRule, saveIpRule } from "@/actions/access-control";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/bulk-select";
import { Input, Label, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

type Rule = {
  id: string;
  cidr: string;
  action: IpRuleAction;
  label: string;
  roleKeys: string[];
  expiresAt: string | Date | null;
  /** Worked out on the server, so rendering does not read the clock. */
  expired: boolean;
  /** The last day it applies, as entered. */
  untilText: string | null;
  createdBy: { name: string } | null;
};

/**
 * Allowed and blocked addresses. A block beats an allow wherever both match, and a rule with no roles
 * applies to everybody — both said on the screen, because both decide who gets in.
 */
export function IpRules({
  rules,
  roles,
  currentIp,
}: {
  rules: Rule[];
  roles: { key: string; name: string }[];
  /** Offered as a starting point: "the network I'm on now" is usually the office. */
  currentIp: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [form, setForm] = useState({ cidr: "", action: "ALLOW" as IpRuleAction, label: "", roleKeys: [] as string[], expiresOn: "" });
  const roleName = (key: string) => roles.find((r) => r.key === key)?.name ?? key;

  const run = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, success: string) => {
    setNotice(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) setNotice({ tone: "error", text: result.error });
      else {
        setNotice({ tone: "success", text: success });
        router.refresh();
      }
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-text">Add a rule</h2>
          <p className="text-xs text-subtle">
            An address (203.0.113.7) or a range (203.0.113.0/24). IPv6 works too.
            {currentIp && (
              <>
                {" "}You&apos;re on <span className="font-mono">{currentIp}</span>
                <button type="button" className="ml-1 text-brand underline" onClick={() => setForm((f) => ({ ...f, cidr: currentIp }))}>
                  use it
                </button>
                .
              </>
            )}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_9rem_1fr_10rem]">
            <div className="space-y-1">
              <Label htmlFor="rule-cidr" className="text-xs">
                Address or range
              </Label>
              <Input id="rule-cidr" className="font-mono" value={form.cidr} onChange={(e) => setForm((f) => ({ ...f, cidr: e.target.value }))} placeholder="203.0.113.0/24" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rule-action" className="text-xs">
                Do what
              </Label>
              <Select id="rule-action" value={form.action} onChange={(e) => setForm((f) => ({ ...f, action: e.target.value as IpRuleAction }))}>
                <option value="ALLOW">Allow</option>
                <option value="BLOCK">Block</option>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rule-label" className="text-xs">
                Name
              </Label>
              <Input id="rule-label" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="Pune office" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rule-expires" className="text-xs">
                Until (optional)
              </Label>
              <Input id="rule-expires" type="date" value={form.expiresOn} onChange={(e) => setForm((f) => ({ ...f, expiresOn: e.target.value }))} />
            </div>
          </div>
          <fieldset>
            <legend className="text-xs font-medium text-muted">For which roles — none ticked means everybody</legend>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {roles.map((r) => (
                <label key={r.key} className="flex cursor-pointer items-center gap-1.5 text-sm text-text">
                  <Checkbox
                    checked={form.roleKeys.includes(r.key)}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, roleKeys: e.target.checked ? [...f.roleKeys, r.key] : f.roleKeys.filter((k) => k !== r.key) }))
                    }
                  />
                  {r.name}
                </label>
              ))}
            </div>
          </fieldset>
          {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={pending || !form.cidr.trim()}
              onClick={() =>
                run(async () => {
                  const result = await saveIpRule(form);
                  if (result.ok) setForm({ cidr: "", action: "ALLOW", label: "", roleKeys: [], expiresOn: "" });
                  return result;
                }, "Rule added.")
              }
            >
              Add rule
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        {rules.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-subtle">
            No rules yet. Every address is unknown, and each role&apos;s &ldquo;unknown network&rdquo; setting decides what happens.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {rules.map((rule) => {
              const expired = rule.expired;
              return (
                <li key={rule.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={rule.action === "ALLOW" ? "green" : "red"}>{rule.action === "ALLOW" ? "Allow" : "Block"}</Badge>
                      <span className="font-mono text-sm text-text">{rule.cidr}</span>
                      <span className="text-sm text-text">{rule.label}</span>
                      {expired && <Badge>Expired</Badge>}
                    </div>
                    <div className="text-[11px] text-subtle">
                      {rule.roleKeys.length ? rule.roleKeys.map(roleName).join(", ") : "Everybody"}
                      {rule.untilText && !expired && ` · until ${rule.untilText}`}
                      {rule.createdBy && ` · added by ${rule.createdBy.name}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove the rule for ${rule.cidr}`}
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(`Remove the rule ${rule.action === "ALLOW" ? "allowing" : "blocking"} ${rule.cidr}?`)) run(() => deleteIpRule(rule.id), "Rule removed.");
                    }}
                    className="rounded p-1.5 text-muted hover:bg-surface-sunken hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
