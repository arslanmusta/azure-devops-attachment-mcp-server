import { describe, expect, it } from "vitest";
import { AzdoError, ToolInputError } from "../src/errors.js";
import { fakeFetch, json, type RecordedCall } from "./helpers/fake-fetch.js";
import { attachedFile, hyperlink, relatedLink, workItem, type RelationFixture } from "./helpers/fixtures.js";
import { GUID_A, GUID_B, GUID_C, service } from "./helpers/service.js";

function relations(): RelationFixture[] {
  return [
    hyperlink(),
    attachedFile({ guid: GUID_A, name: "spec.pdf", size: 12600 }),
    relatedLink(),
    attachedFile({ guid: GUID_B, name: "log.txt", size: 10 }),
    attachedFile({ guid: GUID_C, name: "log.txt", size: 20 }),
  ];
}

function server(opts: { get?: (n: number) => Response; patch?: (n: number) => Response } = {}) {
  const counts = { GET: 0, PATCH: 0 };
  return fakeFetch((call: RecordedCall) => {
    const method = call.method as keyof typeof counts;
    const n = counts[method]++;
    if (method === "GET") return (opts.get ?? (() => json(workItem({ id: 123, rev: 7, relations: relations() }))))(n);
    if (method === "PATCH") return (opts.patch ?? (() => json(workItem({ id: 123, rev: 8 }))))(n);
    throw new Error(`unexpected ${call.method} ${call.url.href}`);
  });
}

function patchBody(call: RecordedCall): unknown {
  return JSON.parse(call.init.body as string);
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

describe("AttachmentService.deleteAttachment", () => {
  it("removes the relation at its index in the full relations array, guarded by the revision", async () => {
    const fake = server();
    const result = await service(fake).deleteAttachment({ workItemId: 123, attachmentId: GUID_A });

    expect(result.workItemId).toBe(123);
    expect(result.workItemRev).toBe(8);
    expect(result.removed).toEqual({ id: GUID_A, name: "spec.pdf", relationIndex: 1 });
    expect(result.note).toMatch(/keeps the underlying file/i);

    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(patchBody(fake.calls[1]!)).toEqual([
      { op: "test", path: "/rev", value: 7 },
      { op: "remove", path: "/relations/1" },
    ]);
  });

  it("accepts the attachment id in any letter case", async () => {
    const fake = server();
    const result = await service(fake).deleteAttachment({ workItemId: 123, attachmentId: GUID_A.toUpperCase() });
    expect(result.removed.id).toBe(GUID_A);
  });

  it("resolves a unique name to the same relation", async () => {
    const fake = server();
    const result = await service(fake).deleteAttachment({ workItemId: 123, name: "spec.pdf" });
    expect(result.removed).toEqual({ id: GUID_A, name: "spec.pdf", relationIndex: 1 });
    expect(patchBody(fake.calls[1]!)).toEqual([
      { op: "test", path: "/rev", value: 7 },
      { op: "remove", path: "/relations/1" },
    ]);
  });

  it("refuses an ambiguous name, listing the candidate ids, and does not PATCH", async () => {
    const fake = server();
    const err = await failure(service(fake).deleteAttachment({ workItemId: 123, name: "log.txt" }));
    expect(err).toBeInstanceOf(ToolInputError);
    const message = (err as Error).message;
    expect(message).toMatch(/2 attachments named "log\.txt"/);
    expect(message).toContain(GUID_B);
    expect(message).toContain(GUID_C);
    expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("reports an unknown name as not found and lists the names that do exist", async () => {
    const fake = server();
    const err = await failure(service(fake).deleteAttachment({ workItemId: 123, name: "nope.txt" }));
    expect(err).toBeInstanceOf(AzdoError);
    expect((err as AzdoError).kind).toBe("not_found");
    expect((err as AzdoError).message).toContain("spec.pdf");
    expect((err as AzdoError).message).toContain("log.txt");
  });

  it("reports an unknown id as not found", async () => {
    const fake = server();
    const unknown = "dddddddd-1111-4222-8333-444455556666";
    const err = await failure(service(fake).deleteAttachment({ workItemId: 123, attachmentId: unknown }));
    expect((err as AzdoError).kind).toBe("not_found");
    expect((err as AzdoError).message).toContain(unknown);
  });

  it("requires exactly one of attachmentId or name", async () => {
    const fake = server();
    await expect(service(fake).deleteAttachment({ workItemId: 123 })).rejects.toThrow(ToolInputError);
    await expect(service(fake).deleteAttachment({ workItemId: 123 })).rejects.toThrow(/attachmentId or name/);
    await expect(
      service(fake).deleteAttachment({ workItemId: 123, attachmentId: GUID_A, name: "spec.pdf" }),
    ).rejects.toThrow(/not both/);
    expect(fake.calls).toHaveLength(0);
  });

  it("recomputes the relation index from a fresh fetch when the first PATCH hits a rev conflict", async () => {
    const shifted = relations().slice(1); // hyperlink removed concurrently: spec.pdf is now index 0
    const fake = server({
      get: (n) => json(workItem({ id: 123, rev: n === 0 ? 7 : 9, relations: n === 0 ? relations() : shifted })),
      patch: (n) => (n === 0 ? json({ message: "conflict" }, 409) : json(workItem({ id: 123, rev: 10 }))),
    });
    const result = await service(fake).deleteAttachment({ workItemId: 123, attachmentId: GUID_A });

    expect(result.workItemRev).toBe(10);
    expect(result.removed.relationIndex).toBe(0);
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "PATCH", "GET", "PATCH"]);
    expect(patchBody(fake.calls[3]!)).toEqual([
      { op: "test", path: "/rev", value: 9 },
      { op: "remove", path: "/relations/0" },
    ]);
  });

  it("reports not found when the attachment disappeared before the retry", async () => {
    const without = relations().filter((r) => !r.url.endsWith(GUID_A));
    const fake = server({
      get: (n) => json(workItem({ id: 123, rev: n === 0 ? 7 : 9, relations: n === 0 ? relations() : without })),
      patch: () => json({ message: "conflict" }, 409),
    });
    const err = await failure(service(fake).deleteAttachment({ workItemId: 123, attachmentId: GUID_A }));
    expect((err as AzdoError).kind).toBe("not_found");
    expect((err as AzdoError).message).toMatch(/no longer attached/i);
    expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });
});
