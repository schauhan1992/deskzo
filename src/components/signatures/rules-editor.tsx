"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { setSignatureRule } from "@/actions/signature";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";

type Target = "DEPARTMENT" | "BRANCH" | "ROLE" | "PERSON";
type Choice = { id: string; name: string };
export type SignatureRuleRow = { target: Target; targetId: string; targetName: string; templateId: string; templateName: string };

const TARGETS: { key: Target; label: string; one: string }[] = [
  { key: "PERSON", label: "A person", one: "person" },
  { key: "DEPARTMENT", label: "A department", one: "department" },
  { key: "BRANCH", label: "A branch", one: "branch" },
  { key: "ROLE", label: "A role", one: "role" },
];

/**
 * Who gets a template other than the default. The most particular wins: a person's own, then their
 * department's, branch's and role's.
 */
export function SignatureRulesEditor({
  rules,
  templates,
  choices,
}: {
  rules: SignatureRuleRow[];
  templates: Choice[];
  choices: Record<Target, Choice[]>;
}) {
  const router = useRouter();
  const [target, setTarget] = useState<Target>("DEPARTMENT");
  const [targetId, setTargetId] = useState("");
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const apply = (input: { target: Target; targetId: string; templateId: string | null }) =>
    start(async () => {
      setError(null);
      const r = await setSignatureRule(input);
      if (!r.ok) return setError(r.error);
      setTargetId("");
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="space-y-1.5">
          <Label htmlFor="rule-target">Who</Label>
          <Select
            id="rule-target"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value as Target);
              setTargetId("");
            }}
          >
            {TARGETS.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rule-which">Which</Label>
          <Select id="rule-which" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">Choose…</option>
            {choices[target].map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rule-template">Gets</Label>
          <Select id="rule-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        <Button type="button" disabled={pending || !targetId || !templateId} onClick={() => apply({ target, targetId, templateId })}>
          Add
        </Button>
      </Card>
      {error && <p className="text-sm text-danger">{error}</p>}
      {rules.length === 0 ? (
        <p className="text-sm text-muted">Everybody gets the default template. Add a rule to give a department, a branch, a role or one person another.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
          {rules.map((r) => (
            <li key={`${r.target}-${r.targetId}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <span className="text-subtle">{TARGETS.find((t) => t.key === r.target)?.one}</span>
              <span className="font-medium text-text">{r.targetName}</span>
              <span className="text-muted">gets</span>
              <span className="font-medium text-text">{r.templateName}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto text-danger hover:bg-danger-bg hover:text-danger"
                aria-label={`Remove the rule for ${r.targetName}`}
                disabled={pending}
                onClick={() => apply({ target: r.target, targetId: r.targetId, templateId: null })}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
