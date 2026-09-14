import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const SECRET = "pat-value-that-must-never-leak-2b9d";
const baseEnv = { PATH: process.env.PATH ?? "" };
const validEnv = {
  ...baseEnv,
  AZURE_DEVOPS_URL: "https://tfs.example.local/tfs/DefaultCollection",
  AZURE_DEVOPS_PAT: SECRET,
};
const run = promisify(execFile);

interface ExecFailure {
  code: number;
  stdout: string;
  stderr: string;
}

async function connectBin(env: Record<string, string>): Promise<{ client: Client; stderr: () => string }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env, stderr: "pipe" });
  const client = new Client({ name: "bin-test", version: "0.0.0" });
  await client.connect(transport);
  let captured = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    captured += chunk.toString();
  });
  return { client, stderr: () => captured };
}

describe("bin: dist/index.js", () => {
  it("starts with a node shebang", async () => {
    const firstLine = (await readFile(BIN, "utf8")).split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("exits with code 1 naming the missing variable, writes nothing to stdout and never leaks the PAT", async () => {
    const failure = (await run(process.execPath, [BIN], { env: { ...baseEnv, AZURE_DEVOPS_PAT: SECRET } }).then(
      () => {
        throw new Error("expected the process to fail");
      },
      (err: unknown) => err,
    )) as ExecFailure;

    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toMatch(/AZURE_DEVOPS_URL/);
    expect(failure.stderr).not.toContain(SECRET);
  });

  it("serves the four tools over stdio when configured", async () => {
    const { client, stderr } = await connectBin(validEnv);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "add_attachment",
        "delete_attachment",
        "download_attachment",
        "list_attachments",
      ]);
      expect(stderr()).not.toContain(SECRET);
    } finally {
      await client.close();
    }
  });

  it("warns on stderr when TLS verification is disabled", async () => {
    const { client, stderr } = await connectBin({ ...validEnv, AZURE_DEVOPS_ALLOW_INSECURE_TLS: "true" });
    try {
      await client.listTools();
      expect(stderr()).toMatch(/TLS certificate verification is DISABLED/);
    } finally {
      await client.close();
    }
  });
});
