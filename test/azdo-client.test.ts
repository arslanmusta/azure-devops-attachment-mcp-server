import { describe, expect, it } from "vitest";
import { AzdoClient } from "../src/azdo-client.js";
import { AzdoError, type AzdoErrorKind } from "../src/errors.js";
import { asFetch, empty, fakeFetch, fetchFailure, html, json, octet } from "./helpers/fake-fetch.js";
import { HOST, workItem } from "./helpers/fixtures.js";

const PAT = "s3cret-pat-value-7c1e";
const cfg = { baseUrl: HOST, pat: PAT, apiVersion: "7.0" };
const GUID = "0f3c1d2e-1111-4222-8333-444455556666";

function client(fake: ReturnType<typeof fakeFetch>): AzdoClient {
  return new AzdoClient(cfg, asFetch(fake));
}

async function expectAzdoError(promise: Promise<unknown>, kind: AzdoErrorKind, status?: number): Promise<AzdoError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AzdoError);
  const azdo = err as AzdoError;
  expect(azdo.kind).toBe(kind);
  if (status !== undefined) expect(azdo.status).toBe(status);
  return azdo;
}

describe("AzdoClient requests", () => {
  it("GETs the work item at collection level with relations expanded, keeping the collection path prefix", async () => {
    const fake = fakeFetch(() => json(workItem({ id: 123, rev: 7 })));
    const wi = await client(fake).getWorkItem(123);

    expect(wi.id).toBe(123);
    expect(wi.rev).toBe(7);
    const call = fake.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url.href).toBe(`${HOST}/_apis/wit/workitems/123?$expand=relations&api-version=7.0`);
  });

  it("authenticates with Basic auth built from the PAT and suppresses sign-in redirects", async () => {
    const fake = fakeFetch(() => json(workItem()));
    await client(fake).getWorkItem(1);

    const { headers, init } = fake.calls[0]!;
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
    expect(headers.get("x-tfs-fedauthredirect")).toBe("Suppress");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("user-agent")).toMatch(/^azure-devops-attachment-mcp-server\/\d+\.\d+\.\d+/);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("honours a custom api-version", async () => {
    const fake = fakeFetch(() => json(workItem()));
    await new AzdoClient({ ...cfg, apiVersion: "6.0" }, asFetch(fake)).getWorkItem(1);
    expect(fake.calls[0]!.url.searchParams.get("api-version")).toBe("6.0");
  });

  it("PATCHes JSON Patch documents with the json-patch content type and returns the updated work item", async () => {
    const fake = fakeFetch(() => json(workItem({ rev: 8 })));
    const ops = [
      { op: "test" as const, path: "/rev", value: 7 },
      { op: "remove" as const, path: "/relations/2" },
    ];
    const wi = await client(fake).patchWorkItem(123, ops);

    expect(wi.rev).toBe(8);
    const call = fake.calls[0]!;
    expect(call.method).toBe("PATCH");
    expect(call.url.href).toBe(`${HOST}/_apis/wit/workitems/123?api-version=7.0`);
    expect(call.headers.get("content-type")).toBe("application/json-patch+json");
    expect(JSON.parse(call.init.body as string)).toEqual(ops);
  });

  it("uploads raw bytes to the project-scoped attachments endpoint with an encoded file name", async () => {
    const fake = fakeFetch(() => json({ id: GUID, url: `${HOST}/_apis/wit/attachments/${GUID}` }, 201));
    const data = Buffer.from("hello attachment");
    const ref = await client(fake).uploadAttachment({ project: "My Project", fileName: "ünïcode file.png", data });

    expect(ref).toEqual({ id: GUID, url: `${HOST}/_apis/wit/attachments/${GUID}` });
    const call = fake.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.href).toBe(
      `${HOST}/My%20Project/_apis/wit/attachments?fileName=%C3%BCn%C3%AFcode%20file.png&api-version=7.0`,
    );
    expect(call.headers.get("content-type")).toBe("application/octet-stream");
    expect(Buffer.from(call.init.body as Uint8Array).equals(data)).toBe(true);
  });

  it("uploads at collection level when no project is given", async () => {
    const fake = fakeFetch(() => json({ id: GUID, url: "x" }, 201));
    await client(fake).uploadAttachment({ fileName: "a.txt", data: Buffer.from("a") });
    expect(fake.calls[0]!.url.href).toBe(`${HOST}/_apis/wit/attachments?fileName=a.txt&api-version=7.0`);
  });

  it("downloads through a rebuilt project-scoped URL with download=true and returns the raw response", async () => {
    const fake = fakeFetch(() => octet(Buffer.from("PDF-bytes")));
    const res = await client(fake).downloadAttachment({ project: "Proj", id: GUID, fileName: "spec v2.pdf" });

    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("PDF-bytes");
    const call = fake.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url.href).toBe(
      `${HOST}/Proj/_apis/wit/attachments/${GUID}?fileName=spec%20v2.pdf&download=true&api-version=7.0`,
    );
    expect(call.headers.get("accept")).not.toBe("application/json");
  });

  it("maps download failures like any other request", async () => {
    const fake = fakeFetch(() => json({ message: "TF237082: The attachment does not exist" }, 404));
    const err = await expectAzdoError(
      client(fake).downloadAttachment({ id: GUID, fileName: "x.bin" }),
      "not_found",
      404,
    );
    expect(err.message).toContain("TF237082");
  });
});

