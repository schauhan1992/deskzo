import { Monitor, Smartphone, Tablet } from "lucide-react";

/**
 * A session's device as a glyph, from the words the session list already carries ("Chrome on
 * iPhone"). Always decorative — the device's name is printed beside it. Server-safe.
 */
export function DeviceIcon({ device, className = "h-4 w-4" }: { device: string; className?: string }) {
  const Icon = /ipad|tablet/i.test(device) ? Tablet : /iphone|android|mobile|phone/i.test(device) ? Smartphone : Monitor;
  return <Icon aria-hidden="true" className={className} />;
}
