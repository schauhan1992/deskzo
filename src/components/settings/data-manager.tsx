"use client";

import { useState, useTransition } from "react";
import { Download, Upload, Lock, FileSpreadsheet, Info } from "lucide-react";
import { exportArea, type ExportPayload } from "@/actions/data-export";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ImportDialog } from "@/components/settings/import-dialog";

/**
 * The import and export screen.
 *
 * Areas somebody cannot touch are shown greyed rather than hidden, and areas that cannot be
 * imported say why. An option that is simply absent reads as a missing feature and generates a
 * support question; an option that is present and explains itself answers the question first.
 */

export type AreaRow = {
  key: string;
  label: string;
  description: string;
  canExport: boolean;
  canImport: boolean;
  importable: boolean;
  importRefusedBecause: string | null;
  importBuilt: boolean;
};

/** A server action cannot stream a file, so the payload comes back encoded and is rebuilt here. */
function download(payload: ExportPayload) {
  const bytes = Uint8Array.from(atob(payload.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: payload.contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = payload.filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function DataManager({ areas }: { areas: AreaRow[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ area: string; text: string; bad?: boolean } | null>(null);

  const run = (area: AreaRow, format: "csv" | "xlsx") => {
    setBusy(`${area.key}:${format}`);
    setNotice(null);
    startTransition(async () => {
      const result = await exportArea(area.key, format);
      setBusy(null);
      if (!result.ok) {
        setNotice({ area: area.key, text: result.error, bad: true });
        return;
      }
      if (result.data.rows === 0) {
        setNotice({ area: area.key, text: "Nothing to export — no rows you can see." });
        return;
      }
      download(result.data);
      setNotice({ area: area.key, text: `${result.data.rows.toLocaleString("en-IN")} rows downloaded.` });
    });
  };

  const anyExport = areas.some((a) => a.canExport);

  return (
    <div className="space-y-4">
      {!anyExport && (
        <Card className="border-warning/40 bg-warning-bg">
          <CardContent className="flex items-start gap-2 py-3 text-sm text-warning">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              You don&rsquo;t hold any export permission, so everything below is read-only. A super admin grants these
              under Users &amp; Access → Data import &amp; export.
            </span>
          </CardContent>
        </Card>
      )}

      <Card className="bg-surface-sunken">
        <CardContent className="flex items-start gap-2 py-3 text-sm text-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            An export contains only the accounts you can already see. It never widens visibility — the permission
            decides whether what you can see may leave the building, which is a different question. Every export is
            recorded in the activity log.
          </span>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {areas.map((area) => (
          <Card key={area.key} className={area.canExport ? "" : "opacity-60"}>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
              <span className="flex items-center gap-2">
                {area.label}
                {!area.importable && <Badge tone="default">Export only</Badge>}
              </span>
              <span className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!area.canExport || busy !== null}
                  onClick={() => run(area, "xlsx")}
                  title={area.canExport ? "Download as an Excel workbook" : "You don't have permission to export this"}
                >
                  <FileSpreadsheet className="h-3.5 w-3.5" />
                  {busy === `${area.key}:xlsx` ? "Preparing…" : "Excel"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!area.canExport || busy !== null}
                  onClick={() => run(area, "csv")}
                  title={area.canExport ? "Download as CSV" : "You don't have permission to export this"}
                >
                  <Download className="h-3.5 w-3.5" />
                  {busy === `${area.key}:csv` ? "…" : "CSV"}
                </Button>
                {area.importable && area.canImport && area.importBuilt && (
                  <ImportDialog areaKey={area.key} areaLabel={area.label} />
                )}
                {area.importable && area.canImport && !area.importBuilt && (
                  <Button size="sm" variant="ghost" disabled title="The importer for this area is not written yet">
                    <Upload className="h-3.5 w-3.5" />
                    Import
                  </Button>
                )}
              </span>
            </CardHeader>
            <CardContent className="space-y-1.5 py-2.5">
              <p className="text-sm text-muted">{area.description}</p>

              {!area.importable && area.importRefusedBecause && (
                <p className="text-xs text-subtle">
                  <strong className="text-muted">Why no import:</strong> {area.importRefusedBecause}
                </p>
              )}

              {!area.canExport && (
                <p className="flex items-center gap-1.5 text-xs text-subtle">
                  <Lock className="h-3 w-3" />
                  You don&rsquo;t hold the permission for this.
                </p>
              )}

              {notice?.area === area.key && (
                <p className={`text-sm ${notice.bad ? "text-danger" : "text-success"}`}>{notice.text}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
