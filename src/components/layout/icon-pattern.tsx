import { useId } from "react";
import {
  BadgeCheck,
  Building2,
  CalendarClock,
  ChartColumn,
  ChartPie,
  ClipboardCheck,
  Cloud,
  Cpu,
  FileText,
  Handshake,
  Headset,
  IndianRupee,
  KeyRound,
  Laptop,
  Mail,
  MapPin,
  Monitor,
  Package,
  Printer,
  Receipt,
  RefreshCw,
  Router,
  Server,
  ShieldCheck,
  ShoppingCart,
  Smartphone,
  Target,
  Ticket,
  Truck,
  Wallet,
  type LucideIcon,
} from "lucide-react";

/**
 * The tile: what the business actually handles — quotes, orders, deliveries, laptops and servers,
 * licences and renewals, tickets, collections — each placed by hand once so that no two touch when
 * the tile repeats. Positions are the icon's centre within a 360 × 216 tile; the tile's edges are
 * kept clear by at least half an icon so a seam never cuts one in two.
 */
const TILE = { width: 360, height: 216 };
const ICONS: { icon: LucideIcon; x: number; y: number; size: number; rotate: number }[] = [
  { icon: Receipt, x: 28, y: 30, size: 22, rotate: -12 },
  { icon: Laptop, x: 100, y: 22, size: 24, rotate: 6 },
  { icon: ChartColumn, x: 164, y: 38, size: 20, rotate: -4 },
  { icon: Truck, x: 244, y: 24, size: 24, rotate: 10 },
  { icon: KeyRound, x: 316, y: 40, size: 20, rotate: -18 },

  { icon: Server, x: 58, y: 84, size: 22, rotate: 8 },
  { icon: Ticket, x: 132, y: 78, size: 20, rotate: -16 },
  { icon: IndianRupee, x: 204, y: 92, size: 20, rotate: 12 },
  { icon: Cloud, x: 276, y: 80, size: 24, rotate: -6 },
  { icon: Printer, x: 338, y: 100, size: 20, rotate: 14 },

  { icon: FileText, x: 22, y: 140, size: 20, rotate: 10 },
  { icon: Headset, x: 92, y: 136, size: 22, rotate: -8 },
  { icon: ShieldCheck, x: 162, y: 148, size: 20, rotate: 16 },
  { icon: Package, x: 232, y: 140, size: 24, rotate: -12 },
  { icon: Monitor, x: 304, y: 152, size: 22, rotate: 4 },

  { icon: RefreshCw, x: 52, y: 192, size: 18, rotate: -10 },
  { icon: Handshake, x: 122, y: 190, size: 22, rotate: 6 },
  { icon: CalendarClock, x: 194, y: 196, size: 20, rotate: -14 },
  { icon: Router, x: 266, y: 194, size: 20, rotate: 12 },
  { icon: Wallet, x: 334, y: 190, size: 18, rotate: -6 },
];

/**
 * A second, offset copy of the tile uses a different set, so the repeat is not obvious at a glance:
 * with one set, the same laptop turns up at the same angle every 360 pixels and the eye finds it.
 */
const SECOND: LucideIcon[] = [
  Building2, Smartphone, ChartPie, Mail, Cpu,
  BadgeCheck, ShoppingCart, Target, MapPin, ClipboardCheck,
];

/**
 * Faint line icons behind a header, the way a stationery pattern sits behind a letterhead.
 *
 * Drawn as an SVG pattern rather than an image: it takes its colour from `currentColor`, so it
 * follows the theme and the brand colour without a second asset for dark mode, and it costs no
 * request. Decorative only — hidden from assistive technology and from the pointer, so it can sit
 * under text and links without getting in the way of either.
 */
export function IconPattern({ className }: { className?: string }) {
  // Two headers on one page must not share a pattern id, or the second paints with the first's.
  const id = `icon-pattern-${useId().replace(/:/g, "")}`;

  return (
    <svg aria-hidden="true" focusable="false" className={className} width="100%" height="100%">
      <defs>
        <pattern id={id} width={TILE.width} height={TILE.height * 2} patternUnits="userSpaceOnUse">
          {ICONS.map(({ icon: Icon, x, y, size, rotate }, i) => (
            <g key={`a${i}`} transform={`rotate(${rotate} ${x} ${y})`}>
              <Icon x={x - size / 2} y={y - size / 2} width={size} height={size} strokeWidth={1.25} />
            </g>
          ))}
          {/* The lower half: the same positions shifted half a tile across, with the second set, so
              rows alternate rather than repeat. */}
          {ICONS.map(({ x, y, size, rotate }, i) => {
            const Icon = SECOND[i % SECOND.length];
            const shifted = (x + TILE.width / 2) % TILE.width;
            return (
              <g key={`b${i}`} transform={`rotate(${-rotate} ${shifted} ${y + TILE.height})`}>
                <Icon x={shifted - size / 2} y={y + TILE.height - size / 2} width={size} height={size} strokeWidth={1.25} />
              </g>
            );
          })}
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
