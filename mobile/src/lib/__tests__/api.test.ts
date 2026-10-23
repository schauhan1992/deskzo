import { ApiError, NOT_ON_SERVER, request } from "@/lib/api";

// The session lives in the native side; these requests carry their own address.
jest.mock("@/lib/native", () => ({ calls: { getSession: () => null } }));

const WHERE = { baseUrl: "https://acme.deskzo.com", host: null, token: "dzp_x.y" };

function answer(status: number, body = "") {
  globalThis.fetch = jest.fn(async () => new Response(body, { status })) as typeof fetch;
}

async function failure(): Promise<ApiError> {
  try {
    await request(WHERE, "GET", "/api/app/calls/directory");
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("it answered");
}

describe("request — what a refusal means", () => {
  it("reads a bare 404 or 405 as a Deskzo older than the app", async () => {
    for (const status of [404, 405]) {
      answer(status, "<html>Not here</html>");
      expect(await failure()).toMatchObject({ status, code: "not_on_server", message: NOT_ON_SERVER });
    }
  });

  it("keeps Deskzo's own words when it gives them", async () => {
    answer(405, JSON.stringify({ error: { code: "calls_off", message: "Calling isn't on for this phone." } }));
    expect(await failure()).toMatchObject({ status: 405, code: "calls_off", message: "Calling isn't on for this phone." });
  });

  it("says anything else went wrong, by its status", async () => {
    answer(502);
    expect(await failure()).toMatchObject({ status: 502, code: "http_502" });
  });
});
