import {
  BarChart3,
  BookOpen,
  Bot,
  Building2,
  CalendarDays,
  CheckCircle2,
  CreditCard,
  Database,
  DoorOpen,
  FileText,
  Fingerprint,
  Gauge,
  Globe,
  Headset,
  History,
  IndianRupee,
  KeyRound,
  Layers,
  Lock,
  Mail,
  MapPin,
  Megaphone,
  Package,
  Receipt,
  ScrollText,
  Server,
  ShieldCheck,
  Sparkles,
  Truck,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { IconName } from "@/components/site/blocks/types";
import { cn } from "@/lib/utils";

/** Content names an icon; this is the only place a name becomes a component. */
const ICONS: Record<IconName, LucideIcon> = {
  sparkles: Sparkles,
  chart: BarChart3,
  receipt: Receipt,
  package: Package,
  book: BookOpen,
  users: Users,
  headset: Headset,
  megaphone: Megaphone,
  layers: Layers,
  database: Database,
  key: KeyRound,
  fingerprint: Fingerprint,
  shield: ShieldCheck,
  scroll: ScrollText,
  door: DoorOpen,
  lock: Lock,
  server: Server,
  history: History,
  globe: Globe,
  rupee: IndianRupee,
  card: CreditCard,
  truck: Truck,
  "map-pin": MapPin,
  "file-text": FileText,
  calendar: CalendarDays,
  mail: Mail,
  check: CheckCircle2,
  bot: Bot,
  building: Building2,
  gauge: Gauge,
};

/** An icon by name; an unknown name draws the generic one rather than failing the page. */
export function SiteIcon({ name, className }: { name: string | undefined; className?: string }) {
  const Icon = (name && ICONS[name as IconName]) || Sparkles;
  return <Icon aria-hidden="true" className={cn("h-5 w-5", className)} />;
}

/** The icon in its tinted square, as feature cards show it. */
export function IconChip({ name, className }: { name: string | undefined; className?: string }) {
  return (
    <span className={cn("inline-grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-line bg-brand-subtle text-brand", className)}>
      <SiteIcon name={name} className="h-5 w-5" />
    </span>
  );
}
