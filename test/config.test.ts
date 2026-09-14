import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/errors.js";
import { loadConfig } from "../src/config.js";

const SECRET = "pat-value-that-must-never-leak-8f3a";
const base = { AZURE_DEVOPS_URL: "https://tfs.company.local/tfs/DefaultCollection", AZURE_DEVOPS_PAT: SECRET };

describe("loadConfig", () => {
  it("fails fast when AZURE_DEVOPS_URL is missing, naming the variable", () => {
    expect(() => loadConfig({ AZURE_DEVOPS_PAT: SECRET })).toThrow(ConfigError);
    expect(() => loadConfig({ AZURE_DEVOPS_PAT: SECRET })).toThrow(/AZURE_DEVOPS_URL/);
  });

  it("fails fast when AZURE_DEVOPS_PAT is missing or blank", () => {
    expect(() => loadConfig({ AZURE_DEVOPS_URL: base.AZURE_DEVOPS_URL })).toThrow(/AZURE_DEVOPS_PAT/);
    expect(() => loadConfig({ AZURE_DEVOPS_URL: base.AZURE_DEVOPS_URL, AZURE_DEVOPS_PAT: "   " })).toThrow(/AZURE_DEVOPS_PAT/);
  });

  it("never includes the PAT value in error messages", () => {
    let message = "";
    try {
      loadConfig({ AZURE_DEVOPS_PAT: SECRET, AZURE_DEVOPS_URL: "not a url" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/AZURE_DEVOPS_URL/);
    expect(message).not.toContain(SECRET);
  });

  it("rejects a collection URL that is not http(s)", () => {
    expect(() => loadConfig({ ...base, AZURE_DEVOPS_URL: "ftp://tfs.local/tfs" })).toThrow(/AZURE_DEVOPS_URL/);
    expect(() => loadConfig({ ...base, AZURE_DEVOPS_URL: "tfs.company.local/tfs" })).toThrow(/AZURE_DEVOPS_URL/);
  });

  it("strips trailing slashes from the collection URL", () => {
    const cfg = loadConfig({ ...base, AZURE_DEVOPS_URL: "https://tfs.company.local/tfs/DefaultCollection///" });
    expect(cfg.baseUrl).toBe("https://tfs.company.local/tfs/DefaultCollection");
  });

  it("applies defaults: api-version 7.0, no default project, cwd as download dir, TLS verification on", () => {
    const cfg = loadConfig(base);
    expect(cfg.pat).toBe(SECRET);
    expect(cfg.apiVersion).toBe("7.0");
    expect(cfg.defaultProject).toBeUndefined();
    expect(cfg.downloadDir).toBe(process.cwd());
    expect(cfg.allowInsecureTls).toBe(false);
  });

  it("honours overrides and resolves the download dir to an absolute path", () => {
    const cfg = loadConfig({
      ...base,
      AZURE_DEVOPS_API_VERSION: "6.0",
      AZURE_DEVOPS_PROJECT: "MyProject",
      AZURE_DEVOPS_DOWNLOAD_DIR: "downloads/attachments",
    });
    expect(cfg.apiVersion).toBe("6.0");
    expect(cfg.defaultProject).toBe("MyProject");
    expect(cfg.downloadDir).toBe(path.resolve("downloads/attachments"));
  });

  it("treats blank optional values as unset", () => {
    const cfg = loadConfig({ ...base, AZURE_DEVOPS_PROJECT: "  ", AZURE_DEVOPS_API_VERSION: "" });
    expect(cfg.defaultProject).toBeUndefined();
    expect(cfg.apiVersion).toBe("7.0");
  });

  it.each(["1", "true", "TRUE", "yes", "Yes"])("enables insecure TLS for %s", (value) => {
    expect(loadConfig({ ...base, AZURE_DEVOPS_ALLOW_INSECURE_TLS: value }).allowInsecureTls).toBe(true);
  });

  it.each(["0", "false", "no", "", "anything-else"])("keeps TLS verification for %s", (value) => {
    expect(loadConfig({ ...base, AZURE_DEVOPS_ALLOW_INSECURE_TLS: value }).allowInsecureTls).toBe(false);
  });
});
