"use client";

import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_WORDING, type Wording } from "@/lib/terms/dictionary";

/**
 * The workspace's own words for the client components (src/lib/terms) — the sidebar, the create menu,
 * the tables. Read once by the dashboard layout (`getWording`) and handed down, the way table
 * preferences are; a component outside the provider gets the app's words.
 */
const WordingContext = createContext<Wording>(DEFAULT_WORDING);

export function WordingProvider({ initial, children }: { initial: Wording; children: ReactNode }) {
  return <WordingContext.Provider value={initial}>{children}</WordingContext.Provider>;
}

export function useWording(): Wording {
  return useContext(WordingContext);
}
