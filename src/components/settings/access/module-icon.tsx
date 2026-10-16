import {
  BarChart3,
  BriefcaseBusiness,
  CircleDollarSign,
  ClipboardList,
  Contact,
  FileSpreadsheet,
  Headset,
  Laptop,
  Megaphone,
  Package,
  ReceiptText,
  Settings,
  ShoppingCart,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ModuleIcon as ModuleIconKey } from "@/lib/staff/access-modules";

const ICONS: Record<ModuleIconKey, LucideIcon> = {
  crm: Contact,
  sales: ReceiptText,
  purchases: ShoppingCart,
  products: Package,
  projects: BriefcaseBusiness,
  finance: CircleDollarSign,
  support: Headset,
  marketing: Megaphone,
  hr: Users,
  performance: BarChart3,
  assets: Laptop,
  work: ClipboardList,
  data: FileSpreadsheet,
  settings: Settings,
};

/** A module's icon on the Roles & Permissions and Users screens. */
export function ModuleIcon({ icon, className }: { icon: ModuleIconKey; className?: string }) {
  const Icon = ICONS[icon];
  return <Icon className={className} aria-hidden />;
}
