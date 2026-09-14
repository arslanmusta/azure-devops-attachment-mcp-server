export const HOST = "https://tfs.company.local/tfs/DefaultCollection";

export interface RelationFixture {
  rel: string;
  url: string;
  attributes?: Record<string, unknown>;
}

export interface WorkItemFixtureOptions {
  id?: number;
  rev?: number;
  project?: string;
  relations?: RelationFixture[] | null;
}

export function workItem(opts: WorkItemFixtureOptions = {}) {
  const { id = 123, rev = 7, project = "Proj", relations = [] } = opts;
  const wi: Record<string, unknown> = {
    id,
    rev,
    fields: {
      "System.Id": id,
      "System.Rev": rev,
      "System.TeamProject": project,
      "System.Title": "Fixture work item",
    },
    url: `${HOST}/_apis/wit/workItems/${id}`,
  };
  if (relations !== null) wi.relations = relations;
  return wi as { id: number; rev: number; fields: Record<string, unknown>; relations?: RelationFixture[] };
}

export interface AttachedFileOptions {
  guid: string;
  name: string;
  size?: number | null;
  comment?: string;
  created?: string;
  host?: string;
  relationId?: number;
}

export function attachedFile(opts: AttachedFileOptions): RelationFixture {
  const { guid, name, size = 1234, comment, created = "2026-01-02T10:00:00Z", host = HOST, relationId = 65274 } = opts;
  const attributes: Record<string, unknown> = {
    authorizedDate: created,
    id: relationId,
    resourceCreatedDate: created,
    resourceModifiedDate: created,
    revisedDate: "9999-01-01T00:00:00Z",
    name,
  };
  if (size !== null) attributes.resourceSize = size;
  if (comment !== undefined) attributes.comment = comment;
  return { rel: "AttachedFile", url: `${host}/_apis/wit/attachments/${guid}`, attributes };
}

export function hyperlink(url = "https://example.com/spec"): RelationFixture {
  return { rel: "Hyperlink", url, attributes: { authorizedDate: "2026-01-01T00:00:00Z", id: 1, comment: "spec link" } };
}

export function relatedLink(targetId = 300): RelationFixture {
  return {
    rel: "System.LinkTypes.Related",
    url: `${HOST}/_apis/wit/workItems/${targetId}`,
    attributes: { isLocked: false, comment: "related" },
  };
}
