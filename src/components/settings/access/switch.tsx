"use client";

/**
 * An on/off switch for the access screens — the module toggle's markup (src/components/settings/
 * module-toggle.tsx), small, and named for whoever reads it with a screen reader.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-brand" : "bg-line-strong"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}
