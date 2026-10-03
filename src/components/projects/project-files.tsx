"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, FileText, Trash2, Upload } from "lucide-react";
import type { ProjectDocumentType } from "@prisma/client";
import { deleteProjectDocument, getProjectDocumentFile, uploadProjectDocument } from "@/actions/project-document";
import { projectDocumentTypeLabels } from "@/lib/projects/status";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { useClock } from "@/components/time/clock-provider";

type Doc = {
  id: string;
  type: ProjectDocumentType;
  name: string;
  note: string | null;
  mimeType: string;
  sizeBytes: number;
  createdAt: string | Date;
  uploadedBy: { name: string } | null;
};

/**
 * Agreements, NDAs, scope documents and signed acceptances.
 *
 * The listing carries file names and sizes, never the files. A project with twenty agreements
 * would otherwise ship eighty megabytes of base64 to draw twenty rows — the file is fetched by its
 * own action when somebody actually opens one.
 */
export function ProjectFiles({
  projectId,
  documents,
  canManage,
}: {
  projectId: string;
  documents: Doc[];
  canManage: boolean;
}) {
  const router = useRouter();
  const clock = useClock();
  const fileInput = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<ProjectDocumentType>("AGREEMENT");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function pick(file: File) {
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const fileDataUrl = String(reader.result);
      startTransition(async () => {
        const result = await uploadProjectDocument({
          projectId,
          type,
          name: name.trim() || file.name,
          fileDataUrl,
          mimeType: file.type,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setName("");
        if (fileInput.current) fileInput.current.value = "";
        router.refresh();
      });
    };
    reader.readAsDataURL(file);
  }

  async function open(id: string) {
    const result = await getProjectDocumentFile(id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Opened as a blob rather than navigating to the data URL: a multi-megabyte data: URL in the
    // address bar is refused outright by some browsers and truncated in history by the rest.
    const response = await fetch(result.data.fileDataUrl);
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = result.data.name;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Documents</CardHeader>
      <CardContent className="space-y-3">
        {documents.length === 0 ? (
          <p className="py-2 text-sm text-muted">Nothing filed against this project.</p>
        ) : (
          documents.map((d) => (
            <div key={d.id} className="flex items-start justify-between gap-2 border-b border-line pb-2.5 last:border-0 last:pb-0">
              <div className="flex min-w-0 items-start gap-2.5">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                <div className="min-w-0">
                  <div className="truncate text-sm text-text">{d.name}</div>
                  <div className="text-xs text-subtle">
                    {projectDocumentTypeLabels[d.type]} · {(d.sizeBytes / 1024).toFixed(0)} KB ·{" "}
                    {clock.date(d.createdAt)}
                    {d.uploadedBy && ` · ${d.uploadedBy.name}`}
                  </div>
                  {d.note && <p className="text-xs text-muted">{d.note}</p>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <IconButton icon={Download} label="Download" onClick={() => open(d.id)} />
                {canManage && (
                  <IconButton
                    icon={Trash2}
                    label="Delete"
                    tone="danger"
                    onClick={async () => {
                      if (!confirm(`Delete "${d.name}"?`)) return;
                      await deleteProjectDocument(d.id);
                      router.refresh();
                    }}
                  />
                )}
              </div>
            </div>
          ))
        )}

        {canManage && (
          <div className="space-y-2 border-t border-line pt-3">
            <Label htmlFor="doc-name">Add a document</Label>
            <div className="flex flex-wrap items-center gap-2">
              {/* "Add a document" above already names the name box, so this one names itself. */}
              <Select
                aria-label="Document type"
                value={type}
                onChange={(e) => setType(e.target.value as ProjectDocumentType)}
              >
                {(Object.keys(projectDocumentTypeLabels) as ProjectDocumentType[]).map((t) => (
                  <option key={t} value={t}>
                    {projectDocumentTypeLabels[t]}
                  </option>
                ))}
              </Select>
              <Input
                id="doc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name (defaults to the file name)"
                className="min-w-48 flex-1"
              />
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                accept=".pdf,.doc,.docx,.png,.jpg,.jpeg"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) pick(file);
                }}
              />
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => fileInput.current?.click()}>
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {pending ? "Uploading…" : "Choose file"}
              </Button>
            </div>
            <p className="text-xs text-subtle">PDF, Word or an image, up to 4 MB.</p>
          </div>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}
