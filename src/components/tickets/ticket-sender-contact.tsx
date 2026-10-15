"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addTicketSenderAsContact } from "@/actions/support-mail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * "Add as contact" for whoever wrote to the ticket without being one of its company's contacts — a
 * sender filed by their domain (src/lib/support-mail/domain-match.ts). One click, with the name their
 * email gave, which can be changed first.
 */
export function TicketSenderContact({
  ticketId,
  companyName,
  people,
}: {
  ticketId: string;
  companyName: string;
  people: { address: string; name: string | null }[];
}) {
  return (
    <div className="space-y-2 rounded-base border border-info bg-info-bg px-3 py-2.5">
      {people.map((p) => (
        <SenderRow key={p.address} ticketId={ticketId} companyName={companyName} person={p} />
      ))}
    </div>
  );
}

function SenderRow({ ticketId, companyName, person }: { ticketId: string; companyName: string; person: { address: string; name: string | null } }) {
  const router = useRouter();
  const [name, setName] = useState(person.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [pending, startTransition] = useTransition();

  if (added) return <p className="text-sm text-success">Added {person.address} as a contact at {companyName}.</p>;
  return (
    <div className="space-y-1.5">
      <p className="text-sm text-text">
        {person.address} isn&apos;t a contact at {companyName} yet.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={`Name for ${person.address}`}
          placeholder="Their name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={pending}
          className="h-8 max-w-xs text-sm"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const result = await addTicketSenderAsContact({ ticketId, address: person.address, name });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setAdded(true);
              router.refresh();
            });
          }}
        >
          {pending ? "Adding…" : "Add as contact"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
