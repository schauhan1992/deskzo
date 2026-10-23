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

  it("opens what the bell's notice links to — natively where the app has a screen, else the page", () => {
    expect(routeFor({ type: "notice", link: "/leads/LEAD-0042" })).toEqual({ kind: "open", pathname: "/lead/[ref]", params: { ref: "LEAD-0042" } });
    expect(routeFor({ type: "notice", link: "/companies/COM-0007?tab=contacts" })).toEqual({ kind: "open", pathname: "/company/[ref]", params: { ref: "COM-0007" } });
    expect(routeFor({ type: "notice", link: "/tasks?view=today" })).toEqual({ kind: "open", pathname: "/tasks" });
    expect(routeFor({ type: "notice", link: "/people/leave#requests" })).toEqual({ kind: "open", pathname: "/web", params: { path: "/people/leave#requests" } });
  });

  it("never leaves the workspace for a notice's link", () => {
    expect(routeFor({ type: "notice", link: "https://evil.example/" })).toEqual({ kind: "open", pathname: "/" });
    expect(routeFor({ type: "notice", link: "//evil.example/" })).toEqual({ kind: "open", pathname: "/" });
    expect(routeFor({ type: "notice" })).toEqual({ kind: "open", pathname: "/" });
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

  it("shows a ring and a notice", () => {
    expect(showWhileOpen({ type: "call" })).toBe(true);
    expect(showWhileOpen({ type: "notice", link: "/leads/LEAD-1" })).toBe(true);
    expect(showWhileOpen(null)).toBe(true);
  });
});
