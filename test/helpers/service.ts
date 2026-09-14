import { AttachmentService, type ServiceConfig } from "../../src/attachments.js";
import { AzdoClient } from "../../src/azdo-client.js";
import { asFetch, type FakeFetch } from "./fake-fetch.js";
import { HOST } from "./fixtures.js";

export const GUID_A = "aaaaaaaa-1111-4222-8333-444455556666";
export const GUID_B = "bbbbbbbb-1111-4222-8333-444455556666";
export const GUID_C = "cccccccc-1111-4222-8333-444455556666";

export function service(fake: FakeFetch, config: Partial<ServiceConfig> = {}): AttachmentService {
  const client = new AzdoClient({ baseUrl: HOST, pat: "pat", apiVersion: "7.0" }, asFetch(fake));
  return new AttachmentService(client, { downloadDir: "/tmp/unused-by-default", ...config });
}
