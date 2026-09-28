"use client";

import { useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronRight, Info, Plus, Trash2, Upload } from "lucide-react";
import {
  deleteBranch,
  deleteGstRegistration,
  saveBranch,
  saveGstRegistration,
  setBranchActive,
  setBranchImage,
  setGstRegistrationActive,
  setHeadOffice,
  type BranchRow,
  type BranchSettings,
  type RegistrationRow,
} from "@/actions/branch";
import type { ActionResult } from "@/actions/company";
import { branchLabel } from "@/lib/branches/format";
import {
  GST_STATE_ABBREVIATIONS,
  GST_STATE_CODES,
  GSTIN_PATTERN,
  OTHER_COUNTRY_CODE,
  hasValidGstinChecksum,
  panOfGstin,
  stateCodeFromName,
} from "@/lib/gst-engine";
import { isIndia } from "@/lib/geo/countries";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { AddressFields } from "@/components/ui/address-fields";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";

/** Short names for a status line; the provider select on e-Invoicing has the long ones. */
const PROVIDER_LABELS: Record<string, string> = { mock: "Mock", nic_sandbox: "NIC sandbox", nic_production: "NIC production" };

/** The same types and cap `setBranchImage` checks — said here first so a wrong file is refused before it is read. */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_IMAGE_BYTES = 256 * 1024;

const stateName = (code: string | null | undefined) => (code ? (GST_STATE_CODES[code] ?? code) : "");

/** "Head office" is already the head office's name in most companies; a badge saying it again is noise. */
const namedHeadOffice = (branch: { name: string }) => branch.name.trim().toLowerCase() === "head office";

type Notice = { tone: NoticeTone; message: string } | null;

type Confirm =
  | { kind: "head-office"; branch: BranchRow }
  | { kind: "delete-branch"; branch: BranchRow }
  | { kind: "delete-registration"; registration: RegistrationRow };

/**
 * Branches and the GST registrations they bill under, on one screen.
 *
 * Every rule here is the server's (spec §3.4, `src/actions/branch.ts`); the screen explains them before
 * Save rather than enforcing them — the GSTIN's check digit and PAN as it is typed, a branch whose
 * address is in another state than its registration — and shows the server's refusal word for word
 * when it disagrees. A company with one office sees its head office and its registration, and nothing
 * else asks for attention.
 */
