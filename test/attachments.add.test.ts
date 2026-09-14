import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AzdoError, ToolInputError } from "../src/errors.js";
import { fakeFetch, json, type RecordedCall } from "./helpers/fake-fetch.js";
import { HOST, workItem } from "./helpers/fixtures.js";
import { GUID_A, service } from "./helpers/service.js";

const UPLOAD_URL = `${HOST}/_apis/wit/attachments/${GUID_A}`;

interface Routes {
  get?: (n: number) => Response;
  post?: (n: number) => Response;
  patch?: (n: number) => Response;
}

/** Method-routed fake server with per-method call counters. */
function server(routes: Routes = {}) {
  const counts = { GET: 0, POST: 0, PATCH: 0 };
  return fakeFetch((call: RecordedCall) => {
    const method = call.method as keyof typeof counts;
    const n = counts[method]++;
    if (method === "GET") return (routes.get ?? (() => json(workItem({ id: 123, rev: 7, project: "Proj" }))))(n);
    if (method === "POST") return (routes.post ?? (() => json({ id: GUID_A, url: UPLOAD_URL }, 201)))(n);
    if (method === "PATCH") return (routes.patch ?? (() => json(workItem({ id: 123, rev: 8 }))))(n);
    throw new Error(`unexpected ${call.method} ${call.url.href}`);
  });
}

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "azdo-add-"));
  file = path.join(dir, "spec.pdf");
  await writeFile(file, "PDF-bytes");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("AttachmentService.addAttachment", () => {
  it("uploads the file, links it with a rev-guarded JSON Patch and reports the new revision", async () => {
    const fake = server();
    const result = await service(fake).addAttachment({ workItemId: 123, filePath: file, comment: "design v2" });

    expect(result).toEqual({
      workItemId: 123,
      workItemRev: 8,
      attachment: { id: GUID_A, name: "spec.pdf", size: 9, url: UPLOAD_URL, comment: "design v2" },
    });

    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "POST", "PATCH"]);
    const [, upload, patch] = fake.calls as [RecordedCall, RecordedCall, RecordedCall];
    expect(upload.url.href).toBe(`${HOST}/Proj/_apis/wit/attachments?fileName=spec.pdf&api-version=7.0`);
    expect(Buffer.from(upload.init.body as Uint8Array).toString()).toBe("PDF-bytes");
    expect(JSON.parse(patch.init.body as string)).toEqual([
      { op: "test", path: "/rev", value: 7 },
      {
        op: "add",
        path: "/relations/-",
        value: { rel: "AttachedFile", url: UPLOAD_URL, attributes: { comment: "design v2" } },
      },
    ]);
  });

  it("prefers an explicit project over the work item's project for the upload URL", async () => {
    const fake = server();
    await service(fake).addAttachment({ workItemId: 123, filePath: file, project: "Other Project" });
    expect(fake.calls[1]!.url.href).toBe(`${HOST}/Other%20Project/_apis/wit/attachments?fileName=spec.pdf&api-version=7.0`);
  });

  it("falls back to the configured default project, then to collection level, when the work item has none", async () => {
    const noProject = workItem({ id: 123, rev: 7 });
    delete noProject.fields["System.TeamProject"];

    const withDefault = server({ get: () => json(noProject) });
    await service(withDefault, { defaultProject: "EnvProject" }).addAttachment({ workItemId: 123, filePath: file });
    expect(withDefault.calls[1]!.url.pathname).toBe("/tfs/DefaultCollection/EnvProject/_apis/wit/attachments");

    const withoutDefault = server({ get: () => json(noProject) });
    await service(withoutDefault).addAttachment({ workItemId: 123, filePath: file });
    expect(withoutDefault.calls[1]!.url.pathname).toBe("/tfs/DefaultCollection/_apis/wit/attachments");
  });

  it("uses a custom fileName for the upload and omits the comment attribute when none is given", async () => {
    const fake = server();
    const result = await service(fake).addAttachment({ workItemId: 123, filePath: file, fileName: "renamed ü.pdf" });

    expect(result.attachment.name).toBe("renamed ü.pdf");
    expect(result.attachment.comment).toBeNull();
    expect(fake.calls[1]!.url.searchParams.get("fileName")).toBe("renamed ü.pdf");
    const patch = JSON.parse(fake.calls[2]!.init.body as string) as Array<{ value?: { attributes?: unknown } }>;
    expect(patch[1]?.value?.attributes).toEqual({});
  });

  it("fails before any network call when the local file does not exist", async () => {
    const fake = server();
    const missing = path.join(dir, "missing.txt");
    await expect(service(fake).addAttachment({ workItemId: 123, filePath: missing })).rejects.toThrow(ToolInputError);
    expect(fake.calls).toHaveLength(0);
  });

  it("retries the link once with a fresh revision when the PATCH hits a rev conflict, without re-uploading", async () => {
    const fake = server({
      get: (n) => json(workItem({ id: 123, rev: n === 0 ? 7 : 9 })),
      patch: (n) => (n === 0 ? json({ message: "VS402625: conflict" }, 409) : json(workItem({ id: 123, rev: 10 }))),
    });
    const result = await service(fake).addAttachment({ workItemId: 123, filePath: file });

    expect(result.workItemRev).toBe(10);
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "POST", "PATCH", "GET", "PATCH"]);
    const secondPatch = JSON.parse(fake.calls[4]!.init.body as string) as Array<{ op: string; value?: unknown }>;
    expect(secondPatch[0]).toEqual({ op: "test", path: "/rev", value: 9 });
  });

  it("treats a 400 whose message mentions the /rev test as a conflict and retries", async () => {
    const fake = server({
      patch: (n) =>
        n === 0
          ? json({ message: "The request is invalid: test operation for path /rev failed." }, 400)
          : json(workItem({ id: 123, rev: 8 })),
    });
    await service(fake).addAttachment({ workItemId: 123, filePath: file });
    expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
  });

  it("gives up after the second conflict with a clear message", async () => {
    const fake = server({ patch: () => json({ message: "conflict" }, 409) });
    const err = await service(fake)
      .addAttachment({ workItemId: 123, filePath: file })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(AzdoError);
    expect((err as AzdoError).kind).toBe("conflict");
    expect((err as AzdoError).message).toMatch(/modified concurrently .*twice|retry the operation/i);
    expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
  });

  it("does not retry an unrelated 400", async () => {
    const fake = server({ patch: () => json({ message: "TF401320: Rule Error for field Title." }, 400) });
    const err = await service(fake)
      .addAttachment({ workItemId: 123, filePath: file })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect((err as AzdoError).kind).toBe("bad_request");
    expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });
});