describe("AzdoClient error mapping", () => {
  it.each<[number, AzdoErrorKind]>([
    [401, "auth"],
    [403, "forbidden"],
    [404, "not_found"],
    [400, "bad_request"],
    [409, "conflict"],
    [412, "conflict"],
    [413, "too_large"],
    [500, "server"],
    [503, "server"],
    [418, "unexpected_response"],
  ])("maps HTTP %s to %s and surfaces the server message", async (status, kind) => {
    const fake = fakeFetch(() => json({ message: "server says no", typeKey: "SomeException" }, status));
    const err = await expectAzdoError(client(fake).getWorkItem(1), kind, status);
    expect(err.message).toContain("server says no");
    expect(err.typeKey).toBe("SomeException");
  });

  it("tells the user to check the PAT on 401 without leaking its value", async () => {
    const fake = fakeFetch(() => empty(401));
    const err = await expectAzdoError(client(fake).getWorkItem(1), "auth", 401);
    expect(err.message).toMatch(/AZURE_DEVOPS_PAT/);
    expect(err.message).not.toContain(PAT);
  });

  it("treats a sign-in HTML page (HTTP 203) as an authentication failure", async () => {
    const fake = fakeFetch(() => html(203));
    const err = await expectAzdoError(client(fake).getWorkItem(1), "auth", 203);
    expect(err.message).toMatch(/sign-in/i);
    expect(err.message).toMatch(/AZURE_DEVOPS_URL/);
  });

  it("treats a redirect (not followed) as an authentication failure", async () => {
    const fake = fakeFetch(() => empty(302, { location: `${HOST}/_signin` }));
    await expectAzdoError(client(fake).getWorkItem(1), "auth", 302);
  });

  it("surfaces the TF error text on 404", async () => {
    const fake = fakeFetch(() =>
      json(
        {
          message: "TF401232: Work item 999 does not exist, or you do not have permissions to read it.",
          typeKey: "WorkItemNotFoundException",
        },
        404,
      ),
    );
    const err = await expectAzdoError(client(fake).getWorkItem(999), "not_found", 404);
    expect(err.message).toContain("TF401232");
    expect(err.typeKey).toBe("WorkItemNotFoundException");
  });

  it("uses the raw body when an error response is not JSON", async () => {
    const fake = fakeFetch(() => new Response("Bad Gateway from proxy", { status: 502, headers: { "content-type": "text/plain" } }));
    const err = await expectAzdoError(client(fake).getWorkItem(1), "server", 502);
    expect(err.message).toContain("Bad Gateway from proxy");
  });

  it("reports a non-JSON success body as an unexpected response", async () => {
    const fake = fakeFetch(() => new Response("oops", { status: 200, headers: { "content-type": "text/plain" } }));
    await expectAzdoError(client(fake).getWorkItem(1), "unexpected_response", 200);
  });

  it("maps TLS trust failures to a network error with the insecure-TLS hint", async () => {
    const fake = fakeFetch(() => {
      throw fetchFailure("SELF_SIGNED_CERT_IN_CHAIN");
    });
    const err = await expectAzdoError(client(fake).getWorkItem(1), "network");
    expect(err.message).toContain("SELF_SIGNED_CERT_IN_CHAIN");
    expect(err.message).toMatch(/AZURE_DEVOPS_ALLOW_INSECURE_TLS/);
    expect(err.message).toMatch(/NODE_EXTRA_CA_CERTS/);
  });

  it("maps connection failures to a network error that names the host and AZURE_DEVOPS_URL", async () => {
    const fake = fakeFetch(() => {
      throw fetchFailure("ECONNREFUSED");
    });
    const err = await expectAzdoError(client(fake).getWorkItem(1), "network");
    expect(err.message).toContain("tfs.company.local");
    expect(err.message).toMatch(/AZURE_DEVOPS_URL/);
  });

  it("maps aborted requests to a timeout error", async () => {
    const fake = fakeFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const err = await expectAzdoError(client(fake).getWorkItem(1), "timeout");
    expect(err.message).toMatch(/timed out/i);
  });
});
