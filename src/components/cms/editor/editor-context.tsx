"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { FieldIssue } from "@/components/cms/editor/doc-utils";
import type { MediaRow } from "@/lib/cms/types";

/**
 * What the block editor's fields need from the editor around them, without threading it through
 * every block form: whether anything may be changed, the site's own page addresses (suggested in
 * link fields), the library images the document uses, and the media picker.
 */
export type EditorEnv = {
  readOnly: boolean;
  /** "/", "/pricing", "/blog", "/about"… — offered as suggestions in link fields. */
  sitePaths: string[];
  /** Library rows by id, for the images the document uses (and any picked since it was opened). */
  media: Record<string, MediaRow>;
  /** Opens the media library in a dialog; resolves with the chosen image, or null. */
  pickImage: () => Promise<MediaRow | null>;
};

const EditorEnvContext = createContext<EditorEnv>({ readOnly: true, sitePaths: [], media: {}, pickImage: async () => null });

export function EditorEnvProvider({ value, children }: { value: EditorEnv; children: ReactNode }) {
  return <EditorEnvContext.Provider value={value}>{children}</EditorEnvContext.Provider>;
}

export function useEditorEnv(): EditorEnv {
  return useContext(EditorEnvContext);
}

// ─── Issues, scoped to where a field sits ────────────────────────────────────────────────────────

const IssuesContext = createContext<FieldIssue[]>([]);

/** The issues of one block (paths below its props), for every field inside it. */
export function IssueRoot({ issues, children }: { issues: FieldIssue[]; children: ReactNode }) {
  return <IssuesContext.Provider value={issues}>{children}</IssuesContext.Provider>;
}

function within(issues: FieldIssue[], prefix: string): FieldIssue[] {
  if (!prefix) return issues;
  const out: FieldIssue[] = [];
  for (const issue of issues) {
    if (issue.path === prefix) out.push({ path: "", message: issue.message });
    else if (issue.path.startsWith(`${prefix}.`)) out.push({ path: issue.path.slice(prefix.length + 1), message: issue.message });
    else if (issue.path.startsWith(`${prefix}[`)) out.push({ path: issue.path.slice(prefix.length), message: issue.message });
  }
  return out;
}

/** Everything inside is about `prefix` ("items[2]", "primary"): its fields name their paths from there. */
export function IssueScope({ prefix, children }: { prefix: string; children: ReactNode }) {
  const parent = useContext(IssuesContext);
  const scoped = useMemo(() => within(parent, prefix), [parent, prefix]);
  return <IssuesContext.Provider value={scoped}>{children}</IssuesContext.Provider>;
}

/** The messages for exactly this field. */
export function useIssuesAt(name: string): string[] {
  const issues = useContext(IssuesContext);
  return useMemo(() => issues.filter((i) => i.path === name).map((i) => i.message), [issues, name]);
}

/** How many issues there are at or below `name` — for a collapsed item's badge. */
export function useIssueCount(name: string): number {
  const issues = useContext(IssuesContext);
  return useMemo(() => within(issues, name).length, [issues, name]);
}
