import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEntitled } from "@/lib/modules-access";
import { requestHost } from "@/lib/tenancy/host";

/**
 * The checks every marketing upload route makes before it reads a byte.
 *
 * Uploads come through route handlers rather than server actions because a template .zip can be
 * several megabytes and actions stop at one. A server action compares the request's Origin with its
 * Host for free; a route handler has to do it itself, or a page on another site could post a file
 * here with the signed-in person's cookie.
 */
export async function checkUploadRequest(request: Request, maxBytes: number): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  const origin = request.headers.get("origin");
  // The real host of this request (see src/lib/tenancy/host.ts) — a forwarded one is only a claim.
  const checked = requestHost(request.headers);
  const host = typeof checked === "string" ? checked : null;
  let sameOrigin = false;
  try {
    sameOrigin = !!origin && !!host && new URL(origin).host === host;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return { ok: false, status: 403, error: "Uploads are only accepted from this app." };

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > maxBytes) return { ok: false, status: 413, error: `That's over ${Math.round(maxBytes / 1024 / 1024)} MB.` };

  const user = await requireUser();
  if (!(await isModuleEntitled("marketing"))) return { ok: false, status: 403, error: "Marketing isn't part of this workspace's plan." };
  if (!(await can(user.id, "marketing.manage"))) return { ok: false, status: 403, error: "You can't upload marketing templates or lists." };
  return { ok: true, userId: user.id };
}
