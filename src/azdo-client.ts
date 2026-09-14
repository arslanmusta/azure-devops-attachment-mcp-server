import type { Config } from "./config.js";
import { AzdoError } from "./errors.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

export interface WorkItemRelation {
  rel: string;
  url: string;
  attributes?: Record<string, unknown>;
}

export interface WorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  relations?: WorkItemRelation[];
}

export interface AttachmentReference {
  id: string;
  url: string;
}

export interface JsonPatchOp {
  op: "add" | "remove" | "replace" | "test";
  path: string;
  value?: unknown;
}

export type ClientConfig = Pick<Config, "baseUrl" | "pat" | "apiVersion">;
export type FetchLike = typeof globalThis.fetch;

/** Metadata calls (work item GET/PATCH). */
export const METADATA_TIMEOUT_MS = 30_000;
/** Attachment upload/download. */
export const TRANSFER_TIMEOUT_MS = 600_000;

const TLS_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
]);
const REACHABILITY_ERROR_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "EHOSTUNREACH", "ETIMEDOUT"]);

const PAT_HINT =
  "Check AZURE_DEVOPS_PAT: it must be valid, not expired, created in this collection, and have the 'Work Items (Read & Write)' scope.";

interface ServerErrorBody {
  message?: string;
  typeKey?: string;
}

function contentType(res: Response): string {
  return (res.headers.get("content-type") ?? "").toLowerCase();
}

function isHtml(res: Response): boolean {
  return contentType(res).includes("text/html");
}

async function readErrorBody(res: Response): Promise<ServerErrorBody> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return {};
  }
  if (!text) return {};
  if (contentType(res).includes("json")) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      return {
        message: typeof body.message === "string" ? body.message : undefined,
        typeKey: typeof body.typeKey === "string" ? body.typeKey : undefined,
      };
    } catch {
      /* fall through to raw text */
    }
  }
  if (isHtml(res)) return {};
  return { message: text.slice(0, 200) };
}

/**
 * Thin REST client for Azure DevOps Server work item tracking.
 * Every failure surfaces as an AzdoError with a user-facing message.
 */
export class AzdoClient {
  private readonly authHeader: string;

  constructor(
    private readonly config: ClientConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {
    this.authHeader = `Basic ${Buffer.from(`:${config.pat}`).toString("base64")}`;
  }

  /** GET the work item at collection level with relations expanded. */
  async getWorkItem(id: number): Promise<WorkItem> {
    const url = this.url(["_apis", "wit", "workitems", String(id)], { $expand: "relations" });
    const res = await this.send(url, { method: "GET" }, METADATA_TIMEOUT_MS);
    return this.readJson<WorkItem>(res, url);
  }

  /** PATCH a JSON Patch document onto the work item; returns the updated work item. */
  async patchWorkItem(id: number, ops: JsonPatchOp[]): Promise<WorkItem> {
    const url = this.url(["_apis", "wit", "workitems", String(id)], {});
    const res = await this.send(
      url,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json-patch+json" },
        body: JSON.stringify(ops),
      },
      METADATA_TIMEOUT_MS,
    );
    return this.readJson<WorkItem>(res, url);
  }

  /** POST raw bytes as a new attachment blob (simple upload, <= 130 MB). */
  async uploadAttachment(opts: { project?: string; fileName: string; data: Uint8Array }): Promise<AttachmentReference> {
    const url = this.url([...this.projectSegments(opts.project), "_apis", "wit", "attachments"], {
      fileName: opts.fileName,
    });
    const res = await this.send(
      url,
      { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: opts.data },
      TRANSFER_TIMEOUT_MS,
    );
    return this.readJson<AttachmentReference>(res, url);
  }

  /** GET the attachment content. The caller streams `response.body`. */
  async downloadAttachment(opts: { project?: string; id: string; fileName: string }): Promise<Response> {
    const url = this.url([...this.projectSegments(opts.project), "_apis", "wit", "attachments", opts.id], {
      fileName: opts.fileName,
      download: "true",
    });
    return this.send(url, { method: "GET", headers: { Accept: "*/*" } }, TRANSFER_TIMEOUT_MS);
  }

