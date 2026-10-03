"use client";

import { useState, useTransition } from "react";
import type { z } from "zod";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import {
  createTicketSchema,
  type CreateTicketInput,
  ticketPriorityValues,
  ticketTypeValues,
} from "@/lib/validation/ticket";
import { createTicket, listCompanyOrderOptions } from "@/actions/ticket";
import { ticketTypeLabels } from "@/lib/tickets";
import { formatOrderId } from "@/lib/order-id";
import { ticketPath } from "@/lib/record-links";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";

type AssignableUser = { id: string; name: string; role: string };
type OrderOption = Awaited<ReturnType<typeof listCompanyOrderOptions>>[number];

type FormValues = z.input<typeof createTicketSchema>;

export function NewTicketForm({
  companies,
  initialCompanyId,
  itemsEnabled,
  initialOrders = [],
  users,
}: {
  companies: CompanyComboOption[];
  initialCompanyId?: string;
  itemsEnabled: boolean;
  initialOrders?: OrderOption[];
  users: AssignableUser[];
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [orders, setOrders] = useState<OrderOption[]>(initialOrders);
  const [ordersPending, startOrdersTransition] = useTransition();
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateTicketInput>({
    resolver: zodResolver(createTicketSchema),
    defaultValues: { companyId: initialCompanyId ?? "", priority: "MEDIUM", ticketType: "PRODUCT_SUPPORT" },
  });

  const selectedCompanyId = watch("companyId");
  const selectedCompany = companies.find((c) => c.id === selectedCompanyId);

  function loadOrdersFor(companyId: string) {
    if (!itemsEnabled) return;
    startOrdersTransition(async () => {
      const result = await listCompanyOrderOptions(companyId);
      setOrders(result);
    });
  }

  async function onSubmit(values: CreateTicketInput) {
    setServerError(null);
    const result = await createTicket(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.push(ticketPath(result.data.ticketSeq));
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {serverError && <div className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</div>}

          <div className="space-y-1.5">
            <Label htmlFor="companyId">Company *</Label>
            <Controller
              name="companyId"
              control={control}
              render={({ field }) => (
                <CompanyCombobox
                  companies={companies}
                  value={field.value ?? ""}
                  onSelect={(company) => {
                    field.onChange(company?.id ?? "");
                    setValue("companyProductId", "");
                    if (company) loadOrdersFor(company.id);
                    else setOrders([]);
                  }}
                />
              )}
            />
            {errors.companyId && <p className="text-xs text-danger">{errors.companyId.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="contactId">Contact</Label>
            <Select id="contactId" {...register("contactId")} disabled={!selectedCompany}>
              <option value="">No specific contact</option>
              {selectedCompany?.contacts?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.designation.replaceAll("_", " ")})
                </option>
              ))}
            </Select>
          </div>

          {itemsEnabled && (
            <div className="space-y-1.5">
              <Label htmlFor="companyProductId">Order this is about</Label>
              <Select id="companyProductId" {...register("companyProductId")} disabled={!selectedCompany || ordersPending}>
                <option value="">Free Support (no specific order)</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {formatOrderId(o.orderSeq)} — {o.item.name}
                  </option>
                ))}
              </Select>
              {selectedCompany && !ordersPending && orders.length === 0 && (
                <p className="text-xs text-subtle">
                  No orders on file for this company — this will be logged as Free Support.
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="title">Title *</Label>
            <Input id="title" placeholder="e.g. Can't sign in to Microsoft 365" {...register("title")} />
            {errors.title && <p className="text-xs text-danger">{errors.title.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" {...register("description")} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="ticketType">Support type</Label>
              <Select id="ticketType" {...register("ticketType")}>
                {ticketTypeValues.map((t) => (
                  <option key={t} value={t}>
                    {ticketTypeLabels[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="priority">Priority</Label>
              <Select id="priority" {...register("priority")}>
                {ticketPriorityValues.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="assignedToUserId">Assign to</Label>
            <Select id="assignedToUserId" {...register("assignedToUserId")}>
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))}
            </Select>
            {users.length === 0 && (
              <p className="text-xs text-subtle">
                No one is in the Tech Support department yet — mark a department for ticket assignment under
                Settings.
              </p>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Create ticket"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
