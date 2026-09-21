"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, UserMinus } from "lucide-react";
import type { ProjectStakeholderRole } from "@prisma/client";
import { addStakeholder, removeStakeholder } from "@/actions/project";
import { CUSTOMER_SIDE_ROLES, stakeholderRoleLabels } from "@/lib/projects/status";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";

type Stakeholder = {
  id: string;
  role: ProjectStakeholderRole;
  note: string | null;
  user: { id: string; name: string; email: string; phone: string | null } | null;
  contact: { id: string; name: string; email: string | null; phone: string | null; designation: string | null } | null;
};

/**
 * Who is on the project.
 *
 * Not a decorative list. Adding a colleague here is what lets them open the project at all, which
 * is said on the screen rather than left to be discovered — a permission granted through a form
 * that doesn't mention permissions is one nobody audits.
 */
export function ProjectPeople({
  projectId,
  stakeholders,
  users,
  contacts,
  canManage,
}: {
  projectId: string;
  stakeholders: Stakeholder[];
  users: { id: string; name: string }[];
  contacts: { id: string; name: string; designation: string | null }[];
  canManage: boolean;
}) {
  const router = useRouter();
  const ours = stakeholders.filter((s) => s.user);
  const theirs = stakeholders.filter((s) => s.contact);

  const remove = async (id: string) => {
    const result = await removeStakeholder(id);
    if (!result.ok) alert(result.error);
    router.refresh();
  };

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Our team</CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-subtle">
            Projects are visible to the people on them. Adding somebody here is what gives them access.
          </p>
          {ours.length === 0 ? (
            <p className="py-2 text-sm text-muted">Nobody yet.</p>
          ) : (
            ours.map((s) => (
              <Row
                key={s.id}
                title={s.user!.name}
                subtitle={stakeholderRoleLabels[s.role]}
                detail={[s.user!.email, s.user!.phone].filter(Boolean).join(" · ")}
                note={s.note}
                onRemove={canManage ? () => remove(s.id) : undefined}
              />
            ))
          )}
          {canManage && (
            <AddRow
              projectId={projectId}
              label="Add a colleague"
              field="userId"
              people={users}
              roles={(Object.keys(stakeholderRoleLabels) as ProjectStakeholderRole[]).filter(
                (r) => !CUSTOMER_SIDE_ROLES.includes(r),
              )}
              defaultRole="TEAM_MEMBER"
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">At the customer</CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-subtle">
            Who to talk to, and who signs off. These are contacts, not logins — nobody here gets access to anything.
          </p>
          {theirs.length === 0 ? (
            <p className="py-2 text-sm text-muted">Nobody yet.</p>
          ) : (
            theirs.map((s) => (
              <Row
                key={s.id}
                title={s.contact!.name}
                subtitle={`${stakeholderRoleLabels[s.role]}${s.contact!.designation ? ` · ${s.contact!.designation}` : ""}`}
                detail={[s.contact!.email, s.contact!.phone].filter(Boolean).join(" · ")}
                note={s.note}
                onRemove={canManage ? () => remove(s.id) : undefined}
              />
            ))
          )}
          {canManage && (
            <AddRow
              projectId={projectId}
              label="Add a customer contact"
              field="contactId"
              people={contacts}
              roles={CUSTOMER_SIDE_ROLES}
              defaultRole="CUSTOMER_TECHNICAL"
              empty="This company has no contacts on file yet."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  title,
  subtitle,
  detail,
  note,
  onRemove,
}: {
  title: string;
  subtitle: string;
  detail: string;
  note: string | null;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2 border-b border-line pb-2.5 last:border-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm text-text">{title}</div>
        <div className="text-xs text-muted">{subtitle}</div>
        {detail && <div className="text-xs text-subtle">{detail}</div>}
        {note && <div className="mt-0.5 text-xs text-subtle">{note}</div>}
      </div>
      {onRemove && <IconButton icon={UserMinus} label="Remove" tone="danger" onClick={onRemove} />}
    </div>
  );
}

function AddRow({
  projectId,
  label,
  field,
  people,
  roles,
  defaultRole,
  empty,
}: {
  projectId: string;
  label: string;
  field: "userId" | "contactId";
  people: { id: string; name: string; designation?: string | null }[];
  roles: ProjectStakeholderRole[];
  defaultRole: ProjectStakeholderRole;
  empty?: string;
}) {
  const router = useRouter();
  const [personId, setPersonId] = useState("");
  const [role, setRole] = useState<ProjectStakeholderRole>(defaultRole);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (people.length === 0 && empty) return <p className="border-t border-line pt-3 text-xs text-subtle">{empty}</p>;

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <Label htmlFor={`add-${field}`}>{label}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select id={`add-${field}`} value={personId} onChange={(e) => setPersonId(e.target.value)} className="min-w-44">
          <option value="">Choose…</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        {/*
          The caption above belongs to the person picker beside it, and both cards on this page
          render an AddRow — so the role picker says which side of the project it is for.
        */}
        <Select
          aria-label={field === "userId" ? "Role on the project" : "Role at the customer"}
          value={role}
          onChange={(e) => setRole(e.target.value as ProjectStakeholderRole)}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {stakeholderRoleLabels[r]}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending || !personId}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const result = await addStakeholder({ projectId, [field]: personId, role });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setPersonId("");
              router.refresh();
            })
          }
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
