"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import type { listHolidays, listLeaveTypes } from "@/actions/hr";
import { deleteHoliday, saveHoliday, saveLeaveType } from "@/actions/hr";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";
import { formatDate } from "@/lib/utils";
import { leaveAccrualValues } from "@/lib/validation/hr";

type Holiday = Awaited<ReturnType<typeof listHolidays>>[number];
type LeaveType = Awaited<ReturnType<typeof listLeaveTypes>>[number];

export function HrSettings({
  holidays,
  leaveTypes,
  year,
}: {
  holidays: Holiday[];
  leaveTypes: LeaveType[];
  year: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <HolidayCard holidays={holidays} year={year} />
      <LeaveTypeCard leaveTypes={leaveTypes} />
    </div>
  );
}

function HolidayCard({ holidays, year }: { holidays: Holiday[]; year: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [optional, setOptional] = useState(false);

  function add() {
    setError(null);
    startTransition(async () => {
      const result = await saveHoliday({ name, date, optional });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      setDate("");
      setOptional(false);
      router.refresh();
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteHoliday(id);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Holidays in {year}</CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
          {/* The card header names the year; nothing names the two boxes under it. */}
          <Input aria-label="Holiday name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Diwali" />
          <Input aria-label="Holiday date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Button disabled={pending || !name || !date} onClick={add}>
            Add
          </Button>
        </div>
        <label className="flex items-start gap-2 text-xs text-muted">
          <Checkbox checked={optional} onChange={() => setOptional((v) => !v)} aria-label="Restricted holiday" />
          <span>
            Restricted (optional) holiday — the office stays open, so taking it costs a day of leave.
          </span>
        </label>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="space-y-1.5 border-t border-line pt-3">
          {holidays.length === 0 && <p className="text-sm text-subtle">No holidays on the calendar for {year}.</p>}
          {holidays.map((h) => (
            <div key={h.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-text">{h.name}</span>
                {h.optional && <Badge tone="amber">Restricted</Badge>}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted">{formatDate(h.date)}</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => remove(h.id)}
                  className="text-subtle hover:text-danger"
                  aria-label={`Remove ${h.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function LeaveTypeCard({ leaveTypes }: { leaveTypes: LeaveType[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    code: "",
    name: "",
    annualQuota: "12",
    accrual: "ANNUAL",
    carryForward: false,
    maxCarryForward: "",
    paid: true,
  });

  function add() {
    setError(null);
    startTransition(async () => {
      const result = await saveLeaveType({
        ...form,
        maxCarryForward: form.maxCarryForward ? Number(form.maxCarryForward) : undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setForm({ code: "", name: "", annualQuota: "12", accrual: "ANNUAL", carryForward: false, maxCarryForward: "", paid: true });
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Leave types</CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ltCode">Code</Label>
            <Input
              id="ltCode"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
              placeholder="EL"
              maxLength={10}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ltName">Name</Label>
            <Input
              id="ltName"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Earned leave"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ltQuota">Days a year</Label>
            <Input
              id="ltQuota"
              type="number"
              step="0.5"
              value={form.annualQuota}
              onChange={(e) => setForm((f) => ({ ...f, annualQuota: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ltAccrual">Credited</Label>
            <Select
              id="ltAccrual"
              value={form.accrual}
              onChange={(e) => setForm((f) => ({ ...f, accrual: e.target.value }))}
            >
              {leaveAccrualValues.map((a) => (
                <option key={a} value={a}>
                  {a === "ANNUAL" ? "All at once, in April" : "A twelfth each month"}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-xs text-muted">
            <Checkbox checked={form.paid} onChange={() => setForm((f) => ({ ...f, paid: !f.paid }))} aria-label="Paid leave" />
            Paid
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <Checkbox
              checked={form.carryForward}
              onChange={() => setForm((f) => ({ ...f, carryForward: !f.carryForward }))}
              aria-label="Carries forward"
            />
            Carries into next year
          </label>
          {form.carryForward && (
            <Input
              aria-label="Maximum days carried forward"
              type="number"
              value={form.maxCarryForward}
              onChange={(e) => setForm((f) => ({ ...f, maxCarryForward: e.target.value }))}
              placeholder="Max days"
              className="h-8 w-28 text-xs"
            />
          )}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button disabled={pending || !form.code || !form.name} onClick={add}>
          {pending ? "Saving…" : "Add leave type"}
        </Button>

        <div className="space-y-1.5 border-t border-line pt-3">
          {leaveTypes.length === 0 && (
            <p className="text-sm text-subtle">
              None yet. Indian offices usually run Casual, Sick and Earned leave, plus an unpaid type.
            </p>
          )}
          {leaveTypes.map((t) => (
            <div key={t.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="flex items-center gap-2">
                <Badge tone="default">{t.code}</Badge>
                <span className="text-text">{t.name}</span>
                {!t.paid && <Badge tone="amber">Unpaid</Badge>}
              </span>
              <span className="text-xs text-muted">
                {Number(t.annualQuota)} days · {t.accrual === "MONTHLY" ? "monthly" : "annual"}
                {t.carryForward && ` · carries ${t.maxCarryForward ? `up to ${Number(t.maxCarryForward)}` : "over"}`}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
