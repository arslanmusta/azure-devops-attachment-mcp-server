import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AzdoError, ToolInputError } from "../src/errors.js";
import { fakeFetch, json, octet, type RecordedCall } from "./helpers/fake-fetch.js";
import { HOST, attachedFile, hyperlink, workItem, type RelationFixture } from "./helpers/fixtures.js";
import { GUID_A, GUID_B, GUID_C, service } from "./helpers/service.js";

const INTERNAL_HOST = "https://internal-tfs:8080/tfs/DefaultCollection";

function relations(): RelationFixture[] {
  return [
    hyperlink(),
    attachedFile({ guid: GUID_A, name: "spec v2.pdf", size: 9, host: INTERNAL_HOST }),
    attachedFile({ guid: GUID_B, name: "log.txt", size: 10 }),
    attachedFile({ guid: GUID_C, name: "log.txt", size: 20 }),
  ];
}

function server(opts: { relations?: RelationFixture[]; download?: () => Response } = {}) {
  return fakeFetch((call: RecordedCall) => {
    if (call.url.pathname.includes("/_apis/wit/workitems/")) {
      return json(workItem({ id: 123, rev: 7, project: "Proj", relations: opts.relations ?? relations() }));
    }
    if (call.url.pathname.includes("/_apis/wit/attachments/")) {
      return (opts.download ?? (() => octet(Buffer.from("PDF-bytes"))))();
    }
    throw new Error(`unexpected ${call.method} ${call.url.href}`);
  });
}

function downloadCall(fake: ReturnType<typeof fakeFetch>): RecordedCall | undefined {
  return fake.calls.find((c) => c.url.pathname.includes("/_apis/wit/attachments/"));
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "azdo-dl-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("AttachmentService.downloadAttachment", () => {
  it("saves the attachment under its server-side name in the requested directory", async () => {
    const fake = server();
    const result = await service(fake).downloadAttachment({ workItemId: 123, attachmentId: GUID_A, outputDir: dir });

    expect(result).toEqual({ id: GUID_A, name: "spec v2.pdf", path: path.join(dir, "spec v2.pdf"), size: 9, workItemId: 123 });
    expect(await readFile(result.path, "utf8")).toBe("PDF-bytes");
  });

  it("rebuilds the download URL on the configured collection URL instead of the host in the relation", async () => {
    const fake = server();
    await service(fake).downloadAttachment({ workItemId: 123, attachmentId: GUID_A, outputDir: dir });

    const call = downloadCall(fake)!;
    expect(call.url.href).toBe(`${HOST}/Proj/_apis/wit/attachments/${GUID_A}?fileName=spec%20v2.pdf&download=true&api-version=7.0`);
    expect(call.url.href).not.toContain("internal-tfs");
  });

  it("prefers an explicit project in the download URL", async () => {
    const fake = server();
    await service(fake).downloadAttachment({ workItemId: 123, attachmentId: GUID_A, outputDir: dir, project: "Other" });
    expect(downloadCall(fake)!.url.pathname).toBe(`/tfs/DefaultCollection/Other/_apis/wit/attachments/${GUID_A}`);
  });

  it("resolves a unique name and refuses an ambiguous one", async () => {
    const ok = await service(server()).downloadAttachment({ workItemId: 123, name: "spec v2.pdf", outputDir: dir });
    expect(ok.id).toBe(GUID_A);

    const fake = server();
    const err = await failure(service(fake).downloadAttachment({ workItemId: 123, name: "log.txt", outputDir: dir }));
    expect(err).toBeInstanceOf(ToolInputError);
    expect((err as Error).message).toContain(GUID_B);
    expect(downloadCall(fake)).toBeUndefined();
  });

  it("uses a caller-supplied local file name while still asking the server for the original", async () => {
    const fake = server();
    const result = await service(fake).downloadAttachment({
      workItemId: 123,
      attachmentId: GUID_A,
      outputDir: dir,
      fileName: "renamed.pdf",
    });
    expect(result.name).toBe("renamed.pdf");
    expect(result.path).toBe(path.join(dir, "renamed.pdf"));
    expect(downloadCall(fake)!.url.searchParams.get("fileName")).toBe("spec v2.pdf");
  });

  it("sanitizes a hostile server-side name so the file stays inside the output directory", async () => {
    const hostile = [attachedFile({ guid: GUID_A, name: "../../etc/passwd" })];
    const result = await service(server({ relations: hostile })).downloadAttachment({
      workItemId: 123,
      attachmentId: GUID_A,
      outputDir: dir,
    });
    expect(result.path).toBe(path.join(dir, "passwd"));
  });

  it("falls back to <id>.bin when the relation has no name", async () => {
    const nameless: RelationFixture = { rel: "AttachedFile", url: `${HOST}/_apis/wit/attachments/${GUID_A}`, attributes: {} };
    const result = await service(server({ relations: [nameless] })).downloadAttachment({
      workItemId: 123,
      attachmentId: GUID_A,
      outputDir: dir,
    });
    expect(result.path).toBe(path.join(dir, `${GUID_A}.bin`));
  });

  it("never overwrites an existing file", async () => {
    await writeFile(path.join(dir, "spec v2.pdf"), "old");
    const result = await service(server()).downloadAttachment({ workItemId: 123, attachmentId: GUID_A, outputDir: dir });
    expect(result.path).toBe(path.join(dir, "spec v2 (1).pdf"));
    expect(await readFile(path.join(dir, "spec v2.pdf"), "utf8")).toBe("old");
  });

  it("defaults to the configured download directory and resolves relative directories against cwd", async () => {
    const byConfig = await service(server(), { downloadDir: dir }).downloadAttachment({ workItemId: 123, attachmentId: GUID_A });
    expect(byConfig.path).toBe(path.join(dir, "spec v2.pdf"));

    const relative = path.relative(process.cwd(), dir);
    const byArg = await service(server()).downloadAttachment({ workItemId: 123, attachmentId: GUID_B, outputDir: relative });
    expect(byArg.path).toBe(path.join(dir, "log.txt"));
  });

  it("reports not found when the attachment is not on the work item and skips the download", async () => {
    const fake = server();
    const unknown = "dddddddd-1111-4222-8333-444455556666";
    const err = await failure(service(fake).downloadAttachment({ workItemId: 123, attachmentId: unknown, outputDir: dir }));
    expect((err as AzdoError).kind).toBe("not_found");
    expect(downloadCall(fake)).toBeUndefined();
    expect(await readdir(dir)).toEqual([]);
  });

  it("propagates download failures and leaves no file behind", async () => {
    const fake = server({ download: () => json({ message: "TF237082: The attachment does not exist" }, 404) });
    const err = await failure(service(fake).downloadAttachment({ workItemId: 123, attachmentId: GUID_A, outputDir: dir }));
    expect((err as AzdoError).kind).toBe("not_found");
    expect(await readdir(dir)).toEqual([]);
  });
});
