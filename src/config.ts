import path from "node:path";
import { ConfigError } from "./errors.js";

export interface Config {
  /** Collection URL without trailing slash, e.g. https://tfs.company.local/tfs/DefaultCollection */
  baseUrl: string;
  /** Personal Access Token. Never log or echo this. */
  pat: string;
  /** REST api-version query value, default 7.0 (Azure DevOps Server 2022). */
  apiVersion: string;
  /** Default team project for upload/download URLs when the caller does not pass one. */
  defaultProject?: string;
  /** Absolute directory where downloads are written. */
  downloadDir: string;
  /** Opt-in: disable TLS certificate verification (self-signed on-prem certificates). */
  allowInsecureTls: boolean;
}

const DEFAULT_API_VERSION = "7.0";
const TRUTHY = new Set(["1", "true", "yes"]);
const EXAMPLE_URL = "https://tfs.company.local/tfs/DefaultCollection";

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseCollectionUrl(raw: string | undefined): string {
  if (!raw) {
    throw new ConfigError(`AZURE_DEVOPS_URL is required: the collection URL, e.g. ${EXAMPLE_URL}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`AZURE_DEVOPS_URL is not a valid URL. Expected the collection URL, e.g. ${EXAMPLE_URL}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigError("AZURE_DEVOPS_URL must start with https:// or http://");
  }
  return raw.replace(/\/+$/, "");
}

/** Reads and validates configuration from environment variables. Throws ConfigError. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = parseCollectionUrl(optional(env.AZURE_DEVOPS_URL));

  const pat = optional(env.AZURE_DEVOPS_PAT);
  if (!pat) {
    throw new ConfigError(
      "AZURE_DEVOPS_PAT is required: a Personal Access Token with the 'Work Items (Read & Write)' scope",
    );
  }

  const downloadDir = optional(env.AZURE_DEVOPS_DOWNLOAD_DIR);

  return {
    baseUrl,
    pat,
    apiVersion: optional(env.AZURE_DEVOPS_API_VERSION) ?? DEFAULT_API_VERSION,
    defaultProject: optional(env.AZURE_DEVOPS_PROJECT),
    downloadDir: downloadDir ? path.resolve(downloadDir) : process.cwd(),
    allowInsecureTls: TRUTHY.has((env.AZURE_DEVOPS_ALLOW_INSECURE_TLS ?? "").trim().toLowerCase()),
  };
}
