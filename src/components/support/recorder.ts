"use client";

import { LIMITS, type ClientContext, type ConsoleEntry, type PerfSnapshot } from "@/lib/support/types";

/**
 * Contact Support's screen recorder, and the two things gathered alongside a recording: the
 * browser's console messages and the page's load timings. The consent dialog lists exactly these
 * (src/components/support/recording-consent.tsx), so nothing here collects more than it says.
 *
 * Browser-only, but nothing runs at import: every export touches `window`, `navigator` or
 * `MediaRecorder` only when it is called, so the dialog that imports this still renders on the
 * server (and in the render smoke) without a browser.
 */

/** The first of these the browser can write is used; the upload route accepts WebM and MP4 only. */
const MIME_CANDIDATES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
/** About 7.5 MB a minute: a readable screen, and five minutes well inside the 80 MB cap. */
const VIDEO_BITS_PER_SECOND = 1_000_000;
/** A chunk a second, so a crash or a stop loses at most a second. */
const TIMESLICE_MS = 1000;
const TICK_MS = 250;
/** Stops a little short of the upload cap, for a browser that ignores the bit rate it was given. */
const SIZE_STOP_BYTES = LIMITS.recordingBytes - 2 * 1024 * 1024;
/** When the one-minute warning is due. */
export const RECORDING_WARNING_MS = LIMITS.recordingMs - 60_000;

// ─── What the browser can do ─────────────────────────────────────────────────────────────────────

/**
 * Whether this browser can record the screen at all. Phones, older Safari and some embedded browsers
 * have no `getDisplayMedia`; the Record button is then disabled and says so.
 */
export function canRecordScreen(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return typeof navigator.mediaDevices?.getDisplayMedia === "function" && typeof window.MediaRecorder === "function";
}

function pickMimeType(): string | null {
  const supported = typeof MediaRecorder.isTypeSupported === "function" ? MediaRecorder.isTypeSupported.bind(MediaRecorder) : null;
  if (!supported) return null;
  return MIME_CANDIDATES.find((type) => supported(type)) ?? null;
}

// ─── What the browser says about itself ──────────────────────────────────────────────────────────

/**
 * The details every request carries, and the dialog discloses: the page (its path only — a query can
 * hold a search or a token, and the hash is nobody's business), the browser, the screen and window
 * sizes, the time zone and the language. The server caps each one again.
 */
export function clientContext(): ClientContext {
  const context: ClientContext = {};
  try {
    context.page = window.location.pathname.slice(0, 300);
    context.userAgent = navigator.userAgent.slice(0, 400);
    const ratio = Math.round((window.devicePixelRatio || 1) * 100) / 100;
    context.screen = `${window.screen.width}×${window.screen.height}@${ratio}x`;
    context.viewport = `${window.innerWidth}×${window.innerHeight}`;
    context.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.slice(0, 64);
    context.language = navigator.language?.slice(0, 20);
  } catch {
    // Whatever was read before a browser refused the rest is still worth sending.
  }
  return context;
}

/**
 * How long the page took to load, from the navigation entry — the first load of the app in this
 * tab, since moving between pages afterwards doesn't reload it. Whole milliseconds; a figure the
 * browser can't give is left out. Sent only with a consented recording.
 */
