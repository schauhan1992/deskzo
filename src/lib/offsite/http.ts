import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";

/**
 * One HTTP request to the off-site store, with node:http rather than fetch.
 *
 * Because of uploads. Azure's Put Blob and S3's PutObject both need a Content-Length, and fetch sends a
 * streamed body chunked, without one, which both refuse. A backup can be gigabytes, so it can't be read
 * into memory to give fetch a length. node:http lets the length be stated and the file streamed under it.
 *
 * The answer is read whole (lists, errors and small objects), or streamed to a file (`toFile`). A timeout
 * is for the socket going quiet, not the whole request, so a slow upload of a large file isn't cut off
 * while bytes are still moving.
 */

export type Body = Buffer | { file: string; size: number } | null;

export type Answer = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

const IDLE_MS = 120_000;

export function request(method: string, url: URL, headers: Record<string, string>, body: Body = null, toFile?: string): Promise<Answer> {
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!transport) return Promise.reject(new Error(`Not an http(s) address: ${url.protocol}`));

  const length = body === null ? 0 : Buffer.isBuffer(body) ? body.length : body.size;
  const sent: Record<string, string> = { ...headers };
  if (method === "PUT" || method === "POST" || length > 0) sent["content-length"] = String(length);

  return new Promise<Answer>((resolve, reject) => {
    const req = transport.request(url, { method, headers: sent }, (res) => {
      const status = res.statusCode ?? 0;
      if (toFile && status >= 200 && status < 300) {
        const temp = `${toFile}.${process.pid}.part`;
        pipeline(res, createWriteStream(temp))
          .then(() => rename(temp, toFile))
          .then(() => resolve({ status, headers: res.headers, body: Buffer.alloc(0) }))
          .catch(async (err: unknown) => {
            await rm(temp, { force: true }).catch(() => {});
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        return;
      }
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(parts) }));
      res.on("error", reject);
    });
    req.setTimeout(IDLE_MS, () => req.destroy(new Error(`${url.host} stopped answering`)));
    req.on("error", reject);

    if (body === null || Buffer.isBuffer(body)) {
      req.end(body ?? undefined);
    } else {
      pipeline(createReadStream(body.file), req).catch((err: unknown) => req.destroy(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

/** The text of an error answer, for the message: the store's own words, trimmed. */
export function answerText(answer: Answer): string {
  const text = answer.body.toString("utf8");
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
  const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
  if (code || message) return [code, message?.split("\n")[0]].filter(Boolean).join(": ");
  return text.trim().slice(0, 200) || `HTTP ${answer.status}`;
}

/** The few entities XML lists escape keys with. */
export function unescapeXml(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e] ?? "");
}

/** Every `<tag>…</tag>` in a piece of XML, in order. Enough for the list answers of S3 and Azure, which are flat. */
export function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
  return out;
}

export function xmlOne(xml: string, tag: string): string | null {
  return xmlAll(xml, tag)[0] ?? null;
}
