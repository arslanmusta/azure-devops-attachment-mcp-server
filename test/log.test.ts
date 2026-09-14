import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log.js";

function silenceStreams() {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return { stderr, stdout };
}

describe("log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes info messages to stderr with the server prefix", () => {
    const { stderr } = silenceStreams();
    log.info("started");
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]?.[0]).toBe("[azdo-attachments] started\n");
  });

  it("marks warn and error levels in the line", () => {
    const { stderr } = silenceStreams();
    log.warn("careful");
    log.error("failed");
    expect(stderr.mock.calls[0]?.[0]).toBe("[azdo-attachments] WARN careful\n");
    expect(stderr.mock.calls[1]?.[0]).toBe("[azdo-attachments] ERROR failed\n");
  });

  it("appends the message and stack of an Error passed to error()", () => {
    const { stderr } = silenceStreams();
    const err = new Error("boom");
    log.error("operation failed", err);
    const line = String(stderr.mock.calls[0]?.[0]);
    expect(line.startsWith("[azdo-attachments] ERROR operation failed: boom\n")).toBe(true);
    expect(line).toContain("Error: boom");
  });

  it("never writes to stdout (stdout is reserved for the MCP protocol)", () => {
    const { stdout } = silenceStreams();
    log.info("a");
    log.warn("b");
    log.error("c", new Error("d"));
    expect(stdout).not.toHaveBeenCalled();
  });
});
