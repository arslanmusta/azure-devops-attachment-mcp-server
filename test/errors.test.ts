import { describe, expect, it } from "vitest";
import { AzdoError, ConfigError, ToolInputError, formatToolError } from "../src/errors.js";

describe("AzdoError", () => {
  it("carries kind, HTTP status and server typeKey", () => {
    const err = new AzdoError("Work item 999 does not exist", "not_found", 404, "WorkItemNotFoundException");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AzdoError");
    expect(err.kind).toBe("not_found");
    expect(err.status).toBe(404);
    expect(err.typeKey).toBe("WorkItemNotFoundException");
    expect(err.message).toBe("Work item 999 does not exist");
  });
});

describe("formatToolError", () => {
  it("returns AzdoError and ToolInputError messages verbatim (they already carry hints)", () => {
    expect(formatToolError(new AzdoError("Authentication failed (HTTP 401). Check AZURE_DEVOPS_PAT.", "auth", 401))).toBe(
      "Authentication failed (HTTP 401). Check AZURE_DEVOPS_PAT.",
    );
    expect(formatToolError(new ToolInputError("File not found: /tmp/x.txt"))).toBe("File not found: /tmp/x.txt");
    expect(formatToolError(new ConfigError("AZURE_DEVOPS_URL is required"))).toBe("AZURE_DEVOPS_URL is required");
  });

  it("wraps unknown Error instances so the caller sees it was unexpected", () => {
    expect(formatToolError(new TypeError("x is not a function"))).toBe("Unexpected error: x is not a function");
  });

  it("stringifies non-Error values", () => {
    expect(formatToolError("plain string")).toBe("Unexpected error: plain string");
    expect(formatToolError(undefined)).toBe("Unexpected error: undefined");
  });
});
