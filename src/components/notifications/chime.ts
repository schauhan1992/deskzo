"use client";

/**
 * The reminder chime (owner, 8 Oct 2026): two soft notes, made by the browser's own Web Audio — no
 * sound file to load. A browser lets a page make sound only after somebody has clicked or typed on it,
 * so the audio is opened on the first such gesture (`listenForFirstGesture`); until then a reminder
 * arrives silently, as it always has.
 */

let context: AudioContext | null = null;

function open(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  context ??= new Ctor();
  if (context.state === "suspended") void context.resume().catch(() => {});
  return context;
}

/** Opens the audio on the page's first click or key press. Returns the cleanup. */
export function listenForFirstGesture(): () => void {
  const unlock = () => {
    open();
    remove();
  };
  const remove = () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  return remove;
}

/** Two notes, a fifth apart, gently in and out. Silent — and false — before the audio may play. */
export function playChime(): boolean {
  const ctx = open();
  if (!ctx || ctx.state !== "running") return false;
  const start = ctx.currentTime + 0.02;
  [880, 1318.5].forEach((frequency, i) => {
    const at = start + i * 0.18;
    const tone = ctx.createOscillator();
    const level = ctx.createGain();
    tone.type = "sine";
    tone.frequency.value = frequency;
    level.gain.setValueAtTime(0, at);
    level.gain.linearRampToValueAtTime(0.16, at + 0.02);
    level.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
    tone.connect(level).connect(ctx.destination);
    tone.start(at);
    tone.stop(at + 0.5);
  });
  return true;
}
