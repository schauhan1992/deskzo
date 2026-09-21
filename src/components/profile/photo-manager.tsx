"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Trash2 } from "lucide-react";
import { setProfilePhoto, removeProfilePhoto } from "@/actions/user-photo";
import { Avatar, type AvatarUser } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

/**
 * Choosing a profile photo.
 *
 * The preview updates before the upload finishes, because a file picker that appears to do nothing
 * for a second gets clicked again — and the second click uploads the same file twice.
 */
export function PhotoManager({ user }: { user: AvatarUser }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** Local data URL shown until the server confirms and the route takes over. */
  const [preview, setPreview] = useState<string | null>(null);

  function choose(file: File) {
    setError(null);

    // Checked here as well as on the server. The server check is the one that counts; this one
    // means a 4MB holiday photo fails instantly rather than after uploading all of it.
    if (file.size > 96 * 1024) {
      setError(`That image is ${Math.round(file.size / 1024)}KB — keep it under 96KB. Cropping it square usually does it.`);
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      setPreview(dataUrl);
      startTransition(async () => {
        const result = await setProfilePhoto(dataUrl);
        if (!result.ok) {
          setError(result.error);
          setPreview(null);
          return;
        }
        router.refresh();
      });
    };
    reader.onerror = () => setError("That file couldn't be read.");
    reader.readAsDataURL(file);
  }

  const shown: AvatarUser = preview
    ? // Forces the <img> branch while the local preview stands in for the stored photo.
      { ...user, photoUpdatedAt: new Date() }
    : user;

  return (
    <div className="flex items-start gap-4">
      <div className="relative">
        {preview ? (
          <span className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-full bg-brand-subtle">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="" className="h-full w-full object-cover" />
          </span>
        ) : (
          <Avatar user={shown} size="xl" />
        )}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isPending}
            onClick={() => fileRef.current?.click()}
          >
            <Camera className="h-3.5 w-3.5" />
            {user.photoUpdatedAt || preview ? "Change photo" : "Add a photo"}
          </Button>

          {(user.photoUpdatedAt || preview) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              className="text-danger hover:bg-danger-bg hover:text-danger"
              onClick={() => {
                setError(null);
                setPreview(null);
                startTransition(async () => {
                  const result = await removeProfilePhoto();
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  router.refresh();
                });
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove
            </Button>
          )}
        </div>

        <p className="max-w-sm text-xs text-subtle">
          PNG, JPEG, WebP or GIF, under 96KB. Square images look best — anything else is cropped to
          the circle. Without one you get your initials, which is a perfectly good answer.
        </p>

        {error && <p className="text-sm text-danger">{error}</p>}
        {isPending && <p className="text-xs text-muted">Saving…</p>}
      </div>

      <input
        ref={fileRef}
        type="file"
        // Matches the server's list. SVG is deliberately absent — see src/actions/user-photo.ts.
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) choose(file);
          // Cleared so picking the same file again after a failure still fires onChange.
          e.target.value = "";
        }}
      />
    </div>
  );
}
