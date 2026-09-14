import { mkdir, open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { ToolInputError } from "./errors.js";

/** Azure DevOps accepts simple (single request) uploads up to 130 MB; larger files need chunked upload. */
export const MAX_SIMPLE_UPLOAD_BYTES = 130 * 1024 * 1024;

const MAX_NAME_LENGTH = 200;
const MAX_UNIQUE_ATTEMPTS = 1000;
/** Characters invalid on Windows/macOS file systems, plus any Unicode control character (\p{Cc}). */
const INVALID_CHARS = /[<>:"|?*]|\p{Cc}/gu;

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function splitExt(name: string): { stem: string; ext: string } {
  const ext = path.extname(name);
  return { stem: name.slice(0, name.length - ext.length), ext };
}

/**
 * Reduces a server-supplied attachment name to a safe local file name:
 * last path segment only, invalid characters replaced, length capped.
 */
export function sanitizeFileName(name: string | null | undefined, fallback: string): string {
  if (!name) return fallback;
  const segments = name.replace(/\\/g, "/").split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? "";
  const cleaned = last.replace(INVALID_CHARS, "_").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return fallback;
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const { stem, ext } = splitExt(cleaned);
  return stem.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

/** Opens `name` inside `dir` for exclusive creation, adding " (n)" suffixes instead of overwriting. */
export async function openUnique(dir: string, name: string): Promise<{ path: string; handle: FileHandle }> {
  await mkdir(dir, { recursive: true });
  const { stem, ext } = splitExt(name);
  for (let attempt = 0; attempt < MAX_UNIQUE_ATTEMPTS; attempt++) {
    const candidate = path.join(dir, attempt === 0 ? name : `${stem} (${attempt})${ext}`);
    try {
      const handle = await open(candidate, "wx");
      return { path: candidate, handle };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new ToolInputError(`Could not find a free file name for "${name}" in ${dir} after ${MAX_UNIQUE_ATTEMPTS} attempts.`);
}

export interface LocalFile {
  absolutePath: string;
  name: string;
  size: number;
  data: Buffer;
}

/** Reads a local file for upload, failing early with a clear message when it is missing, a directory or too large. */
export async function readLocalFile(filePath: string, opts: { maxBytes?: number } = {}): Promise<LocalFile> {
  const maxBytes = opts.maxBytes ?? MAX_SIMPLE_UPLOAD_BYTES;
  const absolutePath = path.resolve(filePath);

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolutePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new ToolInputError(`File not found: ${absolutePath}`);
    if (code === "EACCES" || code === "EPERM") throw new ToolInputError(`Cannot read ${absolutePath}: permission denied.`);
    throw err;
  }
  if (info.isDirectory()) throw new ToolInputError(`${absolutePath} is a directory, not a file.`);
  if (info.size > maxBytes) {
    throw new ToolInputError(
      `File is ${formatMb(info.size)} MB; simple uploads are limited to ${formatMb(maxBytes)} MB and chunked upload is not implemented.`,
    );
  }

  const data = await readFile(absolutePath);
  return { absolutePath, name: path.basename(absolutePath), size: data.length, data };
}

/** Streams a response body to a uniquely named file in `dir`; removes the partial file if the stream fails. */
export async function saveStream(
  dir: string,
  name: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<{ path: string; size: number }> {
  if (!body) throw new ToolInputError("Empty response body: the server returned no attachment content.");

  const { path: target, handle } = await openUnique(dir, name);
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>), counter, handle.createWriteStream());
    return { path: target, size };
  } catch (err) {
    await unlink(target).catch(() => undefined);
    throw err;
  }
}
