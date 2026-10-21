import type { LetterType } from "@prisma/client";

/**
 * The folders of the file manager (owner, 21 Oct 2026): "salary slip, salary certificate, offer letter,
 * appointment letter and all letters, LOI" — and the documents on somebody's file. Pure, so the page and
 * check:file-manager read the same sorting.
 */
export const FILE_FOLDERS = [
  { key: "payslips", label: "Salary slips", hint: "Each month's payslip, once the month is locked." },
  { key: "salary-certificates", label: "Salary certificates", hint: "Salary certificates issued to them." },
  { key: "joining", label: "Offer & joining letters", hint: "Letter of intent, offer, appointment, internship and contract." },
  { key: "letters", label: "Other letters", hint: "Confirmation, increment, promotion, experience, relieving and the rest — HR's own templates too." },
  { key: "documents", label: "Documents", hint: "PAN, Aadhaar, certificates and everything else on their file." },
] as const;

export type FolderKey = (typeof FILE_FOLDERS)[number]["key"];

export const FOLDER_KEYS: readonly FolderKey[] = FILE_FOLDERS.map((f) => f.key);

const JOINING: readonly LetterType[] = ["LETTER_OF_INTENT", "OFFER", "APPOINTMENT", "INTERNSHIP", "CONTRACT_AGREEMENT"];

/** The folder a letter is filed in. */
export function folderOfLetter(type: LetterType): FolderKey {
  if (type === "SALARY_CERTIFICATE") return "salary-certificates";
  if (JOINING.includes(type)) return "joining";
  return "letters";
}

export function isFolderKey(value: unknown): value is FolderKey {
  return typeof value === "string" && (FOLDER_KEYS as readonly string[]).includes(value);
}
