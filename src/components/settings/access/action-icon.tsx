import {
  CheckCircle2,
  CircleDot,
  Download,
  Eye,
  Pencil,
  PlusCircle,
  Send,
  SlidersHorizontal,
  Trash2,
  Upload,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import type { ActionRowSpec } from "@/lib/staff/access-modules";

/** The little icon before each row of an Actions table: what kind of thing the row lets somebody do. */
type Kind = "view" | "create" | "edit" | "delete" | "export" | "import" | "approve" | "send" | "assign" | "manage" | "other";

const ICONS: Record<Kind, LucideIcon> = {
  view: Eye,
  create: PlusCircle,
  edit: Pencil,
  delete: Trash2,
  export: Download,
  import: Upload,
  approve: CheckCircle2,
  send: Send,
  assign: UserPlus,
  manage: SlidersHorizontal,
  other: CircleDot,
};

export function ActionIcon({ row, className }: { row: ActionRowSpec; className?: string }) {
  const Icon = ICONS[kindOf(row)];
  return <Icon className={className} aria-hidden />;
}

function kindOf(row: ActionRowSpec): Kind {
  if (row.kind === "record") return row.action;
  const verb = row.key.split(".")[1]?.toLowerCase() ?? "";
  if (verb.startsWith("view") || verb.startsWith("read") || verb === "see") return "view";
  if (verb.startsWith("create") || verb.startsWith("raise") || verb === "record" || verb === "request") return "create";
  if (verb.startsWith("delete") || verb === "void") return "delete";
  if (verb.startsWith("export") || verb === "download") return "export";
  if (verb.startsWith("import")) return "import";
  if (verb.startsWith("approve") || verb === "reimburse" || verb === "close") return "approve";
  if (verb === "send" || verb === "broadcast") return "send";
  if (verb === "assign" || verb === "reassign" || verb.startsWith("handoff")) return "assign";
  if (verb === "edit") return "edit";
  if (verb.startsWith("manage")) return "manage";
  return "other";
}
