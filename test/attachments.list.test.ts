import { describe, expect, it } from "vitest";
import { AzdoError } from "../src/errors.js";
import { fakeFetch, json } from "./helpers/fake-fetch.js";
import { HOST, attachedFile, hyperlink, relatedLink, workItem } from "./helpers/fixtures.js";
import { GUID_A, GUID_B, service } from "./helpers/service.js";

describe("AttachmentService.listAttachments", () => {
  it("returns only AttachedFile relations, each with its index in the full relations array", async () => {
    const wi = workItem({
      id: 123,
      rev: 7,
      relations: [
        hyperlink(),
        attachedFile({ guid: GUID_A, name: "spec.pdf", size: 12600, comment: "design v2" }),
        relatedLink(),
        attachedFile({ guid: GUID_B, name: "log.txt", size: null }),
      ],
    });
    const fake = fakeFetch(() => json(wi));

    const result = await service(fake).listAttachments({ workItemId: 123 });

    expect(result).toEqual({
      workItemId: 123,
      workItemRev: 7,
      count: 2,
      attachments: [
        {
          id: GUID_A,
          name: "spec.pdf",
          size: 12600,
          comment: "design v2",
          createdDate: "2026-01-02T10:00:00Z",
          url: `${HOST}/_apis/wit/attachments/${GUID_A}`,
          relationIndex: 1,
        },
        {
          id: GUID_B,
          name: "log.txt",
          size: null,
          comment: null,
          createdDate: "2026-01-02T10:00:00Z",
          url: `${HOST}/_apis/wit/attachments/${GUID_B}`,
          relationIndex: 3,
        },
      ],
    });
  });

  it("fetches the work item once, at collection level, with relations expanded", async () => {
    const fake = fakeFetch(() => json(workItem({ id: 42 })));
    await service(fake, { defaultProject: "SomeProject" }).listAttachments({ workItemId: 42 });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url.href).toBe(`${HOST}/_apis/wit/workitems/42?$expand=relations&api-version=7.0`);
  });

  it("returns an empty list when the work item has no relations at all", async () => {
    const fake = fakeFetch(() => json(workItem({ id: 5, rev: 2, relations: null })));
    const result = await service(fake).listAttachments({ workItemId: 5 });
    expect(result).toEqual({ workItemId: 5, workItemRev: 2, count: 0, attachments: [] });
  });

  it("falls back to authorizedDate when resourceCreatedDate is missing and lower-cases the id", async () => {
    const relation = {
      rel: "AttachedFile",
      url: `${HOST}/_apis/wit/attachments/${GUID_A.toUpperCase()}`,
      attributes: { authorizedDate: "2025-12-31T23:59:59Z", name: "old.txt" },
    };
    const fake = fakeFetch(() => json(workItem({ relations: [relation] })));
    const [info] = (await service(fake).listAttachments({ workItemId: 123 })).attachments;
    expect(info?.id).toBe(GUID_A);
    expect(info?.createdDate).toBe("2025-12-31T23:59:59Z");
    expect(info?.size).toBeNull();
  });

  it("propagates server errors such as an unknown work item", async () => {
    const fake = fakeFetch(() =>
      json({ message: "TF401232: Work item 999 does not exist, or you do not have permissions to read it." }, 404),
    );
    const err = await service(fake)
      .listAttachments({ workItemId: 999 })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(AzdoError);
    expect((err as AzdoError).kind).toBe("not_found");
    expect((err as AzdoError).message).toContain("TF401232");
  });
});