  private projectSegments(project: string | undefined): string[] {
    return project ? [project] : [];
  }

  private url(segments: string[], query: Record<string, string>): string {
    const path = segments.map(encodeURIComponent).join("/");
    const params = Object.entries({ ...query, "api-version": this.config.apiVersion })
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");
    return `${this.config.baseUrl}/${path}?${params}`;
  }

  private async send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", this.authHeader);
    headers.set("X-TFS-FedAuthRedirect", "Suppress");
    headers.set("User-Agent", `${PACKAGE_NAME}/${PACKAGE_VERSION}`);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw this.networkError(err, url);
    }

    if (res.ok && res.status !== 203 && !isHtml(res)) return res;
    throw await this.httpError(res, url);
  }

  private async readJson<T>(res: Response, url: string): Promise<T> {
    const type = contentType(res);
    if (!type.includes("json")) {
      throw new AzdoError(
        `Unexpected response from Azure DevOps (HTTP ${res.status}, ${type || "no content type"}) for ${new URL(url).pathname}.`,
        "unexpected_response",
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  private async httpError(res: Response, url: string): Promise<AzdoError> {
    const { message, typeKey } = await readErrorBody(res);
    const status = res.status;
    const said = message ? ` Server said: ${message}` : "";
    const fail = (text: string, kind: AzdoError["kind"]) => new AzdoError(text, kind, status, typeKey);

    if (status === 401) {
      return fail(`Authentication failed (HTTP 401). ${PAT_HINT}${said}`, "auth");
    }
    if (status === 203 || (status >= 300 && status < 400) || isHtml(res)) {
      return fail(
        `Azure DevOps returned a sign-in page instead of data (HTTP ${status}). This usually means the PAT was rejected or AZURE_DEVOPS_URL is not the collection URL. ${PAT_HINT}${said}`,
        "auth",
      );
    }
    if (status === 403) {
      return fail(
        `Permission denied (HTTP 403).${said} The PAT owner may lack permission on this work item or area path, or the PAT scope is too narrow.`,
        "forbidden",
      );
    }
    if (status === 404) {
      return fail(`Not found (HTTP 404) at ${new URL(url).pathname}.${said}`, "not_found");
    }
    if (status === 400) {
      return fail(`Azure DevOps rejected the request (HTTP 400).${said}`, "bad_request");
    }
    if (status === 409 || status === 412) {
      return fail(`The work item was modified concurrently (HTTP ${status}).${said}`, "conflict");
    }
    if (status === 413) {
      return fail(`The attachment is too large for this server (HTTP 413).${said}`, "too_large");
    }
    if (status >= 500) {
      return fail(`Azure DevOps server error (HTTP ${status}).${said}`, "server");
    }
    return fail(`Unexpected response from Azure DevOps (HTTP ${status}).${said}`, "unexpected_response");
  }

  private networkError(err: unknown, url: string): AzdoError {
    const host = new URL(url).host;
    const name = typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return new AzdoError(`Request to ${host} timed out.`, "timeout");
    }

    const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
    const code = typeof cause?.code === "string" ? cause.code : undefined;
    const detail =
      code ?? (typeof cause?.message === "string" ? cause.message : err instanceof Error ? err.message : String(err));

    let hint = "";
    if (code && TLS_ERROR_CODES.has(code)) {
      hint =
        " The server certificate is not trusted by Node. For self-signed on-prem certificates set AZURE_DEVOPS_ALLOW_INSECURE_TLS=true (insecure) or add the CA via NODE_EXTRA_CA_CERTS.";
    } else if (code && REACHABILITY_ERROR_CODES.has(code)) {
      hint = " Check AZURE_DEVOPS_URL and that the server is reachable from this machine.";
    }
    return new AzdoError(`Could not reach ${host}: ${detail}.${hint}`, "network");
  }
}
