import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { fakeFetch, json, octet, type FakeFetch, type RecordedCall } from "./helpers/fake-fetch.js";
import { attachedFile, hyperlink, workItem } from "./helpers/fixtures.js";
import { GUID_A, service } from "./helpers/service.js";

function backend(opts: { workItemStatus?: number } = {}): FakeFetch {
  return fakeFetch((call: RecordedCall) => {
    if (call.url.pathname.includes("/_apis/wit/workitems/")) {
      if (opts.workItemStatus === 404) {
        return json({ message: "TF401232: Work item 123 does not exist, or you do not have permissions to read it." }, 404);
      }
      if (call.method === "PATCH") return json(workItem({ id: 123, rev: 8 }));
      return json(
        workItem({
          id: 123,
          rev: 7,
          project: "Proj",
          relations: [hyperlink(), attachedFile({ guid: GUID_A, name: "spec.pdf", size: 12600, comment: "design v2" })],
        }),
      );
    }
    if (call.method === "POST" && call.url.pathname.endsWith("/_apis/wit/attachments")) {
      return json({ id: GUID_A, url: `https://tfs.company.local/tfs/DefaultCollection/_apis/wit/attachments/${GUID_A}` }, 201);
    }
    if (call.url.pathname.includes("/_apis/wit/attachments/")) return octet(Buffer.from("PDF-bytes"));
    throw new Error(`unexpected ${call.method} ${call.url.href}`);
  });
}

let dir: string;
let client: Client;
let mcp: McpServer;

async function connect(fake: FakeFetch): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = createServer(service(fake, { downloadDir: dir }));
  await mcp.connect(serverTransport);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "azdo-server-"));
});
afterEach(async () => {
  await client?.close();
  await mcp?.close();
  await rm(dir, { recursive: true, force: true });
});

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

describe("MCP server", () => {
  it("exposes exactly the four attachment tools with input/output schemas and annotations", async () => {
    const c = await connect(backend());
    const { tools } = await c.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual(["add_attachment", "delete_attachment", "download_attachment", "list_attachments"]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema).toBeDefined();
      expect(tool.inputSchema.required).toContain("workItemId");
    }
    expect(byName.list_attachments?.annotations?.readOnlyHint).toBe(true);
    expect(byName.delete_attachment?.annotations?.destructiveHint).toBe(true);
    expect(byName.add_attachment?.annotations?.destructiveHint).toBe(false);
    expect(byName.delete_attachment?.inputSchema.required).not.toContain("attachmentId");
  });

  it("list_attachments returns structured content plus a readable summary", async () => {
    const c = await connect(backend());
    const result = (await c.callTool({ name: "list_attachments", arguments: { workItemId: 123 } })) as ToolResult;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ workItemId: 123, workItemRev: 7, count: 1 });
    expect((result.structuredContent!.attachments as Array<{ id: string }>)[0]?.id).toBe(GUID_A);
    const text = textOf(result);
    expect(text).toContain("spec.pdf");
    expect(text).toContain("12.3 KB");
    expect(text).toContain(GUID_A);
    expect(text).toContain("design v2");
  });

  it("rejects invalid arguments before reaching the service", async () => {
    const fake = backend();
    const c = await connect(fake);
    const result = (await c.callTool({ name: "list_attachments", arguments: { workItemId: "abc" } })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/validation error|invalid arguments/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("delete_attachment without a selector returns a tool error instead of throwing", async () => {
    const fake = backend();
    const c = await connect(fake);
    const result = (await c.callTool({ name: "delete_attachment", arguments: { workItemId: 123 } })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/attachmentId or name/);
    expect(fake.calls).toHaveLength(0);
  });

  it("delete_attachment reports what was removed and that the blob stays on the server", async () => {
    const c = await connect(backend());
    const result = (await c.callTool({ name: "delete_attachment", arguments: { workItemId: 123, attachmentId: GUID_A } })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ workItemRev: 8, removed: { id: GUID_A, name: "spec.pdf", relationIndex: 1 } });
    expect(textOf(result)).toMatch(/keeps the underlying file/i);
  });

  it("add_attachment with a missing file reports the problem as a tool error", async () => {
    const c = await connect(backend());
    const result = (await c.callTool({
      name: "add_attachment",
      arguments: { workItemId: 123, filePath: path.join(dir, "missing.txt") },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/File not found/);
  });

  it("add_attachment uploads the file and reports the new revision", async () => {
    const file = path.join(dir, "notes.md");
    await writeFile(file, "# notes");
    const c = await connect(backend());
    const result = (await c.callTool({
      name: "add_attachment",
      arguments: { workItemId: 123, filePath: file, comment: "meeting notes" },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      workItemId: 123,
      workItemRev: 8,
      attachment: { id: GUID_A, name: "notes.md", size: 7, comment: "meeting notes" },
    });
    expect(textOf(result)).toContain("notes.md");
    expect(textOf(result)).toContain("rev 8");
  });

  it("download_attachment writes the file and returns its absolute path", async () => {
    const c = await connect(backend());
    const result = (await c.callTool({
      name: "download_attachment",
      arguments: { workItemId: 123, attachmentId: GUID_A, outputDir: dir },
    })) as ToolResult;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ id: GUID_A, name: "spec.pdf", path: path.join(dir, "spec.pdf"), size: 9 });
    expect(textOf(result)).toContain(path.join(dir, "spec.pdf"));
  });

  it("surfaces Azure DevOps errors as tool errors carrying the server message", async () => {
    const c = await connect(backend({ workItemStatus: 404 }));
    const result = (await c.callTool({ name: "list_attachments", arguments: { workItemId: 123 } })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TF401232");
  });
});