export function perfSnapshot(): PerfSnapshot | undefined {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (!nav) return undefined;
    const out: PerfSnapshot = {};
    const put = (key: keyof PerfSnapshot, value: number) => {
      if (Number.isFinite(value) && value >= 0) out[key] = Math.round(value);
    };
    put("dns", nav.domainLookupEnd - nav.domainLookupStart);
    put("tcp", nav.connectEnd - nav.connectStart);
    put("ttfb", nav.responseStart - nav.requestStart);
    // Measured from the start of the navigation; zero means it hasn't happened, not that it was instant.
    if (nav.domContentLoadedEventEnd > 0) put("domContentLoaded", nav.domContentLoadedEventEnd);
    if (nav.loadEventEnd > 0) put("load", nav.loadEventEnd);
    put("transferSize", nav.transferSize);
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

// ─── Console capture ─────────────────────────────────────────────────────────────────────────────

/** Past this many keys an object is cut short: a message is 500 characters, not a heap dump. */
const DESCRIBE_KEY_BUDGET = 200;

/** Anything, as text, without ever throwing — cycles, getters that throw and BigInts included. */
function describe(value: unknown): string {
  try {
    if (typeof value === "string") return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
    if (typeof value === "bigint") return `${value}n`;
    if (value === null || typeof value !== "object") return String(value);
    const seen = new WeakSet<object>();
    let keys = 0;
    const text = JSON.stringify(value, (_key, v: unknown) => {
      keys += 1;
      if (keys > DESCRIBE_KEY_BUDGET) return undefined;
      if (typeof v === "bigint") return `${v}n`;
      if (v instanceof Error) return `${v.name}: ${v.message}`;
      if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
    return text ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unprintable]";
    }
  }
}

/**
 * `console.error("Failed %s: %o", what, err)` reads the way the browser prints it. Only the common
 * directives; `%c` takes a style argument and prints nothing, as it does in the console.
 */
function describeArgs(args: unknown[]): string {
  const rest = [...args];
  let head = "";
  if (typeof rest[0] === "string" && /%[sdifoOc]/.test(rest[0])) {
    const format = rest.shift() as string;
    head = format.replace(/%([sdifoOc%])/g, (match, directive: string) => {
      if (directive === "%") return "%";
      if (!rest.length) return match;
      const arg = rest.shift();
      if (directive === "c") return "";
      if (directive === "d" || directive === "i") return String(Number.parseInt(String(arg), 10));
      if (directive === "f") return String(Number(arg));
      return describe(arg);
    });
  }
  return [head, ...rest.map(describe)].filter((part) => part !== "").join(" ");
}

/** At most 500 characters, counted as the server counts them (code points), never cutting one in half. */
function clip(text: string): string {
  const rough = text.slice(0, LIMITS.consoleEntryChars * 2);
  const points = [...rough];
  return points.length > LIMITS.consoleEntryChars ? points.slice(0, LIMITS.consoleEntryChars).join("") : rough;
}

/** A page path without its query or hash: a script's address can carry a token. */
function bareUrl(url: string): string {
  return url.split(/[?#]/)[0] ?? "";
}

export type ConsoleCapture = {
  /** Stops listening, puts the console back and returns what was caught (at most 200 entries). */
  stop(): ConsoleEntry[];
};

/**
 * Catches errors and warnings while a recording runs, and only then: `console.error`,
 * `console.warn`, uncaught errors and unhandled rejections. Logging still reaches the real console.
 *
 * The originals go back on stop, in a `finally`, so a throw on the way out can't leave the console
 * wrapped. If something else wrapped the console after we did, ours is left in place but inert —
 * pulling it out from under theirs would silently drop their wrapper instead.
 */
export function captureConsole(): ConsoleCapture {
  const entries: ConsoleEntry[] = [];
  let active = true;
  const push = (level: ConsoleEntry["level"], message: string) => {
    if (!active || entries.length >= LIMITS.consoleEntries) return;
    const text = clip(message.trim());
    if (text) entries.push({ at: new Date().toISOString(), level, message: text });
  };

  const originalError = console.error;
  const originalWarn = console.warn;
  const wrappedError = (...args: unknown[]) => {
    try {
      push("error", describeArgs(args));
    } catch {
      // Capture must never be the reason a log line goes missing.
    }
    return originalError.apply(console, args);
  };
  const wrappedWarn = (...args: unknown[]) => {
    try {
      push("warn", describeArgs(args));
    } catch {
      // As above.
    }
    return originalWarn.apply(console, args);
  };
  const onError = (event: ErrorEvent) => {
    try {
      const where = event.filename ? ` (${bareUrl(event.filename)}:${event.lineno}:${event.colno})` : "";
      push("error", `${event.message || describe(event.error)}${where}`);
    } catch {
      // As above.
    }
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    try {
      push("error", `Unhandled promise rejection: ${describe(event.reason)}`);
    } catch {
      // As above.
    }
  };

  console.error = wrappedError;
  console.warn = wrappedWarn;
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return {
    stop() {
      active = false;
      try {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
      } finally {
        if (console.error === wrappedError) console.error = originalError;
        if (console.warn === wrappedWarn) console.warn = originalWarn;
      }
      return entries.slice();
    },
  };
}

// ─── Recording ───────────────────────────────────────────────────────────────────────────────────

/** Why a recording ended: the Stop button, the five-minute limit, the browser's own "Stop sharing", or the size cap. */
export type StopReason = "user" | "limit" | "ended" | "size";

export type RecordingResult = {
  blob: Blob;
  /** "video/webm" or "video/mp4", without codecs. */
  mime: string;
  /** Recorded time, pauses left out, at most five minutes. */
  durationMs: number;
  consoleLog: ConsoleEntry[];
  perf?: PerfSnapshot;
  reason: StopReason;
};

export type ScreenRecorder = {
  readonly hasMicrophone: boolean;
  readonly canPause: boolean;
  pause(): boolean;
  resume(): boolean;
  setMuted(muted: boolean): void;
  /** Stops and hands the recording to `onStop`. */
  stop(): void;
  /** Stops and throws it away: `onStop` isn't called. For leaving the page mid-recording. */
  cancel(): void;
};

export type StartOutcome =
  | { ok: true; recorder: ScreenRecorder; microphoneRefused: boolean }
  /** `cancelled`: the person closed the picker or said no — not an error, and not reported as one. */
  | { ok: false; reason: "cancelled" | "failed" };

/**
 * Asks the browser to share a window, tab or screen, and records it.
 *
 * Call this straight from a click: `getDisplayMedia` needs the click's user activation, so nothing
 * may be awaited before it. The microphone is asked for afterwards, only when wanted; refusing it
 * records the screen without sound rather than not at all.
 *
 * `onTick` gets the recorded time four times a second; `onStop` gets the recording once, or null
 * when nothing was captured. It stops itself at five minutes, when the shared screen ends (the
 * browser's own "Stop sharing"), and a little short of the upload cap. Every track is stopped once
 * it has stopped.
 */
export async function startScreenRecording(options: {
  microphone: boolean;
  onTick: (elapsedMs: number) => void;
  onStop: (result: RecordingResult | null) => void;
}): Promise<StartOutcome> {
  let display: MediaStream;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 24 } }, audio: false });
  } catch (err) {
    const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
    return { ok: false, reason: name === "NotAllowedError" || name === "AbortError" ? "cancelled" : "failed" };
  }

  let mic: MediaStream | null = null;
  let microphoneRefused = false;
  if (options.microphone) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      microphoneRefused = true;
    }
  }

  const tracks = [...display.getTracks(), ...(mic?.getTracks() ?? [])];
  const screenTrack = display.getVideoTracks()[0];
  const stopTracks = () => {
    screenTrack?.removeEventListener("ended", onEnded);
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
        // Already stopped.
      }
    }
  };

  let recorder: MediaRecorder;
  const mimeType = pickMimeType();
  try {
    const stream = new MediaStream([...display.getVideoTracks(), ...(mic?.getAudioTracks() ?? [])]);
    recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
  } catch {
    stopTracks();
    return { ok: false, reason: "failed" };
  }

  const chunks: Blob[] = [];
  let bytes = 0;
  let reason: StopReason = "user";
  let finished = false;
  let delivered = false;
  let discarded = false;
  let consoleLog: ConsoleEntry[] = [];
  let durationMs = 0;

  // Recorded time, not wall time: a pause stops the clock, as it stops the video.
  let activeMs = 0;
  let runningSince = performance.now();
  let paused = false;
  const elapsed = () => activeMs + (paused ? 0 : performance.now() - runningSince);

  const capture = captureConsole();
  let timer = 0;
  let fallback = 0;

  function deliver() {
    if (delivered) return;
    delivered = true;
    window.clearTimeout(fallback);
    if (discarded) return;
    if (!chunks.length || durationMs <= 0) {
      options.onStop(null);
      return;
    }
    const mime = (recorder.mimeType || mimeType || "video/webm").split(";")[0]!.trim() || "video/webm";
    options.onStop({ blob: new Blob(chunks, { type: mime }), mime, durationMs, consoleLog, perf: perfSnapshot(), reason });
  }

  function finish(why: StopReason) {
    if (finished) return;
    finished = true;
    reason = why;
    durationMs = Math.min(Math.round(elapsed()), LIMITS.recordingMs);
    window.clearInterval(timer);
    consoleLog = capture.stop();
    if (recorder.state === "inactive") {
      stopTracks();
      deliver();
      return;
    }
    try {
      // The last chunk and then `stop` follow; the tracks are stopped there, once the data is out.
      recorder.stop();
      fallback = window.setTimeout(() => {
        stopTracks();
        deliver();
      }, 5000);
    } catch {
      stopTracks();
      deliver();
    }
  }

  function onEnded() {
    finish("ended");
  }

  recorder.ondataavailable = (event: BlobEvent) => {
    if (discarded || !event.data || event.data.size === 0) return;
    chunks.push(event.data);
    bytes += event.data.size;
    if (bytes >= SIZE_STOP_BYTES) finish("size");
    // Checked here as well as on the timer: a background tab's timers are throttled, the media
    // pipeline's chunks are not, so the five-minute stop holds even when nobody is looking at us.
    else if (elapsed() >= LIMITS.recordingMs) finish("limit");
  };
  recorder.onstop = () => {
    // Stopped on its own — every track it was recording ended.
    if (!finished) finish("ended");
    stopTracks();
    deliver();
  };
  screenTrack?.addEventListener("ended", onEnded);

  try {
    recorder.start(TIMESLICE_MS);
  } catch {
    capture.stop();
    stopTracks();
    return { ok: false, reason: "failed" };
  }
  runningSince = performance.now();
  timer = window.setInterval(() => {
    const ms = elapsed();
    options.onTick(Math.min(ms, LIMITS.recordingMs));
    if (ms >= LIMITS.recordingMs) finish("limit");
  }, TICK_MS);

  const audio = mic?.getAudioTracks() ?? [];
  return {
    ok: true,
    microphoneRefused,
    recorder: {
      hasMicrophone: audio.length > 0,
      canPause: typeof recorder.pause === "function" && typeof recorder.resume === "function",
      pause() {
        if (finished || paused || recorder.state !== "recording") return false;
        try {
          recorder.pause();
        } catch {
          return false;
        }
        activeMs += performance.now() - runningSince;
        paused = true;
        return true;
      },
      resume() {
        if (finished || !paused) return false;
        try {
          recorder.resume();
        } catch {
          return false;
        }
        runningSince = performance.now();
        paused = false;
        return true;
      },
      setMuted(muted: boolean) {
        for (const track of audio) track.enabled = !muted;
      },
      stop() {
        finish("user");
      },
      cancel() {
        discarded = true;
        finish("user");
        stopTracks();
      },
    },
  };
}

/** 83000 → "01:23". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
