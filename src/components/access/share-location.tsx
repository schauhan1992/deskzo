"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";
import { shareLocation } from "@/actions/access-gate";
import { Button } from "@/components/ui/button";

/**
 * Asks the browser where it is, once, and sends it.
 *
 * High accuracy, because a sign-in location a kilometre out is not much of a record — and no cached
 * position, because "where you were an hour ago" is not the question. The browser does the asking;
 * this only explains, beforehand, why it is about to.
 */
export function ShareLocation({ next }: { next: string }) {
  const [state, setState] = useState<"idle" | "asking" | "sending">("idle");
  const [error, setError] = useState<string | null>(null);

  const share = () => {
    setError(null);
    if (!("geolocation" in navigator)) {
      setError("This browser can't share a location. Use another browser, or ask your administrator.");
      return;
    }
    setState("asking");
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        setState("sending");
        const result = await shareLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
        });
        if (!result.ok) {
          setState("idle");
          setError(result.error);
          return;
        }
        // A full load rather than a client navigation, so the gate is asked again from the top.
        window.location.assign(next);
      },
      (failure) => {
        setState("idle");
        setError(
          failure.code === failure.PERMISSION_DENIED
            ? "Location is blocked for this site. Allow it from the icon beside the address bar, then try again."
            : failure.code === failure.TIMEOUT
              ? "It took too long to find your location. Try again — near a window helps."
              : "Your device couldn't work out where it is. Check that location is switched on.",
        );
      },
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  };

  return (
    <div className="space-y-2">
      <Button className="w-full" onClick={share} disabled={state !== "idle"}>
        <MapPin className="h-4 w-4" />
        {state === "asking" ? "Waiting for your browser…" : state === "sending" ? "Recording…" : "Share my location"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
