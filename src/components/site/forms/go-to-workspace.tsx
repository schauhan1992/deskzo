"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/** A workspace name, as src/lib/tenancy/host.ts SLUG_PATTERN has it. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/**
 * "Which workspace?" — the name goes in and the browser goes to that workspace's own sign-in page.
 * Nothing is looked up, so nothing is learned about which names exist.
 */
export function GoToWorkspaceForm({ suffix }: { suffix: string }) {
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const slug = name.trim().toLowerCase();
  const valid = SLUG.test(slug);
  const showProblem = tried && !valid;
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!valid) return;
        // Another address — the workspace's own — so the browser goes there itself.
        window.location.assign(new URL("/login", `${window.location.protocol}//${slug}${suffix}`));
      }}
      className="space-y-3"
    >
      <Label htmlFor="site-workspace">Workspace name</Label>
      <div className="flex min-w-0 items-center rounded-base border border-line-strong bg-surface shadow-sm focus-within:border-brand">
        <Input
          id="site-workspace"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="yourcompany"
          className="min-w-0 border-0 shadow-none"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={showProblem || undefined}
          aria-describedby={showProblem ? "site-workspace-suffix site-workspace-problem" : "site-workspace-suffix"}
        />
        <span id="site-workspace-suffix" className="max-w-[55%] shrink-0 truncate pr-3 text-sm text-muted">
          {suffix}
        </span>
      </div>
      {showProblem && (
        <p id="site-workspace-problem" className="text-xs text-danger">
          A workspace name is 3 to 40 letters, digits or hyphens.
        </p>
      )}
      <Button type="submit" className="h-10 w-full">
        Continue to sign in
        <ArrowRight aria-hidden="true" className="h-4 w-4" />
      </Button>
    </form>
  );
}
