import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolInputError } from "../src/errors.js";
import {
  MAX_SIMPLE_UPLOAD_BYTES,
  openUnique,
  readLocalFile,
  sanitizeFileName,
  saveStream,
} from "../src/fs-utils.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "azdo-fs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sanitizeFileName", () => {
  const fallback = "0f3c1d2e.bin";

  it("keeps only the last path segment to block traversal", () => {
    expect(sanitizeFileName("../../etc/passwd", fallback)).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\x\\report.txt", fallback)).toBe("report.txt");
    expect(sanitizeFileName("/abs/dir/", fallback)).toBe("dir");
  });

  it("falls back for empty, dot and dot-dot names", () => {
    expect(sanitizeFileName("", fallback)).toBe(fallback);
    expect(sanitizeFileName("   ", fallback)).toBe(fallback);
    expect(sanitizeFileName(".", fallback)).toBe(fallback);
    expect(sanitizeFileName("..", fallback)).toBe(fallback);
    expect(sanitizeFileName(undefined, fallback)).toBe(fallback);
  });

  it("replaces characters that are invalid on common file systems", () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.txt', fallback)).toBe("a_b_c_d_e_f_g_h.txt");
    expect(sanitizeFileName("tab\there\u0000null\u007f.log", fallback)).toBe("tab_here_null_.log");
  });

  it("preserves unicode letters and spaces", () => {
    expect(sanitizeFileName("rapor ğüşiöç 2026.pdf", fallback)).toBe("rapor ğüşiöç 2026.pdf");
  });

  it("caps very long names while keeping the extension", () => {
    const long = `${"x".repeat(300)}.tar.gz`;
    const out = sanitizeFileName(long, fallback);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith(".gz")).toBe(true);
  });
});

describe("openUnique", () => {
  it("creates the file when the name is free", async () => {
    const { path: p, handle } = await openUnique(dir, "a.txt");
    await handle.close();
    expect(p).toBe(path.join(dir, "a.txt"));
    expect((await stat(p)).isFile()).toBe(true);
  });

  it("appends a numeric suffix instead of overwriting", async () => {
    await writeFile(path.join(dir, "a.txt"), "original");
    const first = await openUnique(dir, "a.txt");
    await first.handle.close();
    const second = await openUnique(dir, "a.txt");
    await second.handle.close();

    expect(first.path).toBe(path.join(dir, "a (1).txt"));
    expect(second.path).toBe(path.join(dir, "a (2).txt"));
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("original");
  });

  it("creates missing parent directories", async () => {
    const nested = path.join(dir, "deep", "er");
    const { path: p, handle } = await openUnique(nested, "b.bin");
    await handle.close();
    expect(p).toBe(path.join(nested, "b.bin"));
  });
});

describe("readLocalFile", () => {
  it("reads the bytes and reports name, size and absolute path", async () => {
    const file = path.join(dir, "spec.pdf");
    await writeFile(file, "PDF-bytes");
    const result = await readLocalFile(file);
    expect(result.name).toBe("spec.pdf");
    expect(result.size).toBe(9);
    expect(result.absolutePath).toBe(file);
    expect(result.data.toString()).toBe("PDF-bytes");
  });

  it("throws ToolInputError for a missing file", async () => {
    const missing = path.join(dir, "nope.txt");
    await expect(readLocalFile(missing)).rejects.toThrow(ToolInputError);
    await expect(readLocalFile(missing)).rejects.toThrow(/File not found: .*nope\.txt/);
  });

  it("throws ToolInputError for a directory", async () => {
    await expect(readLocalFile(dir)).rejects.toThrow(/is a directory, not a file/);
  });

  it("rejects files above the simple-upload limit before reading them", async () => {
    const file = path.join(dir, "big.bin");
    await writeFile(file, Buffer.alloc(10));
    await expect(readLocalFile(file, { maxBytes: 5 })).rejects.toThrow(ToolInputError);
    await expect(readLocalFile(file, { maxBytes: 5 })).rejects.toThrow(/chunked upload is not implemented/);
    expect(MAX_SIMPLE_UPLOAD_BYTES).toBe(130 * 1024 * 1024);
  });
});

describe("saveStream", () => {
  function webStream(chunks: string[]): ReadableStream<Uint8Array> {
    return Readable.toWeb(Readable.from(chunks.map((c) => Buffer.from(c)))) as ReadableStream<Uint8Array>;
  }

  it("writes the stream to a uniquely named file and reports bytes written", async () => {
    const result = await saveStream(dir, "spec.pdf", webStream(["PDF-", "bytes"]));
    expect(result.path).toBe(path.join(dir, "spec.pdf"));
    expect(result.size).toBe(9);
    expect(await readFile(result.path, "utf8")).toBe("PDF-bytes");
  });

  it("does not overwrite an existing file", async () => {
    await writeFile(path.join(dir, "spec.pdf"), "old");
    const result = await saveStream(dir, "spec.pdf", webStream(["new"]));
    expect(result.path).toBe(path.join(dir, "spec (1).pdf"));
    expect(await readFile(path.join(dir, "spec.pdf"), "utf8")).toBe("old");
  });

  it("removes the partial file when the stream fails midway", async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("partial"));
        controller.error(new Error("connection reset"));
      },
    });
    await expect(saveStream(dir, "broken.bin", failing)).rejects.toThrow(/connection reset/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects a missing body", async () => {
    await expect(saveStream(dir, "x.bin", null)).rejects.toThrow(/empty response body/i);
    await mkdir(path.join(dir, "keep"));
    expect(await readdir(dir)).toEqual(["keep"]);
  });
});
