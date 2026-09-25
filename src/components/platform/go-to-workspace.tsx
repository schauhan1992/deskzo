"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/** "Which workspace?" — the name goes in, the browser goes to its address. Nothing is looked up. */
export function GoToWorkspace({ suffix }: { suffix: string }) {
  const [name, setName] = useState("");
  const slug = name.trim().toLowerCase();
  const valid = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        // Another address — the workspace's own — so the browser goes there itself.
        window.location.assign(new URL("/login", `${window.location.protocol}//${slug}${suffix}`));
      }}
      className="space-y-2"
    >
      <Label htmlFor="workspace">Go to your workspace</Label>
      <div className="flex items-center gap-2">
        <div className="flex flex-1 items-center rounded-base border border-line bg-surface pr-2 text-sm">
          <Input id="workspace" value={name} onChange={(e) => setName(e.target.value)} placeholder="yourcompany" className="border-0 shadow-none" autoComplete="off" />
          <span className="whitespace-nowrap text-muted">{suffix}</span>
        </div>
        <Button type="submit" disabled={!valid}>
          Go
        </Button>
      </div>
    </form>
  );
}
