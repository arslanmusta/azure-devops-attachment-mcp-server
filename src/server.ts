import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AttachmentInfo, AttachmentService } from "./attachments.js";
import { AzdoError, ToolInputError, formatToolError } from "./errors.js";
import { log } from "./log.js";
import * as schemas from "./schemas.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "size unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatAttachmentLine(a: AttachmentInfo): string {
  const date = a.createdDate ? `, ${a.createdDate.slice(0, 10)}` : "";
  const comment = a.comment ? ` "${a.comment}"` : "";
  return `- ${a.name} (${formatBytes(a.size)}, id ${a.id}${date})${comment}`;
}

function ok(text: string, structuredContent: object): CallToolResult {
  // Result interfaces have no index signature; the SDK wants a plain record.
  return { content: [{ type: "text", text }], structuredContent: structuredContent as Record<string, unknown> };
}

function fail(err: unknown): CallToolResult {
  return { content: [{ type: "text", text: formatToolError(err) }], isError: true };
}

/** Converts thrown errors into `isError` results so the client always gets a readable message. */
function guarded<A>(tool: string, fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof AzdoError || err instanceof ToolInputError) {
        log.warn(`${tool}: ${err.message}`);
      } else {
        log.error(`${tool} failed unexpectedly`, err);
      }
      return fail(err);
    }
  };
}

/** Builds the MCP server with the four attachment tools bound to `service`. */
export function createServer(service: AttachmentService): McpServer {
  const server = new McpServer({ name: PACKAGE_NAME, version: PACKAGE_VERSION });

  server.registerTool(
    "list_attachments",
    {
      title: "List work item attachments",
      description:
        "List the file attachments of an Azure DevOps work item: name, size, comment, created date, attachment id (GUID) and URL.",
      inputSchema: schemas.listInput,
      outputSchema: schemas.listOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guarded("list_attachments", async (args: schemas.ListArgs) => {
      const result = await service.listAttachments(args);
      const head = `Work item ${result.workItemId} (rev ${result.workItemRev})`;
      const text =
        result.count === 0
          ? `${head} has no attachments.`
          : `${head} has ${result.count} attachment${result.count === 1 ? "" : "s"}:\n${result.attachments
              .map(formatAttachmentLine)
              .join("\n")}`;
      return ok(text, result);
    }),
  );

  server.registerTool(
    "add_attachment",
    {
      title: "Add an attachment to a work item",
      description:
        "Upload a local file and attach it to a work item (adds an AttachedFile relation). Simple upload limit: 130 MB. Returns the attachment id and the work item's new revision.",
      inputSchema: schemas.addInput,
      outputSchema: schemas.addOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded("add_attachment", async (args: schemas.AddArgs) => {
      const result = await service.addAttachment(args);
      const a = result.attachment;
      return ok(
        `Attached "${a.name}" (${formatBytes(a.size)}) to work item ${result.workItemId} as ${a.id}; work item is now rev ${result.workItemRev}.`,
        result,
      );
    }),
  );

  server.registerTool(
    "delete_attachment",
    {
      title: "Delete a work item attachment",
      description:
        "Remove an attachment from a work item by attachment id or by a file name that is unique on the work item. Only the link is removed; Azure DevOps has no API to delete the stored file.",
      inputSchema: schemas.deleteInput,
      outputSchema: schemas.deleteOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guarded("delete_attachment", async (args: schemas.DeleteArgs) => {
      const result = await service.deleteAttachment(args);
      const r = result.removed;
      return ok(
        `Removed attachment "${r.name}" (${r.id}) from work item ${result.workItemId}; work item is now rev ${result.workItemRev}. ${result.note}`,
        result,
      );
    }),
  );

  server.registerTool(
    "download_attachment",
    {
      title: "Download a work item attachment",
      description:
        'Download a work item attachment to a local directory by attachment id or unique file name. Existing files are never overwritten (a " (n)" suffix is added). Returns the absolute path of the saved file.',
      inputSchema: schemas.downloadInput,
      outputSchema: schemas.downloadOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    guarded("download_attachment", async (args: schemas.DownloadArgs) => {
      const result = await service.downloadAttachment(args);
      return ok(
        `Saved "${result.name}" (${formatBytes(result.size)}) from work item ${result.workItemId} to ${result.path}`,
        result,
      );
    }),
  );

  return server;
}
