"use client";

import { useEffect } from "react";
import { rememberWorkspace } from "./prefs";

/**
 * Records a visit to a workspace page for the palette's "Recent" list. Written after the page has
 * committed, never during render, and it draws nothing.
 */
export function RememberWorkspace({ slug, name }: { slug: string; name: string }) {
  useEffect(() => {
    rememberWorkspace(slug, name);
  }, [slug, name]);
  return null;
}
