import { z } from "zod";

/**
 * IFSC — the RBI's code for a bank branch: four letters for the bank, a zero, then six letters or digits
 * for the branch (HDFC0001234).
 *
 * The shape was always checked the same way; what went wrong was what reached the check (owner, 21 Oct
 * 2026: "IFSC code mein issue hai"). A code copied from a banking app, a cheque scan or a WhatsApp
 * message carries more than the eleven characters: a space or a dash in the middle ("HDFC 0001234"),
 * a non-breaking space, and the invisible zero-width and direction marks those apps put around text.
 * It looked right on screen and was refused — and a field holding only a space refused the whole form.
 * Everything a person types or pastes comes through `normaliseIfsc` first.
 */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

// Every kind of space, the zero-width and direction marks, and the dashes and dots some write it with.
const NOISE = /[\s​-‏‪-‮⁠-⁤⁦-⁩﻿‐-―.\-]/g;

/** The code as typed or pasted, cleaned: no spaces, marks or dashes, in capitals, an O fifth read as the zero it must be. */
export function normaliseIfsc(raw: string): string {
  const code = raw.replace(NOISE, "").toUpperCase();
  return code.length === 11 && code[4] === "O" ? `${code.slice(0, 4)}0${code.slice(5)}` : code;
}

export const isIfsc = (code: string) => IFSC_PATTERN.test(code);

/** An optional IFSC for a form: cleaned, then empty or a well-formed code — with this message when it isn't. */
export function ifscSchema(message: string) {
  return z
    .string()
    .transform(normaliseIfsc)
    .refine((code) => code === "" || isIfsc(code), { message })
    .optional();
}