export function BranchesManager({ data, companyWideGstSeries }: { data: BranchSettings; companyWideGstSeries: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const [registrationDialog, setRegistrationDialog] = useState<{ id: string | null } | null>(null);
  const [branchDialog, setBranchDialog] = useState<{ id: string | null } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const activeRegistrations = data.registrations.filter((r) => r.active);
  const registrationById = new Map(data.registrations.map((r) => [r.id, r]));
  const headOffice = data.branches.find((b) => b.isHeadOffice) ?? null;
  // Stored before check digits were verified — the rules apply to a GSTIN as it is entered, not retroactively.
  const suspect = data.registrations.filter((r) => !r.checksumOk || !r.panOk);

  /** A row action: say how it went, and re-read the page either way — the answer may be "somebody else moved it". */
  function run(action: () => Promise<ActionResult<unknown>>, done: string) {
    setNotice(null);
    startTransition(async () => {
      const result = await action();
      setNotice(result.ok ? { tone: "success", message: done } : { tone: "error", message: result.error });
      router.refresh();
    });
  }

  function openConfirm(next: Confirm) {
    setConfirmError(null);
    setConfirm(next);
  }

  function confirmAction() {
    if (!confirm) return;
    setConfirmError(null);
    startTransition(async () => {
      let result: ActionResult<unknown>;
      let done: string;
      if (confirm.kind === "head-office") {
        result = await setHeadOffice(confirm.branch.id);
        done = `${confirm.branch.name} is now the head office.`;
      } else if (confirm.kind === "delete-branch") {
        result = await deleteBranch(confirm.branch.id);
        done = `${branchLabel(confirm.branch)} deleted.`;
      } else {
        result = await deleteGstRegistration(confirm.registration.id);
        done = `GSTIN ${confirm.registration.gstin} deleted.`;
      }
      if (!result.ok) {
        setConfirmError(result.error);
        return;
      }
      setConfirm(null);
      setNotice({ tone: "success", message: done });
      router.refresh();
    });
  }

  const editingRegistration = registrationDialog?.id ? (registrationById.get(registrationDialog.id) ?? null) : null;
  const editingBranch = branchDialog?.id ? (data.branches.find((b) => b.id === branchDialog.id) ?? null) : null;

  return (
    <div className="space-y-6">
      {suspect.map((r) => (
        <Card key={r.id} className="flex items-start gap-2 border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Check GSTIN <span className="font-mono">{r.gstin}</span> — its check digit or PAN doesn&apos;t match.{" "}
            {!r.checksumOk
              ? "Its last character isn't the check digit the first fourteen give, so one of them is probably mistyped."
              : `Characters 3–12 should be the company's PAN${data.org.pan ? `, ${data.org.pan}` : ""}.`}{" "}
            Compare it with the registration certificate.
          </span>
        </Card>
      ))}

      {companyWideGstSeries.length > 0 && (
        // Owner decision Q6: recommend, never switch. Whether one series may span GSTINs is CA question C1.
        <Card className="flex items-start gap-2 border-info/30 bg-info-bg px-4 py-3 text-sm text-info">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            You have {activeRegistrations.length} active GST registrations, and {joinList(companyWideGstSeries)} still run in one
            series for the whole company. A GSTIN normally numbers its own documents in one consecutive series, so a series per
            GST registration is recommended. Nothing changes until you choose it under{" "}
            <Link href="/settings/numbering" className="font-medium underline underline-offset-2">
              Document numbering
            </Link>
            .
          </span>
        </Card>
      )}

      <ActionNoticeRegion notice={notice} />

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-medium text-text">GST registrations</span>
          <Button type="button" size="sm" variant="secondary" onClick={() => setRegistrationDialog({ id: null })}>
            <Plus className="h-3.5 w-3.5" /> Add registration
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted">
            One GSTIN for each state you supply from. Several branches in a state share its registration; each GSTIN has its own
            e-invoice login and its own e-way threshold.
          </p>
          {data.registrations.length === 0 ? (
            <p className="text-sm text-subtle">
              No GST registration yet. Until there is one, documents are issued without a GSTIN, as a company that isn&apos;t
              registered issues them.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2">GSTIN</th>
                    <th className="px-3 py-2">State</th>
                    <th className="px-3 py-2">Code</th>
                    <th className="px-3 py-2">Branches</th>
                    <th className="px-3 py-2">e-Invoicing</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.registrations.map((r) => (
                    <tr key={r.id} className="border-b border-line align-middle last:border-0">
                      <td className="px-3 py-2">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-text">{r.gstin}</span>
                          {r.isHeadOffice && <Badge tone="brand">Head office</Badge>}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-text">{r.stateName}</td>
                      <td className="px-3 py-2 font-mono text-muted">{r.code}</td>
                      <td className="px-3 py-2 text-muted">{r.branchCount}</td>
                      <td className="px-3 py-2">
                        {r.einvoice.provider ? (
                          <span className="text-text">Connected — {PROVIDER_LABELS[r.einvoice.provider] ?? r.einvoice.provider}</span>
                        ) : (
                          <Link href="/settings/einvoicing" className="text-muted hover:text-text hover:underline">
                            Not set up
                          </Link>
                        )}
                      </td>
                      <td className="px-3 py-2">{r.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                      <td className="px-3 py-2 text-right">
                        <Menu>
                          {(close) => (
                            <>
                              <MenuItem
                                onClick={() => {
                                  close();
                                  setRegistrationDialog({ id: r.id });
                                }}
                              >
                                Edit
                              </MenuItem>
                              <MenuItem
                                disabled={pending}
                                onClick={() => {
                                  close();
                                  run(
                                    () => setGstRegistrationActive(r.id, !r.active),
                                    r.active
                                      ? `GSTIN ${r.gstin} deactivated. The documents issued under it keep it.`
                                      : `GSTIN ${r.gstin} reactivated.`,
                                  );
                                }}
                              >
                                {r.active ? "Deactivate" : "Reactivate"}
                              </MenuItem>
                              <MenuSeparator />
                              <MenuItem
                                danger
                                disabled={pending}
                                onClick={() => {
                                  close();
                                  openConfirm({ kind: "delete-registration", registration: r });
                                }}
                              >
                                Delete
                              </MenuItem>
                            </>
                          )}
                        </Menu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-medium text-text">Branches</span>
          <Button type="button" size="sm" variant="secondary" onClick={() => setBranchDialog({ id: null })}>
            <Plus className="h-3.5 w-3.5" /> Add branch
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted">
            Every document is raised from a branch. Anything a branch leaves blank — the head office&apos;s address, a bank, a logo
            or the terms — prints what the Profile says.
          </p>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2">Branch</th>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">GST registration</th>
                  <th className="px-3 py-2">City</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.branches.map((b) => {
                  const registration = b.gstRegistrationId ? registrationById.get(b.gstRegistrationId) : undefined;
                  return (
                    <tr key={b.id} className="border-b border-line align-middle last:border-0">
                      <td className="px-3 py-2">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-text">{b.name}</span>
                          {b.isHeadOffice && !namedHeadOffice(b) && <Badge tone="brand">Head office</Badge>}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-muted">{b.code}</td>
                      <td className="px-3 py-2">
                        {b.gstin ? (
                          <span className="flex flex-wrap items-center gap-2 text-text">
                            <span>
                              <span className="font-mono">{b.gstin}</span> · {stateName(b.stateCode)}
                            </span>
                            {registration && !registration.active && <Badge>Inactive</Badge>}
                          </span>
                        ) : b.canIssueTaxDocuments ? (
                          // A company with no registration at all issues as it always has.
                          <span className="text-subtle">No GST registration</span>
                        ) : (
                          <span className="text-warning">No GST registration — can&apos;t issue tax invoices</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-text">
                        {b.addressSource === "organisation" ? (
                          <span className="text-muted" title={data.org.registeredOffice || undefined}>
                            Registered office
                          </span>
                        ) : (
                          (b.city ?? b.state ?? "—")
                        )}
                      </td>
                      <td className="px-3 py-2">{b.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                      <td className="px-3 py-2 text-right">
                        <Menu>
                          {(close) => (
                            <>
                              <MenuItem
                                onClick={() => {
                                  close();
                                  setBranchDialog({ id: b.id });
                                }}
                              >
                                Edit
                              </MenuItem>
                              {!b.isHeadOffice && b.active && (
                                <MenuItem
                                  disabled={pending}
                                  onClick={() => {
                                    close();
                                    openConfirm({ kind: "head-office", branch: b });
                                  }}
                                >
                                  Make head office
                                </MenuItem>
                              )}
                              {!b.isHeadOffice && (
                                <>
                                  <MenuItem
                                    disabled={pending}
                                    onClick={() => {
                                      close();
                                      run(
                                        () => setBranchActive(b.id, !b.active),
                                        b.active ? `${branchLabel(b)} deactivated.` : `${branchLabel(b)} reactivated.`,
                                      );
                                    }}
                                  >
                                    {b.active ? "Deactivate" : "Reactivate"}
                                  </MenuItem>
                                  <MenuSeparator />
                                  <MenuItem
                                    danger
                                    disabled={pending}
                                    onClick={() => {
                                      close();
                                      openConfirm({ kind: "delete-branch", branch: b });
                                    }}
                                  >
                                    Delete
                                  </MenuItem>
                                </>
                              )}
                            </>
                          )}
                        </Menu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {registrationDialog && (
        <RegistrationDialog
          key={registrationDialog.id ?? "new"}
          registration={editingRegistration}
          registrations={data.registrations}
          orgPan={data.org.pan}
          headOfficeUnregistered={Boolean(headOffice && !headOffice.gstRegistrationId)}
          onClose={() => setRegistrationDialog(null)}
          onSaved={(message, warning) => {
            setRegistrationDialog(null);
            setNotice(warning ? { tone: "info", message: `${message} ${warning}` } : { tone: "success", message });
            router.refresh();
          }}
        />
      )}

      {branchDialog && (
        <BranchDialog
          key={branchDialog.id ?? "new"}
          branch={editingBranch}
          registrations={data.registrations}
          registeredOffice={data.org.registeredOffice}
          hasActiveRegistrations={activeRegistrations.length > 0}
          onClose={() => setBranchDialog(null)}
          onSaved={(message) => {
            setBranchDialog(null);
            setNotice({ tone: "success", message });
            router.refresh();
          }}
        />
      )}

      {confirm && (
        <Dialog
          open
          onClose={() => setConfirm(null)}
          title={
            confirm.kind === "head-office"
              ? `Make ${confirm.branch.name} the head office?`
              : confirm.kind === "delete-branch"
                ? `Delete ${branchLabel(confirm.branch)}?`
                : `Delete GSTIN ${confirm.registration.gstin}?`
          }
        >
          <div className="space-y-3 text-sm text-text">
            {confirm.kind === "head-office" ? (
              <>
                <p>
                  Documents that don&apos;t name a branch, and new documents from people with no branch set, will come from{" "}
                  {confirm.branch.name}. Numbering is unaffected unless your series are per branch.
                </p>
                {headOffice?.addressSource === "organisation" && (
                  <p className="text-muted">
                    {headOffice.name} prints the registered office today. That address is copied into it, so it goes on printing
                    the same.
                  </p>
                )}
                <p className="text-muted">
                  The Profile then shows the head office&apos;s GSTIN without letting it be edited there — a head office with its
                  own address is managed here.
                </p>
              </>
            ) : (
              <p>
                It&apos;s removed for good. Anything a document, payment, ledger line or person names can only be deactivated — if
                something does, you&apos;ll be told what.
              </p>
            )}
            {confirmError && (
              <p role="alert" className="text-sm text-danger">
                {confirmError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm(null)} disabled={pending}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant={confirm.kind === "head-office" ? "primary" : "danger"}
                onClick={confirmAction}
                disabled={pending}
              >
                {pending ? "Working…" : confirm.kind === "head-office" ? "Make head office" : "Delete"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** "invoices, credit notes and delivery challans" */
function joinList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The default `{GST}` code for a state, with a digit when it is taken — the server's own rule (§3.4 rule 4). */
function freeCode(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}${n}`;
    if (candidate.length <= 4 && !taken.has(candidate)) return candidate;
  }
  return "";
}

type Feedback = { tone: "muted" | "danger" | "success"; text: string };

/**
 * What is wrong with a GSTIN, in the order somebody typing it meets the problems: its shape, then its
 * check digit, then whose PAN it is. The same checks `saveGstRegistration` makes — pure functions of
 * the string, so they cost nothing to run on every keystroke.
 */
function gstinFeedback(value: string, orgPan: string | null): Feedback | null {
  if (!value) return null;
  if (value.length < 15) return { tone: "muted", text: `${value.length} of 15 characters.` };
  if (value.length > 15) return { tone: "danger", text: `A GSTIN is 15 characters — this is ${value.length}.` };
  if (!GSTIN_PATTERN.test(value)) {
    return { tone: "danger", text: "That doesn't look like a GSTIN: two digits for the state, the ten-character PAN, then three more." };
  }
  const code = value.slice(0, 2);
  if (!GST_STATE_CODES[code] || code === OTHER_COUNTRY_CODE) {
    return { tone: "danger", text: `${code} isn't a GST state code — check the first two digits.` };
  }
  if (!hasValidGstinChecksum(value)) {
    return { tone: "danger", text: "The last character isn't this GSTIN's check digit — one of the characters is probably mistyped." };
  }
  const pan = panOfGstin(value)!;
  if (orgPan && pan !== orgPan) {
    return {
      tone: "danger",
      text: `That GSTIN belongs to PAN ${pan}; this company's PAN is ${orgPan}. A different PAN is a different company — a separate workspace.`,
    };
  }
  return {
    tone: "success",
    text: `Valid — ${GST_STATE_CODES[code]}, PAN ${pan}.${orgPan ? "" : ` The company's PAN will be set to ${pan} from it.`}`,
  };
}

const FEEDBACK_TONES: Record<Feedback["tone"], string> = { muted: "text-subtle", danger: "text-danger", success: "text-success" };

function RegistrationDialog({
  registration,
  registrations,
  orgPan,
  headOfficeUnregistered,
  onClose,
  onSaved,
}: {
  registration: RegistrationRow | null;
  registrations: RegistrationRow[];
  orgPan: string | null;
  headOfficeUnregistered: boolean;
  onClose: () => void;
  onSaved: (message: string, warning?: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [gstin, setGstin] = useState(registration?.gstin ?? "");
  const [code, setCode] = useState(registration?.code ?? "");
  // A code somebody chose is kept; one that is still its state's default follows the GSTIN's state.
  const [codeTouched, setCodeTouched] = useState(
    () => Boolean(registration && registration.code !== GST_STATE_ABBREVIATIONS[registration.stateCode]),
  );
  const [error, setError] = useState<string | null>(null);

  const value = gstin.trim().toUpperCase();
  // Rule 5: the GSTIN is on every document issued under it, and on the returns filed from them.
  const locked = Boolean(registration && registration.issuedDocumentCount > 0);
  const changed = !registration || value !== registration.gstin;
  const prefix = /^[0-9]{2}/.test(value) ? value.slice(0, 2) : null;
  const stateCode = prefix && prefix !== OTHER_COUNTRY_CODE && GST_STATE_CODES[prefix] ? prefix : null;
  const taken = new Set(registrations.filter((r) => r.id !== registration?.id).map((r) => r.code));
  const suggested = stateCode && GST_STATE_ABBREVIATIONS[stateCode] ? freeCode(GST_STATE_ABBREVIATIONS[stateCode], taken) : "";
  const effectiveCode = codeTouched ? code : suggested || code;
  const feedback = changed ? gstinFeedback(value, orgPan) : null;
  const ready = (!changed || feedback?.tone === "success") && effectiveCode.trim().length > 0;

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveGstRegistration({ id: registration?.id ?? "", gstin: value, code: effectiveCode });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved(`GSTIN ${value} saved.`, result.data.warning);
    });
  }

  const issued = registration?.issuedDocumentCount ?? 0;

  return (
    <Dialog open onClose={onClose} title={registration ? `Edit GSTIN ${registration.gstin}` : "Add a GST registration"}>
      <div className="space-y-4">
        <Field
          label="GSTIN"
          hint={
            locked
              ? `${issued} issued document${issued === 1 ? " carries" : "s carry"} this GSTIN, so it can't change. A new GSTIN is a new registration: add it, move the branches to it, and deactivate this one.`
              : "15 characters, as on the registration certificate."
          }
        >
          {(id) => (
            <>
              <Input
                id={id}
                value={gstin}
                readOnly={locked}
                onChange={(e) => setGstin(e.target.value.toUpperCase().replace(/\s+/g, ""))}
                placeholder="27AAPFU0939F1ZV"
                autoComplete="off"
                spellCheck={false}
                className={`font-mono ${locked ? "bg-surface-sunken" : ""}`}
              />
              <p aria-live="polite" className={`text-xs ${feedback ? FEEDBACK_TONES[feedback.tone] : ""}`}>
                {feedback?.text}
              </p>
            </>
          )}
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="State" hint="The GSTIN's first two digits decide it.">
            {(id) => (
              <Input
                id={id}
                readOnly
                value={stateCode ? `${GST_STATE_CODES[stateCode]} (${stateCode})` : ""}
                placeholder="From the GSTIN"
                className="bg-surface-sunken"
              />
            )}
          </Field>
          <Field label="Code" hint="What {GST} prints in a number prefix — 1 to 4 letters or digits.">
            {(id) => (
              <Input
                id={id}
                value={effectiveCode}
                maxLength={4}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase());
                  setCodeTouched(true);
                }}
                className="font-mono"
                autoComplete="off"
              />
            )}
          </Field>
        </div>

        {!registration && headOfficeUnregistered && (
          <p className="text-xs text-subtle">
            The head office has no GST registration yet. This one is given to it when it&apos;s in the head office&apos;s state.
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={save} disabled={!ready || pending}>
            {pending ? "Saving…" : registration ? "Save" : "Add registration"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function BranchDialog({
  branch,
  registrations,
  registeredOffice,
  hasActiveRegistrations,
  onClose,
  onSaved,
}: {
  branch: BranchRow | null;
  registrations: RegistrationRow[];
  registeredOffice: string;
  hasActiveRegistrations: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const isHeadOffice = branch?.isHeadOffice ?? false;
  const [form, setForm] = useState(() => ({
    name: branch?.name ?? "",
    code: branch?.code ?? "",
    gstRegistrationId: branch?.gstRegistrationId ?? "",
    addressLine1: branch?.addressLine1 ?? "",
    addressLine2: branch?.addressLine2 ?? "",
    city: branch?.city ?? "",
    state: branch?.state ?? "",
    pincode: branch?.pincode ?? "",
    country: branch?.country ?? "",
    email: branch?.email ?? "",
    phone: branch?.phone ?? "",
    bankName: branch?.bankName ?? "",
    bankAccountNumber: branch?.bankAccountNumber ?? "",
    bankIfsc: branch?.bankIfsc ?? "",
    bankBranch: branch?.bankBranch ?? "",
    upiId: branch?.upiId ?? "",
    invoiceTerms: branch?.invoiceTerms ?? "",
    invoiceNotes: branch?.invoiceNotes ?? "",
  }));
  // Only the head office may print the registered office; any other branch has an address of its own.
  const [useRegisteredOffice, setUseRegisteredOffice] = useState(isHeadOffice && branch?.addressSource === "organisation");
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  // Active registrations, and the retired one an inactive branch may keep.
  const choices = registrations.filter((r) => r.active || r.id === branch?.gstRegistrationId);
  const selected = registrations.find((r) => r.id === form.gstRegistrationId) ?? null;

  /**
   * The state check, said before Save. The server decides (it also knows the registered office's
   * stored code, which this form doesn't); this only reads the address being typed.
   */
  const abroad = !useRegisteredOffice && !isIndia(form.country);
  const addressCode = useRegisteredOffice || abroad ? null : stateCodeFromName(form.state);
  const registrationHint =
    selected && abroad
      ? "A branch outside India can't hold a GST registration — leave it blank."
      : selected && addressCode && addressCode !== selected.stateCode
        ? `A GSTIN is state-specific — this address is in ${stateName(addressCode)}, and GSTIN ${selected.gstin} is ${selected.stateName}'s.`
        : !selected && hasActiveRegistrations
          ? "Without a GST registration this branch can't issue tax invoices, credit notes or delivery challans."
          : null;
  const matching = !selected && addressCode ? choices.filter((r) => r.active && r.stateCode === addressCode) : [];

  const overrides = [
    form.bankName,
    form.bankAccountNumber,
    form.bankIfsc,
    form.bankBranch,
    form.upiId,
    form.invoiceTerms,
    form.invoiceNotes,
  ].filter((v) => v.trim()).length + (branch?.hasLogo ? 1 : 0) + (branch?.hasSignature ? 1 : 0);

  function save() {
    setError(null);
    const { addressLine1, addressLine2, city, state, pincode, country, ...rest } = form;
    startTransition(async () => {
      const result = await saveBranch({
        ...rest,
        id: branch?.id ?? "",
        // Left out, not blanked: the head office then prints the registered office.
        ...(useRegisteredOffice ? {} : { addressLine1, addressLine2, city, state, pincode, country }),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved(`${form.name.trim() || "The branch"} saved.`);
    });
  }

  return (
    <Dialog open onClose={onClose} large title={branch ? `Edit ${branchLabel(branch)}` : "Add a branch"}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Name" className="sm:col-span-2">
            {(id) => <Input id={id} value={form.name} onChange={set("name")} placeholder="Pune warehouse" maxLength={80} />}
          </Field>
          <Field label="Code" hint="What {BR} prints — 1 to 6 letters or digits.">
            {(id) => (
              <Input
                id={id}
                value={form.code}
                maxLength={6}
                onChange={(e) => setForm((prev) => ({ ...prev, code: e.target.value.toUpperCase() }))}
                className="font-mono"
                autoComplete="off"
              />
            )}
          </Field>
        </div>

        <Field label="GST registration">
          {(id) => (
            <>
              <Select id={id} value={form.gstRegistrationId} onChange={set("gstRegistrationId")}>
                <option value="">No GST registration</option>
                {choices.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.gstin} · {r.stateName}
                    {r.active ? "" : " (inactive)"}
                  </option>
                ))}
              </Select>
              {registrationHint && <p className="text-xs text-warning">{registrationHint}</p>}
              {matching.length > 0 && (
                <p className="text-xs text-muted">
                  {matching.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="mr-3 font-medium text-brand underline-offset-2 hover:underline"
                      onClick={() => setForm((prev) => ({ ...prev, gstRegistrationId: r.id }))}
                    >
                      Use GSTIN {r.gstin}, {r.stateName}&apos;s
                    </button>
                  ))}
                </p>
              )}
            </>
          )}
        </Field>

        <div className="space-y-3 rounded-base border border-line p-3">
          <p className="text-[13px] font-medium text-muted">Address</p>
          {isHeadOffice && (
            <label className="flex items-start gap-2.5 text-sm text-text">
              <input
                type="checkbox"
                checked={useRegisteredOffice}
                onChange={(e) => setUseRegisteredOffice(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--brand)]"
              />
              <span>
                Use the registered office address
                <span className="block text-xs text-subtle">
                  {registeredOffice ? (
                    registeredOffice
                  ) : (
                    <>
                      The{" "}
                      <Link href="/settings/organisation" className="text-brand hover:underline">
                        Profile
                      </Link>{" "}
                      has no registered office address yet.
                    </>
                  )}
                </span>
              </span>
            </label>
          )}
          {!useRegisteredOffice && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Address line 1">
                {(id) => <Input id={id} value={form.addressLine1} onChange={set("addressLine1")} />}
              </Field>
              <Field label="Address line 2">
                {(id) => <Input id={id} value={form.addressLine2} onChange={set("addressLine2")} />}
              </Field>
              <div className="sm:col-span-2">
                <AddressFields
                  columns={2}
                  country={form.country}
                  state={form.state}
                  city={form.city}
                  pincode={form.pincode}
                  onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
                />
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Email" hint="Blank prints the organisation's.">
            {(id) => <Input id={id} type="email" value={form.email} onChange={set("email")} />}
          </Field>
          <Field label="Phone" hint="Blank prints the organisation's.">
            {(id) => <Input id={id} value={form.phone} onChange={set("phone")} />}
          </Field>
        </div>

        <details className="group rounded-base border border-line">
          <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-2 text-sm text-muted marker:hidden hover:text-text">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
            Printing overrides (optional — blank uses the organisation&apos;s)
            {overrides > 0 && <span className="text-subtle">· {overrides} set</span>}
          </summary>
          <div className="space-y-4 border-t border-line p-3">
            <p className="text-xs text-subtle">
              The bank details print as a block: this branch&apos;s when it has an account number or a UPI ID, otherwise the
              organisation&apos;s — never a mixture of the two.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Bank name">{(id) => <Input id={id} value={form.bankName} onChange={set("bankName")} />}</Field>
              <Field label="Account number">
                {(id) => <Input id={id} value={form.bankAccountNumber} onChange={set("bankAccountNumber")} className="font-mono" />}
              </Field>
              <Field label="IFSC">
                {(id) => <Input id={id} value={form.bankIfsc} onChange={set("bankIfsc")} className="font-mono" />}
              </Field>
              <Field label="Bank branch">{(id) => <Input id={id} value={form.bankBranch} onChange={set("bankBranch")} />}</Field>
              <Field label="UPI ID">{(id) => <Input id={id} value={form.upiId} onChange={set("upiId")} />}</Field>
            </div>
            <Field label="Terms & conditions" hint="Pre-filled on new documents from this branch.">
              {(id) => <Textarea id={id} rows={3} value={form.invoiceTerms} onChange={set("invoiceTerms")} />}
            </Field>
            <Field label="Footer note">
              {(id) => <Textarea id={id} rows={2} value={form.invoiceNotes} onChange={set("invoiceNotes")} />}
            </Field>
            {branch ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <ImageField branchId={branch.id} kind="logo" label="Logo" current={branch.logoDataUrl} fallback="the usual logo" />
                <ImageField
                  branchId={branch.id}
                  kind="signature"
                  label="Signature / stamp"
                  current={branch.signatureDataUrl}
                  fallback="the organisation's"
                />
              </div>
            ) : (
              <p className="text-xs text-subtle">Save the branch first, then add its own logo or signature here.</p>
            )}
          </div>
        </details>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={save} disabled={pending || !form.name.trim() || !form.code.trim()}>
            {pending ? "Saving…" : branch ? "Save" : "Add branch"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * A branch's own logo or signature — the organisation's uploader (`organisation-manager.tsx`), saved
 * at once rather than with the form, as that one is. SVG is refused here and by the server: an SVG can
 * carry script, and these print on every document.
 */
function ImageField({
  branchId,
  kind,
  label,
  current,
  fallback,
}: {
  branchId: string;
  kind: "logo" | "signature";
  label: string;
  current: string | null;
  fallback: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save(dataUrl: string | null) {
    startTransition(async () => {
      const result = await setBranchImage({ branchId, kind, dataUrl });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function upload(file: File) {
    setError(null);
    if (!IMAGE_TYPES.includes(file.type)) {
      setError("Use a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError("That image is over 256KB — use a smaller one.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => save(String(reader.result));
    reader.readAsDataURL(file);
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      <div className="flex flex-wrap items-center gap-3">
        {current ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={current} alt={label} className="h-14 w-auto rounded-base border border-line bg-white object-contain p-1" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setError(null);
                save(null);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          </>
        ) : (
          <>
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload(file);
                e.target.value = "";
              }}
            />
            <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => input.current?.click()}>
              <Upload className="h-3.5 w-3.5" /> Upload
            </Button>
            <span className="text-xs text-subtle">PNG, JPEG or WebP, up to 256KB. Blank prints {fallback}.</span>
          </>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/** A label that names its control — `organisation-manager.tsx`'s `Field`, for the same reason. */
function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  className?: string;
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  );
}
