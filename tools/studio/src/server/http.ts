import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

/** Small HTTP helpers of the Studio server: token, host/origin checks, JSON bodies, static files. No framework. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const newToken = (): string => randomBytes(24).toString("base64url");

export function tokensEqual(given: string | null | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * DNS-rebinding guard: only requests addressed to the loopback name and the port we listen on are served, so a
 * page on `evil.example` whose DNS now points at 127.0.0.1 gets nothing (its Host header is its own name).
 */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Cross-origin guard for requests that change state: a browser sends `Origin`; absent means a non-browser client. */
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...headers });
  res.end(body);
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8" });
}

const MAX_BODY = 8 * 1024 * 1024;

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "content-type must be application/json");
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    const b = c as Buffer;
    n += b.length;
    if (n > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(b);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body is not a JSON object");
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

/** Serves `rel` (a URL path below the mount point) from `root`; anything that resolves outside `root` is a 404. */
export function serveStatic(res: ServerResponse, root: string, rel: string): void {
  const base = resolve(root);
  const target = resolve(base, `.${sep}${rel}`);
  if (!(target === base || target.startsWith(base + sep)) || !existsSync(target) || !statSync(target).isFile()) throw new HttpError(404, "not found");
  send(res, 200, readFileSync(target), { "Content-Type": MIME[extname(target)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
}
