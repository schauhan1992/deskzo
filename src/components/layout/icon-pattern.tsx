import { useId } from "react";
import {
  BadgeCheck,
  Banknote,
  Boxes,
  Briefcase,
  Building2,
  Calculator,
  CalendarClock,
  ChartColumn,
  ChartPie,
  ClipboardCheck,
  Cloud,
  Cpu,
  CreditCard,
  FileSpreadsheet,
  FileText,
  Handshake,
  HardDrive,
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
  Users,
  Wallet,
  Warehouse,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * What the business actually handles — quotes, orders, deliveries, laptops and servers, licences and
 * renewals, tickets, collections. Forty of them, so a tile of sixty repeats few.
 */
const ICONS: LucideIcon[] = [
  Receipt, Laptop, ChartColumn, Truck, KeyRound, Server, Ticket, IndianRupee, Cloud, Printer,
  FileText, Headset, ShieldCheck, Package, Monitor, RefreshCw, Handshake, CalendarClock, Router, Wallet,
  Building2, Smartphone, ChartPie, Mail, Cpu, BadgeCheck, ShoppingCart, Target, MapPin, ClipboardCheck,
  Users, Briefcase, Calculator, Boxes, Warehouse, FileSpreadsheet, Banknote, CreditCard, HardDrive, Wrench,
];

/**
 * The tile: a staggered lattice, every other row shifted half a column the way bricks are laid, 10
 * columns by 6 rows at 50 × 44 pixels. About twice as many icons to the square inch as a hand-placed
 * tile manages, with the gaps still wider than an icon so it reads as texture, not clutter. Each icon
 * is nudged, sized and turned a little so the lattice does not show.
 */
const COLUMNS = 10;
const ROWS = 6;
const PITCH = { x: 50, y: 44 };
const TILE = { width: COLUMNS * PITCH.x, height: ROWS * PITCH.y };

/**
 * A fixed scramble in [0, 1): the same on the server and in the browser. `Math.random` would differ
 * between the two and React would report the mismatch.
 */
function scramble(n: number) {
  return (Math.imul(n + 1, 2654435761) >>> 0) / 2 ** 32;
}

const tenth = (value: number) => Math.round(value * 10) / 10;

type Placed = { Icon: LucideIcon; x: number; y: number; size: number; rotate: number };

const PLACED: Placed[] = Array.from({ length: COLUMNS * ROWS }, (_, i) => {
  const row = Math.floor(i / COLUMNS);
  const column = i % COLUMNS;
  return {
    // Steps of 3 across and 19 down use all forty, none more than twice, and no icon within two
    // places of itself — beside, above, or on either diagonal, across the tile's seams too.
    Icon: ICONS[(column * 3 + row * 19) % ICONS.length],
    x: tenth((column + (row % 2 ? 0.75 : 0.25)) * PITCH.x + (scramble(i) - 0.5) * 12),
    y: tenth((row + 0.5) * PITCH.y + (scramble(i + 101) - 0.5) * 14),
    size: 18 + Math.floor(scramble(i + 211) * 3) * 2,
    rotate: Math.round((scramble(i + 307) - 0.5) * 36),
  };
});

/**
 * Where to draw an icon: its own place, and again one tile over for each edge it reaches past. The
 * tile clips at its edges, so the part cut off here is exactly the part the neighbouring tile paints
 * there, and the seam runs through the icon without cutting it.
 */
function copies({ x, y, size }: Placed): [number, number][] {
  // Half the icon's box, turned up to 45°, is at most 0.71 of its size; the drawing sits inside that.
  const reach = size * 0.71;
  const across = [0, ...(x - reach < 0 ? [TILE.width] : []), ...(x + reach > TILE.width ? [-TILE.width] : [])];
  const down = [0, ...(y - reach < 0 ? [TILE.height] : []), ...(y + reach > TILE.height ? [-TILE.height] : [])];
  return across.flatMap((dx) => down.map((dy): [number, number] => [dx, dy]));
}

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
        <pattern id={id} width={TILE.width} height={TILE.height} patternUnits="userSpaceOnUse">
          {PLACED.flatMap((placed, i) =>
            copies(placed).map(([dx, dy]) => {
              const { Icon, size, rotate } = placed;
              const x = placed.x + dx;
              const y = placed.y + dy;
              return (
                <g key={`${i}:${dx}:${dy}`} transform={`rotate(${rotate} ${x} ${y})`}>
                  <Icon x={x - size / 2} y={y - size / 2} width={size} height={size} strokeWidth={1.25} />
                </g>
              );
            }),
          )}
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
