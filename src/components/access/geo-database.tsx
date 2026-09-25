"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * Putting next month's location database in place. The file is sent as the request body, not a form,
 * so a 60 MB upload streams to disk instead of sitting in memory — see the route for why.
 */
export function GeoDatabaseUpload() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const send = async (file: File) => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/access/geo-database", {
        method: "POST",
        headers: { "x-file-name": encodeURIComponent(file.name), "content-type": "application/octet-stream" },
        body: file,
      });
      const result = (await response.json().catch(() => ({}))) as { ok?: boolean; type?: string; error?: string };
      if (!response.ok || !result.ok) setNotice({ tone: "error", text: result.error ?? "The upload failed." });
      else {
        setNotice({ tone: "success", text: `In use now: ${result.type}.` });
        router.refresh();
      }
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      <input
        ref={input}
        type="file"
        accept=".mmdb,.gz"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void send(file);
        }}
      />
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => input.current?.click()}>
        <Upload className="h-3.5 w-3.5" />
        {busy ? "Uploading…" : "Upload a newer file"}
      </Button>
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
    </div>
  );
}
