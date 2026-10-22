"use client";

import { useEffect, useEffectEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LocateFixed, MapPin } from "lucide-react";
import { saveOfficeLocation, type OfficeLocationRow } from "@/actions/attendance-location";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/settings/access/switch";
import { ACCURACY_LIMITS, RADIUS_LIMITS } from "@/lib/hr/geofence";
import { locationAllowedHere, reloadToUseLocation, takeCarriedTap } from "@/lib/browser-location";

/**
 * Settings › People › Attendance locations (owner, 22 Oct 2026): each office's point, radius, accuracy limit and
 * switches. The server checks everything again (src/actions/attendance-location.ts); this only helps type it.
 */
export function OfficeLocations({ migrated, offices }: { migrated: boolean; offices: OfficeLocationRow[] }) {
  return (
    <>
      {!migrated && (
        <p role="status" className="max-w-3xl rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-text">
          This workspace&apos;s database hasn&apos;t had its GPS attendance update yet, so nothing here can be saved. Clocking in works as it always
          has until it does.
        </p>
      )}
      {offices.length === 0 && <p className="text-sm text-muted">No offices yet — add one in Settings › Branches first.</p>}
      <div className="space-y-4">
        {offices.map((office) => (
          <OfficeCard key={office.id} office={office} disabled={!migrated} />
        ))}
      </div>
    </>
  );
}

const asText = (n: number | null) => (n === null ? "" : String(n));

