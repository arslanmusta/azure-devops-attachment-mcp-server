import type { AzdoClient, WorkItem, WorkItemRelation } from "./azdo-client.js";
import type { Config } from "./config.js";

export type ServiceConfig = Pick<Config, "defaultProject" | "downloadDir">;

export interface AttachmentInfo {
  /** Attachment GUID (last segment of the attachment URL), lower-cased. */
  id: string;
  name: string;
  /** Bytes, or null when the server did not report resourceSize. */
  size: number | null;
  comment: string | null;
  createdDate: string | null;
  url: string;
  /** Position in the work item's full relations array; needed to remove the link. */
  relationIndex: number;
}

export interface ListResult {
  workItemId: number;
  workItemRev: number;
  count: number;
  attachments: AttachmentInfo[];
}

const ATTACHED_FILE = "AttachedFile";

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Extracts the attachment GUID from an attachment URL. */
export function attachmentIdFromUrl(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const last = pathname.split("/").filter((s) => s.length > 0).pop() ?? "";
  return last.toLowerCase();
}

function toAttachmentInfo(relation: WorkItemRelation, relationIndex: number): AttachmentInfo {
  const attrs = relation.attributes ?? {};
  const id = attachmentIdFromUrl(relation.url);
  return {
    id,
    name: str(attrs.name) ?? id,
    size: num(attrs.resourceSize),
    comment: str(attrs.comment),
    createdDate: str(attrs.resourceCreatedDate) ?? str(attrs.authorizedDate),
    url: relation.url,
    relationIndex,
  };
}

function attachmentsOf(workItem: WorkItem): AttachmentInfo[] {
  return (workItem.relations ?? []).flatMap((relation, index) =>
    relation.rel === ATTACHED_FILE ? [toAttachmentInfo(relation, index)] : [],
  );
}

/** Work item attachment operations composed from the REST client. */
export class AttachmentService {
  constructor(
    private readonly client: AzdoClient,
    private readonly config: ServiceConfig,
  ) {}

  async listAttachments(args: { workItemId: number }): Promise<ListResult> {
    const workItem = await this.client.getWorkItem(args.workItemId);
    const attachments = attachmentsOf(workItem);
    return { workItemId: workItem.id, workItemRev: workItem.rev, count: attachments.length, attachments };
  }
}
