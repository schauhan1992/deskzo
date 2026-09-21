"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createVisit, updateVisit, visitFormOptions } from "@/actions/visit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { visitPurposeValues, visitPurposeLabels } from "@/lib/visits";
import { CompanyCombobox } from "@/components/ui/company-combobox";

type Company = { id: string; name: string };
type Options = Awaited<ReturnType<typeof visitFormOptions>>;

export type VisitFormDefaults = {
  id?: string;
  companyId: string;
  contactId: string;
  leadId: string;
  locationId: string;
  purpose: string;
  agenda: string;
  scheduledFor: string;
  address: string;
  distanceKm: string;
  userId: string;
};

const EMPTY_OPTIONS: Options = { contacts: [], locations: [], leads: [] };

export function VisitForm({
  companies,
  assignees,
  currentUserId,
  defaults,
}: {
  companies: Company[];
  assignees: { id: string; name: string; role: string }[];
  currentUserId: string;
  defaults: VisitFormDefaults;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [companyId, setCompanyId] = useState(defaults.companyId);
  const [fetched, setFetched] = useState<{ companyId: string; options: Options }>({
    companyId: "",
    options: EMPTY_OPTIONS,
  });
  const [contactId, setContactId] = useState(defaults.contactId);
  const [leadId, setLeadId] = useState(defaults.leadId);
  const [locationId, setLocationId] = useState(defaults.locationId);
  const [purpose, setPurpose] = useState(defaults.purpose);
  const [agenda, setAgenda] = useState(defaults.agenda);
  const [scheduledFor, setScheduledFor] = useState(defaults.scheduledFor);
  const [address, setAddress] = useState(defaults.address);
  const [addressTouched, setAddressTouched] = useState(!!defaults.address);
  const [distanceKm, setDistanceKm] = useState(defaults.distanceKm);
  const [userId, setUserId] = useState(defaults.userId || currentUserId);

  // Contacts, locations and open leads all belong to the chosen company, so they're fetched when
  // one is picked rather than shipping every company's down to the browser up front.
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    visitFormOptions(companyId).then((options) => {
      if (!cancelled) setFetched({ companyId, options });
    });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const options = fetched.companyId === companyId ? fetched.options : EMPTY_OPTIONS;
  const selectedLocation = options.locations.find((l) => l.id === locationId) ?? null;

  // The address follows the chosen location until someone types over it — most visits are to a
  // location already on file, and retyping it is how a visit log ends up with half-blank addresses.
  const resolvedAddress = addressTouched
    ? address
    : [selectedLocation?.address, selectedLocation?.city, selectedLocation?.state, selectedLocation?.pincode]
        .filter(Boolean)
        .join(", ");

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const payload = {
      ...(defaults.id ? { id: defaults.id } : {}),
      companyId,
      contactId,
      leadId,
      locationId,
      purpose,
      agenda,
      scheduledFor,
      address: resolvedAddress,
      distanceKm,
      userId,
    };
    startTransition(async () => {
      const result = defaults.id ? await updateVisit(payload) : await createVisit(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/visits/${result.data.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="animate-fade-rise space-y-5">
      <Card>
        <CardHeader className="text-sm font-medium text-text">Who and where</CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="companyId">Company</Label>
            <CompanyCombobox
              id="companyId"
              companies={companies}
              value={companyId}
              onSelect={(company) => {
                setCompanyId(company?.id ?? "");
                setContactId("");
                setLeadId("");
                setLocationId("");
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="contactId">Meeting with</Label>
            <Select id="contactId" value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">Not decided yet</option>
              {options.contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.designation.replaceAll("_", " ")}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="locationId">Office</Label>
            <Select id="locationId" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Not a location on file</option>
              {options.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                  {l.city ? ` — ${l.city}` : ""}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="address">Address</Label>
            <Input
              id="address"
              value={resolvedAddress}
              onChange={(e) => {
                setAddressTouched(true);
                setAddress(e.target.value);
              }}
              placeholder="Where you're actually going"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="userId">Rep</Label>
            <Select id="userId" value={userId} onChange={(e) => setUserId(e.target.value)} disabled={!!defaults.id}>
              {assignees.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))}
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Why and when</CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="purpose">Purpose</Label>
            <Select id="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {visitPurposeValues.map((p) => (
                <option key={p} value={p}>
                  {visitPurposeLabels[p]}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="scheduledFor">Date &amp; time</Label>
            <Input
              id="scheduledFor"
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="leadId">Against lead</Label>
            <Select id="leadId" value={leadId} onChange={(e) => setLeadId(e.target.value)}>
              <option value="">Not deal-specific</option>
              {options.leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="distanceKm">Distance (km)</Label>
            <Input
              id="distanceKm"
              type="number"
              min="0"
              step="0.1"
              value={distanceKm}
              onChange={(e) => setDistanceKm(e.target.value)}
              placeholder="Round trip"
            />
            <p className="text-xs text-subtle">For the mileage claim — raise it as an expense after the visit.</p>
          </div>

          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label htmlFor="agenda">Agenda</Label>
            <Textarea
              id="agenda"
              rows={3}
              value={agenda}
              onChange={(e) => setAgenda(e.target.value)}
              placeholder="What you're going to cover"
            />
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-base border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || !companyId}>
          {pending ? "Saving…" : defaults.id ? "Save changes" : "Plan visit"}
        </Button>
        <Button type="button" variant="secondary" onClick={() => router.push(defaults.id ? `/visits/${defaults.id}` : "/visits")}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
