/** Categories of failures coming back from Azure DevOps or the network. */
export type AzdoErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "bad_request"
  | "conflict"
  | "too_large"
  | "server"
  | "network"
  | "timeout"
  | "unexpected_response";

/** A failed call to Azure DevOps. The message is already user-facing and carries a hint. */
export class AzdoError extends Error {
  override readonly name = "AzdoError";

  constructor(
    message: string,
    readonly kind: AzdoErrorKind,
    readonly status?: number,
    readonly typeKey?: string,
  ) {
    super(message);
  }
}

/** The caller supplied arguments that cannot be acted on (missing file, ambiguous name, ...). */
export class ToolInputError extends Error {
  override readonly name = "ToolInputError";
}

/** Startup configuration is missing or invalid. Messages name variables, never values. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Turns any thrown value into the single line shown to the MCP client. */
export function formatToolError(err: unknown): string {
  if (err instanceof AzdoError || err instanceof ToolInputError || err instanceof ConfigError) {
    return err.message;
  }
  if (err instanceof Error) {
    return `Unexpected error: ${err.message}`;
  }
  return `Unexpected error: ${String(err)}`;
}
