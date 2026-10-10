"use client";

import type { LucideIcon } from "lucide-react";
import { AtSign, BriefcaseBusiness, CalendarDays, Camera, Globe, Link as LinkIcon, Mail, MapPin, MessageCircle, Phone, Play, Users } from "lucide-react";
import { hrefFor, inkOn, kindLabel, type DrawnCard, type FieldKind } from "@/lib/cards/fields";

const ICONS: Record<FieldKind, LucideIcon> = {
  phone: Phone,
  email: Mail,
  website: Globe,
  linkedin: BriefcaseBusiness,
  whatsapp: MessageCircle,
  calendar: CalendarDays,
  address: MapPin,
  x: AtSign,
  instagram: Camera,
  facebook: Users,
  youtube: Play,
  link: LinkIcon,
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

/**
 * A digital card as people see it — on its public page, on My card, and as the template editor's
 * preview. Plain: no tracking script, nothing loaded but the photo and the logo.
 *
 * `onTap` counts a tapped link on the public page; the preview leaves it out, and links there go
 * nowhere (`inert`) so a manager trying a template doesn't ring the head office.
 */
export function CardFace({
  card,
  color,
  layout,
  logoUrl,
  photoUrl,
  onTap,
  inert = false,
  children,
}: {
  card: DrawnCard;
  color: string;
  layout: "CLASSIC" | "CENTRED";
  logoUrl: string | null;
  photoUrl: string | null;
  onTap?: (kind: FieldKind) => void;
  inert?: boolean;
  /** Under the name: Save contact, on the public page. */
  children?: React.ReactNode;
}) {
  const ink = inkOn(color);
  const centred = layout === "CENTRED";
  const subtitle = [card.title, card.department].filter(Boolean).join(" · ");

  return (
    <article className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      <div className="relative h-24" style={{ backgroundColor: color }}>
        {logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt=""
            className="absolute right-4 top-4 h-9 max-w-[45%] rounded-md bg-white/90 object-contain p-1"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        )}
      </div>
      {/* Positioned, so it paints over the band it overlaps: the band is positioned for its logo. */}
      <div className={centred ? "relative -mt-12 flex flex-col items-center px-5 text-center" : "relative -mt-12 px-5"}>
        <span
          className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-full border-4 border-surface text-2xl font-semibold"
          style={photoUrl ? undefined : { backgroundColor: color, color: ink }}
        >
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            initials(card.name)
          )}
        </span>
        <h1 className="mt-3 text-xl font-semibold text-text">{card.name}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
        {card.company && <p className="mt-0.5 text-sm font-medium text-text">{card.company}</p>}
      </div>

      {children && <div className="px-5 pt-4">{children}</div>}

      {card.fields.length > 0 && (
        <ul className="mt-4 divide-y divide-line border-t border-line">
          {card.fields.map((field, i) => {
            const Icon = ICONS[field.kind] ?? LinkIcon;
            const href = inert ? null : hrefFor(field);
            const external = !!href && href.startsWith("http");
            const body = (
              <>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full" style={{ backgroundColor: `${color}1a`, color }}>
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm text-text">{field.kind === "website" || field.kind === "link" || field.kind === "calendar" || field.kind === "linkedin" || field.kind === "x" || field.kind === "instagram" || field.kind === "facebook" || field.kind === "youtube" ? prettyUrl(field.value) : field.value}</span>
                  <span className="block text-xs text-subtle">{field.label === kindLabel(field.kind) ? field.label : `${field.label} · ${kindLabel(field.kind)}`}</span>
                </span>
              </>
            );
            return (
              <li key={`${field.kind}-${i}`}>
                {href ? (
                  <a
                    href={href}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-surface-sunken"
                    {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    onClick={() => onTap?.(field.kind)}
                  >
                    {body}
                  </a>
                ) : (
                  <div className="flex items-center gap-3 px-5 py-3">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

/** "https://www.linkedin.com/in/anaya/" → "linkedin.com/in/anaya". */
function prettyUrl(value: string): string {
  return value.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}
