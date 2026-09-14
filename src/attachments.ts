import type { AzdoClient, JsonPatchOp, WorkItem, WorkItemRelation } from "./azdo-client.js";
import type { Config } from "./config.js";
import { AzdoError } from "./errors.js";
import { readLocalFile } from "./fs-utils.js";

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

export interface AddArgs {
  workItemId: number;
  filePath: string;
  fileName?: string;
  comment?: string;
  project?: string;
}

export interface AddResult {
  workItemId: number;
  workItemRev: number;
  attachment: { id: string; name: string; size: number; url: string; comment: string | null };
}

const ATTACHED_FILE = "AttachedFile";

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
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

/** Azure DevOps reports a failed `test /rev` either as 409/412 or as a 400 mentioning the revision. */
function isRevConflict(err: unknown): err is AzdoError {
  if (!(err instanceof AzdoError)) return false;
  if (err.kind === "conflict") return true;
  return err.kind === "bad_request" && /\/rev\b|revision/i.test(err.message);
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

  /** Uploads a local file and links it to the work item as an AttachedFile relation. */
  async addAttachment(args: AddArgs): Promise<AddResult> {
    const file = await readLocalFile(args.filePath);
    const fileName = trimmed(args.fileName) ?? file.name;
    const comment = trimmed(args.comment);

    const workItem = await this.client.getWorkItem(args.workItemId);
    const project = this.resolveProject(args.project, workItem);
    const ref = await this.client.uploadAttachment({ project, fileName, data: file.data });

    const updated = await this.patchWithFreshRev(args.workItemId, workItem, () => [
      {
        op: "add",
        path: "/relations/-",
        value: { rel: ATTACHED_FILE, url: ref.url, attributes: comment ? { comment } : {} },
      },
    ]);

    return {
      workItemId: updated.id,
      workItemRev: updated.rev,
      attachment: { id: ref.id.toLowerCase(), name: fileName, size: file.size, url: ref.url, comment: comment ?? null },
    };
  }

  /** Explicit argument, then the work item's own project, then the configured default. */
  private resolveProject(explicit: string | undefined, workItem: WorkItem): string | undefined {
    return trimmed(explicit) ?? str(workItem.fields["System.TeamProject"]) ?? this.config.defaultProject;
  }

  /**
   * PATCH with an optimistic-concurrency guard on /rev. When the server reports that the
   * revision moved, the work item is fetched once more and the ops are rebuilt and re-sent.
   */
  private async patchWithFreshRev(
    workItemId: number,
    initial: WorkItem,
    buildOps: (workItem: WorkItem) => JsonPatchOp[],
  ): Promise<WorkItem> {
    let current = initial;
    for (let attempt = 0; ; attempt++) {
      const ops: JsonPatchOp[] = [{ op: "test", path: "/rev", value: current.rev }, ...buildOps(current)];
      try {
        return await this.client.patchWorkItem(workItemId, ops);
      } catch (err) {
        if (!isRevConflict(err)) throw err;
        if (attempt >= 1) {
          throw new AzdoError(
            `Work item ${workItemId} was modified concurrently twice while updating it; retry the operation.`,
            "conflict",
            err.status,
            err.typeKey,
          );
        }
        current = await this.client.getWorkItem(workItemId);
      }
    }
  }
}
