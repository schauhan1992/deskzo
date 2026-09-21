import type { CallOutcome, CallDirection } from "@prisma/client";

export const callOutcomeLabels: Record<CallOutcome, string> = {
  CONNECTED: "Connected",
  NO_ANSWER: "No answer",
  BUSY: "Busy",
  SWITCHED_OFF: "Switched off",
  WRONG_NUMBER: "Wrong number",
  LEFT_VOICEMAIL: "Left voicemail",
  CALLBACK_REQUESTED: "Callback requested",
  NOT_INTERESTED: "Not interested",
};

export const callOutcomeTones: Record<CallOutcome, "default" | "green" | "blue" | "red" | "amber"> = {
  CONNECTED: "green",
  NO_ANSWER: "default",
  BUSY: "default",
  SWITCHED_OFF: "default",
  WRONG_NUMBER: "red",
  LEFT_VOICEMAIL: "blue",
  CALLBACK_REQUESTED: "amber",
  NOT_INTERESTED: "red",
};

export const callDirectionLabels: Record<CallDirection, string> = {
  OUTBOUND: "Outbound",
  INBOUND: "Inbound",
};

export const callOutcomeValues = Object.keys(callOutcomeLabels) as CallOutcome[];

/**
 * Outcomes where someone actually spoke to a person.
 *
 * This is the number a calling team is measured on — dialling 80 numbers and reaching four people
 * is a very different day from reaching forty, and a raw call count hides that completely.
 */
export const CONNECTED_OUTCOMES: CallOutcome[] = ["CONNECTED", "CALLBACK_REQUESTED", "NOT_INTERESTED"];

export function isConnected(outcome: CallOutcome) {
  return CONNECTED_OUTCOMES.includes(outcome);
}

/** Outcomes worth trying again — the rest are answered questions, not unfinished ones. */
export const RETRYABLE_OUTCOMES: CallOutcome[] = ["NO_ANSWER", "BUSY", "SWITCHED_OFF", "LEFT_VOICEMAIL"];

/** mm:ss for anything under an hour, which is every sales call worth logging. */
export function formatDuration(seconds: number) {
  if (!seconds) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

/**
 * Strips a number down to what a phone can dial.
 *
 * Numbers are typed in by hand and arrive as "+91 98765 43210", "098765-43210", "(022) 4000 1234".
 * A `tel:` link has to be clean or the dialler opens on nothing.
 */
export function dialable(phone: string) {
  const cleaned = phone.replace(/[^\d+]/g, "");
  // A leading + is meaningful; a + anywhere else is someone's typo.
  return cleaned.startsWith("+") ? `+${cleaned.slice(1).replace(/\+/g, "")}` : cleaned.replace(/\+/g, "");
}

export function hasDialableNumber(phone: string | null | undefined): phone is string {
  return !!phone && dialable(phone).replace(/\D/g, "").length >= 6;
}
