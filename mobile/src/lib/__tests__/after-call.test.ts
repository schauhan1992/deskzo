import { ASK_WITHIN_MS, cameBack, due, forget, peek, setStore, started, wentAway, type PendingCall } from "@/lib/after-call";

/** The iOS side keeps the call in the Keychain; here, in a variable — what survives the app being closed. */
function memoryStore(initial: PendingCall | null = null) {
  let kept = initial;
  const saves: (PendingCall | null)[] = [];
  setStore({ load: () => kept, save: (call) => void saves.push((kept = call)) });
  return { saves, kept: () => kept };
}

const T0 = 1_790_000_000_000;

describe("the after-call sheet's timing", () => {
  beforeEach(() => {
    memoryStore();
  });

  it("asks once the phone has gone to the call and the person is back — once", () => {
    started({ number: "+91 98765 43210", label: "Ravi Kumar, Acme", via: "callback" }, T0);
    wentAway();
    const call = cameBack(T0 + 95_000);
    expect(call).toMatchObject({ number: "+91 98765 43210", label: "Ravi Kumar, Acme", via: "callback", away: true, startedAt: T0 });
    expect(cameBack(T0 + 96_000)).toBeNull();
    expect(peek()).toBeNull();
  });

  it("doesn't ask when iOS's \"Call …?\" was cancelled — and forgets the call", () => {
    started({ number: "98765 43210", via: "page" }, T0);
    // The question makes the app inactive, not gone; cancelled, it is back without having left.
    expect(cameBack(T0 + 3_000)).toBeNull();
    expect(peek()).toBeNull();
    // A later trip to the home screen isn't taken for it.
    wentAway();
    expect(cameBack(T0 + 60_000)).toBeNull();
  });

  it("doesn't ask about a call from hours ago", () => {
    started({ number: "98765 43210", via: "ring", request: "ckring" }, T0);
    wentAway();
    expect(cameBack(T0 + ASK_WITHIN_MS + 1)).toBeNull();
    expect(peek()).toBeNull();
  });

  it("asks about the latest of two calls", () => {
    started({ number: "98765 43210", via: "callback" }, T0);
    started({ number: "91234 56789", label: "Priya, Beta", via: "ring", request: "ckring2" }, T0 + 10_000);
    wentAway();
    expect(cameBack(T0 + 70_000)).toMatchObject({ number: "91234 56789", request: "ckring2" });
  });

  it("asks after the app was closed during the call — the call was kept", () => {
    const store = memoryStore();
    started({ number: "98765 43210", via: "callback" }, T0);
    wentAway();
    expect(store.kept()).toMatchObject({ number: "98765 43210", away: true });
    // Opened again: a fresh start reads what was kept.
    memoryStore(store.kept());
    expect(cameBack(T0 + 600_000)).toMatchObject({ number: "98765 43210" });
  });

  it("forgets on signing out", () => {
    started({ number: "98765 43210", via: "callback" }, T0);
    wentAway();
    forget();
    expect(cameBack(T0 + 60_000)).toBeNull();
  });

  it("is due only after leaving, and within the window", () => {
    const call: PendingCall = { number: "1", label: null, startedAt: T0, via: "list", request: null, away: false };
    expect(due(call, T0 + 1000)).toBe(false);
    expect(due({ ...call, away: true }, T0 + 1000)).toBe(true);
    expect(due({ ...call, away: true }, T0 - 1000)).toBe(false);
    expect(due({ ...call, away: true }, T0 + ASK_WITHIN_MS)).toBe(false);
    expect(due(null)).toBe(false);
  });
});
