/**
 * The web process check:cluster runs in deploy/start.mjs's cluster in place of `next start`: a small HTTP
 * server over the very modules that must agree across processes — the sign-in lockout, the throttle, a
 * shared cache clear, and the chat bus. Every answer says which process gave it.
 */
import http from "node:http";
import { shared } from "../src/lib/cluster/hub";
import { lockoutState, recordFailure } from "../src/lib/security/lockout";
import { throttle } from "../src/lib/security/throttle";
import { isListening, publishIn, subscribe } from "../src/lib/chat/bus";

let cleared = 0;
const clearTest = shared("check-cluster", () => {
  cleared += 1;
});

const TENANT = "zz-cluster";

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://probe");
  const q = (name: string) => url.searchParams.get(name) ?? "";
  const answer = (body: Record<string, unknown>) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Connection", "close");
    res.end(JSON.stringify({ pid: process.pid, ...body }));
  };
  switch (url.pathname) {
    case "/pid":
      return answer({});
    case "/fail":
      return answer({ state: recordFailure([q("key")]) });
    case "/locked":
      return answer({ state: lockoutState([q("key")]) });
    case "/throttle":
      return answer({ outcome: throttle(q("key"), 60_000) });
    case "/clear":
      clearTest();
      return answer({ cleared });
    case "/cleared":
      return answer({ cleared });
    case "/online":
      return answer({ online: isListening(TENANT, q("u")) });
    case "/publish":
      publishIn(TENANT, [q("u")], { type: "probe", text: q("text") } as never);
      return answer({});
    case "/listen": {
      res.writeHead(200, { "Content-Type": "text/event-stream", "X-Pid": String(process.pid) });
      res.write(`: ${process.pid}\n\n`);
      const stop = subscribe(TENANT, q("u"), (event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
      req.on("close", stop);
      return;
    }
    case "/exit": {
      // Only the process named: round robin decides which one takes the request.
      const mine = Number(q("pid")) === process.pid;
      answer({ exiting: mine });
      if (mine) setTimeout(() => process.exit(1), 50);
      return;
    }
    default:
      res.statusCode = 404;
      return answer({});
  }
});

server.listen(Number(process.env.PORT));
