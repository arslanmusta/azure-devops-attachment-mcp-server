#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AttachmentService } from "./attachments.js";
import { AzdoClient } from "./azdo-client.js";
import { loadConfig, type Config } from "./config.js";
import { ConfigError } from "./errors.js";
import { log } from "./log.js";
import { createServer } from "./server.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

function readConfig(): Config | undefined {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error(`Configuration error: ${err.message}`);
      // Let the process drain stderr and exit on its own (process.exit can truncate pipe output on macOS).
      process.exitCode = 1;
      return undefined;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  if (!config) return;

  if (config.allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    log.warn(
      `TLS certificate verification is DISABLED (AZURE_DEVOPS_ALLOW_INSECURE_TLS=true); traffic to ${new URL(config.baseUrl).host} can be intercepted.`,
    );
  }

  const service = new AttachmentService(new AzdoClient(config), config);
  const server = createServer(service);

  const shutdown = (signal: NodeJS.Signals): void => {
    log.info(`Received ${signal}, shutting down.`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  log.info(
    `${PACKAGE_NAME} ${PACKAGE_VERSION} started; collection=${config.baseUrl} apiVersion=${config.apiVersion} project=${config.defaultProject ?? "(none)"} downloadDir=${config.downloadDir}`,
  );
}

main().catch((err: unknown) => {
  log.error("Fatal error during startup", err);
  process.exitCode = 1;
});
