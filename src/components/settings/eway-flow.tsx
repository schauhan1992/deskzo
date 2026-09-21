import { FileText, FilePlus2, ListChecks, Save, Link2, Hash, Download } from "lucide-react";

/**
 * How an e-way bill gets made, in the two ways it gets made.
 *
 * Here because the second path is otherwise invisible. Everybody finds "generate"; nobody finds
 * "associate" until they have already raised a bill on the portal by hand and then cannot work out
 * why this app still says the document is outstanding. A diagram is a poor substitute for a
 * discoverable button, but both paths have buttons — this is what tells you the second one exists.
 */

const STEPS = [
  { icon: FileText, label: "Pick the invoice, credit note or delivery challan" },
  { icon: FilePlus2, label: "Start a new e-way bill" },
  { icon: ListChecks, label: "Enter Part A and Part B" },
  { icon: Save, label: "Save and generate" },
];

const ASSOCIATE = [
  { icon: Link2, label: "Record one from the portal" },
  { icon: Hash, label: "Type the 12-digit number" },
  { icon: Download, label: "Fetch its details from the portal" },
];

function Step({ icon: Icon, label }: { icon: typeof FileText; label: string }) {
  return (
    <li className="flex min-w-0 flex-1 items-center gap-2 rounded-base border border-line bg-surface px-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-muted" />
      <span className="text-xs text-text">{label}</span>
    </li>
  );
}

export function EwayFlow() {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-subtle">Raising one here</p>
        <ol className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-stretch">
          {STEPS.map((s) => (
            <Step key={s.label} {...s} />
          ))}
        </ol>
      </div>

      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-subtle">
          Or, if it was raised on the portal
        </p>
        <ol className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-stretch">
          {ASSOCIATE.map((s) => (
            <Step key={s.label} {...s} />
          ))}
        </ol>
        <p className="mt-2 text-xs text-muted">
          {/*
            Said plainly, because it is the difference that bites: what we did not raise, we cannot
            cancel or amend through the API.
          */}
          A bill recorded this way stays the portal&rsquo;s. It stops the document showing as outstanding, but
          cancelling it or changing its vehicle has to be done on the portal too.
        </p>
      </div>
    </div>
  );
}
