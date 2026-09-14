# Design notes

This document captures the decisions behind `azure-devops-attachment-mcp-server` so contributors can
change it without re-deriving them.

## Goal

Give MCP clients four attachment operations (list, add, delete, download) against **on-premise Azure
DevOps Server** with the smallest possible footprint: `npx` start-up, PAT authentication, no live
server needed for tests.

## Decisions

| Topic | Decision | Why |
| --- | --- | --- |
| HTTP client | Node built-in `fetch` behind a thin `AzdoClient` | No extra dependency, trivially injectable in tests. The official `azure-devops-node-api` would only pay off for NTLM. |
| Auth | PAT as Basic auth (`:` + PAT, base64) | Works on every supported server version; NTLM is out of scope. |
| API version | `7.0` default, overridable | Server 2022 speaks 7.0; 2020 = 6.0, 2019 = 5.0. The attachment endpoints exist in all of them. |
| Work item addressing | Collection level (`{collection}/_apis/wit/workitems/{id}`) | Ids are unique per collection, so no project is needed to read or patch. |
| Project resolution | argument, then `System.TeamProject`, then `AZURE_DEVOPS_PROJECT` | The attachment endpoints are project scoped in newer versions; the work item knows its project. |
| Download URL | Rebuilt from the configured collection URL | Relation URLs may carry an internal host name; users connect through the public one. |
| Delete semantics | Remove the `AttachedFile` relation | Azure DevOps has no endpoint to delete attachment blobs; the web UI does the same. |
| Concurrency | `test /rev` guard + one refetch-and-retry | Cheap protection against concurrent edits; the retry recomputes the relation index. |
| Upload body | `Buffer` (not a stream) | Gives a proper `Content-Length`; IIS handles chunked transfer poorly for this endpoint. The 130 MB simple-upload limit bounds memory. |
| Download body | Streamed to disk | Constant memory; partial files are removed on failure. |
| Overwrite policy | Never; add ` (n)` suffix | An assistant calling the tool twice gets a usable path instead of an error. |
| Logging | stderr only | stdout is the MCP protocol stream. CI greps for `console.log(` in `src/`. |
| Build | `tsc` to `dist/`, ESM, shebang | An executable, not a library; bundling buys nothing. |

## Module map

```
src/index.ts        bin entry: config fail-fast, TLS opt-in, stdio transport, signals
src/server.ts       createServer(service): registerTool x4, text summaries, error guard
src/schemas.ts      zod input/output schemas shared by server and tests
src/attachments.ts  AttachmentService: list/add/delete/download, selector resolution, rev retry
src/azdo-client.ts  AzdoClient: URL building, headers, HTTP -> AzdoError mapping
src/fs-utils.ts     sanitizeFileName, openUnique, readLocalFile, saveStream
src/config.ts       loadConfig(env)
src/errors.ts       AzdoError, ToolInputError, ConfigError, formatToolError
src/log.ts          stderr logger
src/version.ts      package name/version from package.json
```

## Error model

`AzdoClient` turns every failure into an `AzdoError` with a `kind` (`auth`, `forbidden`, `not_found`,
`bad_request`, `conflict`, `too_large`, `server`, `network`, `timeout`, `unexpected_response`) and a
message that already contains the hint a user needs (which variable to check, how to trust a
self-signed certificate). `ToolInputError` covers caller mistakes (missing file, ambiguous name, missing
selector). `server.ts` converts both into `isError` tool results; unexpected errors are logged with their
stack to stderr and reported generically.

## Testing

- Unit tests inject a recording fake `fetch` and build real `Response` objects.
- `test/server.test.ts` drives the tools through the SDK `Client` over an in-memory transport.
- `test/bin.test.ts` spawns the built `dist/index.js` through `StdioClientTransport`; a vitest global
  setup builds `dist/` first.
- No test talks to a real server. Manual verification against a live instance: list, add a small file,
  download it twice (suffix), delete it.

## Out of scope

NTLM, chunked upload (> 130 MB), purging attachment blobs, work item CRUD (other MCP servers cover it),
HTTP transports.
