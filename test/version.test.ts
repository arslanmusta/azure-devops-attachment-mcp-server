import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/version.js";

describe("version", () => {
  it("exposes the package name and version from package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      name: string;
      version: string;
    };
    expect(PACKAGE_NAME).toBe("azure-devops-attachment-mcp-server");
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