function OfficeCard({ office, disabled }: { office: OfficeLocationRow; disabled: boolean }) {
  const router = useRouter();
  const [latitude, setLatitude] = useState(asText(office.latitude));
  const [longitude, setLongitude] = useState(asText(office.longitude));
  const [radius, setRadius] = useState(String(office.geofenceRadiusM));
  const [accuracy, setAccuracy] = useState(String(office.geoMaxAccuracyM));
  const [enforced, setEnforced] = useState(office.geofenceEnforced);
  const [exceptions, setExceptions] = useState(office.geoExceptionsAllowed);
  const [locating, setLocating] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const configured = office.latitude !== null && office.longitude !== null;
  const lat = Number(latitude);
  const lng = Number(longitude);
  const mapLink = latitude.trim() && longitude.trim() && Number.isFinite(lat) && Number.isFinite(lng) ? `https://www.google.com/maps?q=${lat},${lng}` : null;

  // A pair pasted from a map ("12.9716, 77.5946") fills both boxes.
  function pastePair(e: React.ClipboardEvent<HTMLInputElement>) {
    const parts = e.clipboardData.getData("text").split(/[,\s]+/).filter(Boolean);
    if (parts.length === 2 && parts.every((p) => Number.isFinite(Number(p)))) {
      e.preventDefault();
      setLatitude(parts[0]!);
      setLongitude(parts[1]!);
    }
  }

  // Reached by a link inside the app, the page may not be allowed to ask yet: reloaded as itself, it carries on.
  const carryOn = useEffectEvent(() => fillFromDevice(true));
  useEffect(() => {
    if (takeCarriedTap("locate", office.id) !== null) carryOn();
  }, [office.id]);

  function fillFromDevice(reloaded = false) {
    setMessage(null);
    if (!reloaded && locationAllowedHere() === false && reloadToUseLocation("locate", office.id)) return;
    if (!("geolocation" in navigator)) {
      setMessage({ ok: false, text: "This browser can't tell where it is. Type the office's latitude and longitude instead." });
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setLatitude(pos.coords.latitude.toFixed(6));
        setLongitude(pos.coords.longitude.toFixed(6));
        setMessage({
          ok: true,
          text: `Filled from this device, accurate to about ${Math.round(pos.coords.accuracy)} m. Check it on the map before saving — a laptop's location can be far off.`,
        });
      },
      (err) => {
        setLocating(false);
        // A browser that can't say whether the page may ask: the refusal could be the page's — reload once to see.
        if (err.code === err.PERMISSION_DENIED && !reloaded && locationAllowedHere() === null && reloadToUseLocation("locate", office.id)) return;
        setMessage({
          ok: false,
          text: err.code === err.PERMISSION_DENIED ? "Location is blocked for this site in the browser. Allow it, or type the coordinates." : "Couldn't get this device's location. Type the coordinates instead.",
        });
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveOfficeLocation({
        branchId: office.id,
        latitude: latitude.trim() || null,
        longitude: longitude.trim() || null,
        radiusM: radius.trim() || null,
        maxAccuracyM: accuracy.trim() || null,
        enforced,
        exceptionsAllowed: exceptions,
      });
      if (!result.ok) {
        setMessage({ ok: false, text: result.error });
        return;
      }
      setMessage({ ok: true, text: enforced ? "Saved. Clocking in and out here now needs the phone or browser inside this area." : "Saved." });
      router.refresh();
    });
  }

  const id = (name: string) => `office-${office.id}-${name}`;
  return (
    <Card className="max-w-3xl p-5" role="region" aria-labelledby={id("name")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id("name")} className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text">
            {office.name}
            {office.isHeadOffice && <span className="rounded-full bg-brand-subtle px-2 py-0.5 text-[11px] font-medium text-brand">Head office</span>}
            {!office.active && <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-muted">Inactive</span>}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {office.address || "No address"} · {office.people} {office.people === 1 ? "person" : "people"}
            {office.isHeadOffice && " (with everybody not given a branch)"}
          </p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${office.geofenceEnforced ? "bg-success-bg text-success" : configured ? "bg-surface-sunken text-muted" : "bg-warning-bg text-text"}`}>
          {office.geofenceEnforced ? "GPS attendance on" : configured ? "GPS attendance off" : "Setup required"}
        </span>
      </div>

      {!configured && (
        <p className="mt-3 text-xs text-muted">
          No location yet. Paste the office&apos;s coordinates from a map (right-click the building in Google Maps and copy the numbers), or stand in the
          office and use this device&apos;s location.
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={id("lat")}>Latitude</Label>
          <Input id={id("lat")} inputMode="decimal" value={latitude} onChange={(e) => setLatitude(e.target.value)} onPaste={pastePair} placeholder="e.g. 12.971600" disabled={disabled} />
        </div>
        <div>
          <Label htmlFor={id("lng")}>Longitude</Label>
          <Input id={id("lng")} inputMode="decimal" value={longitude} onChange={(e) => setLongitude(e.target.value)} onPaste={pastePair} placeholder="e.g. 77.594600" disabled={disabled} />
        </div>
        <div>
          <Label htmlFor={id("radius")}>Allowed radius (metres)</Label>
          <Input id={id("radius")} type="number" min={RADIUS_LIMITS.min} max={RADIUS_LIMITS.max} step={1} value={radius} onChange={(e) => setRadius(e.target.value)} disabled={disabled} />
          <p className="mt-1 text-xs text-subtle">100 m suits most offices. A reading further than this from the point is outside.</p>
        </div>
        <div>
          <Label htmlFor={id("accuracy")}>Least accuracy accepted (metres)</Label>
          <Input id={id("accuracy")} type="number" min={ACCURACY_LIMITS.min} max={ACCURACY_LIMITS.max} step={1} value={accuracy} onChange={(e) => setAccuracy(e.target.value)} disabled={disabled} />
          <p className="mt-1 text-xs text-subtle">A phone less sure of where it is than this is asked to try again. It never widens the radius.</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => fillFromDevice()} disabled={disabled || locating}>
          <LocateFixed className="h-4 w-4" aria-hidden />
          {locating ? "Finding this device…" : "Use this device's location"}
        </Button>
        {mapLink && (
          <a href={mapLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-brand hover:underline">
            <MapPin className="h-4 w-4" aria-hidden /> Check on the map
          </a>
        )}
      </div>

      <div className="mt-4 space-y-3 border-t border-line pt-4">
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-sm font-medium text-text">Require GPS to clock in and out here</span>
            <span className="block text-xs text-muted">From the Deskzo app and the web. Off, clocking works as before and the distance is only noted.</span>
          </span>
          <Switch checked={enforced} onChange={setEnforced} disabled={disabled} label="Require GPS to clock in and out here" />
        </label>
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-sm font-medium text-text">Allow exceptions</span>
            <span className="block text-xs text-muted">
              Somebody refused can ask to clock in anyway, and an approver can allow it — once, for that day. Off, nobody here can clock in away from the office.
            </span>
          </span>
          <Switch checked={exceptions} onChange={setExceptions} disabled={disabled} label="Allow exceptions" />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" onClick={save} disabled={disabled || pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {message && (
          <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-muted" : "text-danger"}`}>
            {message.text}
          </p>
        )}
      </div>
    </Card>
  );
}
