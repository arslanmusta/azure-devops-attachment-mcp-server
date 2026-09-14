import { z } from "zod";

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const workItemId = z.number().int().positive().describe("Work item ID (unique within the collection).");

export const project = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Team project name or ID used for the attachment endpoints. Defaults to the work item's own project, then to AZURE_DEVOPS_PROJECT.",
  );

export const attachmentId = z
  .string()
  .regex(GUID_RE, "must be an attachment GUID")
  .optional()
  .describe("Attachment GUID as returned by list_attachments (the last segment of the attachment URL).");

export const attachmentName = z
  .string()
  .min(1)
  .optional()
  .describe("Exact server-side file name. Works only when the name is unique on the work item; otherwise pass attachmentId.");

export const attachmentInfo = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().int().nullable(),
  comment: z.string().nullable(),
  createdDate: z.string().nullable(),
  url: z.string(),
  relationIndex: z.number().int(),
});

export const listInput = { workItemId };
export const listOutput = {
  workItemId: z.number().int(),
  workItemRev: z.number().int(),
  count: z.number().int(),
  attachments: z.array(attachmentInfo),
};

export const addInput = {
  workItemId,
  filePath: z
    .string()
    .min(1)
    .describe("Absolute or cwd-relative path of the local file to upload (simple upload limit: 130 MB)."),
  fileName: z.string().min(1).optional().describe("Name to store on the server; defaults to the file's base name."),
  comment: z.string().max(4000).optional().describe("Optional comment shown next to the attachment."),
  project,
};
export const addOutput = {
  workItemId: z.number().int(),
  workItemRev: z.number().int(),
  attachment: z.object({
    id: z.string(),
    name: z.string(),
    size: z.number().int(),
    url: z.string(),
    comment: z.string().nullable(),
  }),
};

export const deleteInput = { workItemId, attachmentId, name: attachmentName };
export const deleteOutput = {
  workItemId: z.number().int(),
  workItemRev: z.number().int(),
  removed: z.object({ id: z.string(), name: z.string(), relationIndex: z.number().int() }),
  note: z.string(),
};

export const downloadInput = {
  workItemId,
  attachmentId,
  name: attachmentName,
  fileName: z
    .string()
    .min(1)
    .optional()
    .describe('Local file name to save as; defaults to the server-side name. Existing files are never overwritten; a " (n)" suffix is added.'),
  outputDir: z
    .string()
    .min(1)
    .optional()
    .describe("Directory to save into; defaults to AZURE_DEVOPS_DOWNLOAD_DIR, then to the server's working directory."),
  project,
};
export const downloadOutput = {
  id: z.string(),
  name: z.string(),
  path: z.string(),
  size: z.number().int(),
  workItemId: z.number().int(),
};

export type ListArgs = z.output<z.ZodObject<typeof listInput>>;
export type AddArgs = z.output<z.ZodObject<typeof addInput>>;
export type DeleteArgs = z.output<z.ZodObject<typeof deleteInput>>;
export type DownloadArgs = z.output<z.ZodObject<typeof downloadInput>>;
