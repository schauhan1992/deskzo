import { CALL_ACTION, TAP, routeFor, showWhileOpen } from "@/lib/push-routing";

describe("routeFor — where a notification takes the person", () => {
  const ring = { type: "call", request: "ckring123", number: "+91 98765 43210", label: "Ravi Kumar, Acme" };

  it("dials a ring from its Call button", () => {
    expect(routeFor(ring, CALL_ACTION)).toEqual({ kind: "dial", number: "+91 98765 43210", label: "Ravi Kumar, Acme", request: "ckring123" });
  });

  it("opens Calls with the ring on top from a tap", () => {
    expect(routeFor(ring, TAP)).toEqual({ kind: "open", pathname: "/calls", params: { ring: "ckring123", number: "+91 98765 43210", label: "Ravi Kumar, Acme" } });
    expect(routeFor(ring)).toEqual(routeFor(ring, TAP));
  });

  it("opens Calls, and dials nothing, for a ring without a number it can dial", () => {
    expect(routeFor({ type: "call", request: "x", number: "javascript:alert(1)" }, CALL_ACTION)).toEqual({ kind: "open", pathname: "/calls" });
    expect(routeFor({ type: "call", request: "x" }, CALL_ACTION)).toEqual({ kind: "open", pathname: "/calls" });
  });

  it("takes only an id Deskzo would make — never a path", () => {
    expect(routeFor({ ...ring, request: "../../etc" }, CALL_ACTION)).toMatchObject({ kind: "dial", request: null });
    expect(routeFor({ type: "chat", chat: "ck_chat-1" })).toEqual({ kind: "open", pathname: "/conversation/[id]", params: { id: "ck_chat-1" } });
    expect(routeFor({ type: "chat", chat: "/settings" })).toEqual({ kind: "open", pathname: "/chat" });
    expect(routeFor({ type: "chat" })).toEqual({ kind: "open", pathname: "/chat" });
  });

  it("opens Approvals for something waiting for a decision", () => {
    expect(routeFor({ type: "approval" })).toEqual({ kind: "open", pathname: "/approvals" });
  });

  it("opens the after-call sheet from the app's own reminder", () => {
    expect(routeFor({ type: "after-call", number: "98765 43210", label: "Ravi Kumar, Acme", at: 1_790_000_000_000 })).toEqual({
      kind: "open",
      pathname: "/after-call",
      params: { number: "98765 43210", at: "1790000000000", label: "Ravi Kumar, Acme" },
    });
    expect(routeFor({ type: "after-call", number: "98765 43210", label: "", at: 1_790_000_000_000 })).toEqual({ kind: "open", pathname: "/after-call", params: { number: "98765 43210", at: "1790000000000" } });
    expect(routeFor({ type: "after-call", number: "98765 43210" })).toBeNull();
  });

  it("does nothing for what it doesn't know", () => {
    expect(routeFor({ type: "something-new" })).toBeNull();
    expect(routeFor({})).toBeNull();
    expect(routeFor(null)).toBeNull();
    expect(routeFor(undefined)).toBeNull();
  });
});

describe("showWhileOpen", () => {
  it("leaves chat to the app's own banner, and the after-call reminder to its sheet", () => {
    expect(showWhileOpen({ type: "chat", chat: "c" })).toBe(false);
    expect(showWhileOpen({ type: "after-call" })).toBe(false);
  });

  it("shows a ring and an approval", () => {
    expect(showWhileOpen({ type: "call" })).toBe(true);
    expect(showWhileOpen({ type: "approval" })).toBe(true);
    expect(showWhileOpen(null)).toBe(true);
  });
});
