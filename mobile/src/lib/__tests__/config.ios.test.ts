jest.mock("expo-constants", () => ({ __esModule: true, default: { expoConfig: { version: "0.3.0", extra: { dev: true } } } }));

import { webOrigin, workspaceAddress } from "@/lib/config";

/** A development build on the iOS Simulator (jest-expo runs as iOS): this Mac's Deskzo, as Apple's networking reaches it. */
describe("a development build on the iOS Simulator", () => {
  it("talks to the Mac at 127.0.0.1, naming the workspace", () => {
    expect(workspaceAddress("deskzo.localhost:3000")).toEqual({ baseUrl: "http://127.0.0.1:3000", host: "deskzo.localhost:3000" });
  });

  it("opens the pages at localhost — the Mac's first workspace", () => {
    expect(webOrigin({ baseUrl: "http://127.0.0.1:3000", host: "deskzo.localhost:3000" })).toBe("http://localhost:3000");
  });

  it("still talks HTTPS to a real workspace", () => {
    expect(workspaceAddress("acme")).toEqual({ baseUrl: "https://acme.deskzo.com", host: null });
    expect(webOrigin({ baseUrl: "https://acme.deskzo.com", host: null })).toBe("https://acme.deskzo.com");
  });
});
