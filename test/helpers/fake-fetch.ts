import { vi } from "vitest";

export interface RecordedCall {
  url: URL;
  init: RequestInit;
  method: string;
  headers: Headers;
}

export type FetchHandler = (call: RecordedCall, index: number) => Response | Promise<Response>;

/** A fetch stand-in that records every call and delegates the response to `handler`. */
export function fakeFetch(handler: FetchHandler) {
  const calls: RecordedCall[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: RecordedCall = {
      url: new URL(href),
      init: init ?? {},
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  });
  return Object.assign(fn, { calls });
}

export type FakeFetch = ReturnType<typeof fakeFetch>;

/** Casts the fake to the fetch type expected by production code. */
export function asFetch(fake: FakeFetch): typeof fetch {
  return fake as unknown as typeof fetch;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function octet(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, { status, headers: { "content-type": "application/octet-stream" } });
}

export function html(status = 203): Response {
  return new Response("<html><body>Sign in to Azure DevOps</body></html>", {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

export function fetchFailure(code: string, message = "fetch failed"): Error {
  const cause = Object.assign(new Error(`network layer: ${code}`), { code });
  return new TypeError(message, { cause });
}
