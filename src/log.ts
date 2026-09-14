/**
 * Logger for a stdio MCP server: everything goes to stderr, never stdout,
 * because stdout carries the JSON-RPC protocol stream.
 */
const PREFIX = "[azdo-attachments]";

function write(line: string): void {
  process.stderr.write(`${PREFIX} ${line}\n`);
}

function describeError(err: unknown): string {
  if (err === undefined) return "";
  if (err instanceof Error) {
    return `: ${err.message}${err.stack ? `\n${err.stack}` : ""}`;
  }
  return `: ${String(err)}`;
}

export const log = {
  info(message: string): void {
    write(message);
  },
  warn(message: string): void {
    write(`WARN ${message}`);
  },
  error(message: string, err?: unknown): void {
    write(`ERROR ${message}${describeError(err)}`);
  },
};
