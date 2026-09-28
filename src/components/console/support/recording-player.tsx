"use client";

/**
 * A support request's screen recording, played from the file route. The only client piece of the
 * attachment gallery (attachments.tsx), which is otherwise server-safe.
 *
 * Chrome writes WebM recordings without a duration, so with `preload="metadata"` the player shows no
 * length and can't seek until it has played to the end — the Range requests the file route answers
 * don't help while the browser thinks the file never ends. Asking for a far-off time makes it look at
 * the end of the file and learn the length; the first time update then puts it back at the start.
 * The same fix the workspace's own preview uses (src/components/support/recording-preview.tsx). A
 * recording that knows its length (Safari's MP4) is left alone.
 */
function learnDuration(event: React.SyntheticEvent<HTMLVideoElement>) {
  const video = event.currentTarget;
  if (video.duration !== Infinity) return;
  const rewind = () => {
    video.removeEventListener("timeupdate", rewind);
    video.currentTime = 0;
  };
  video.addEventListener("timeupdate", rewind);
  video.currentTime = Number.MAX_SAFE_INTEGER;
}

export function RecordingPlayer({ src, label }: { src: string; label: string }) {
  return (
    <video
      controls
      preload="metadata"
      playsInline
      src={src}
      aria-label={label}
      onLoadedMetadata={learnDuration}
      className="aspect-video w-full rounded-lg border border-line bg-surface-sunken"
    />
  );
}
