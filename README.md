# azure-devops-attachment-mcp-server

[![CI](https://github.com/arslanmusta/azure-devops-attachment-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/arslanmusta/azure-devops-attachment-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/azure-devops-attachment-mcp-server)](https://www.npmjs.com/package/azure-devops-attachment-mcp-server)

An [MCP](https://modelcontextprotocol.io) server (stdio) that lets AI assistants manage **work item
attachments** on **on-premise Azure DevOps Server** (2019 / 2020 / 2022, formerly TFS) through the REST
API, authenticated with a Personal Access Token.

It exposes four tools:

| Tool | What it does |
| --- | --- |
| `list_attachments` | Lists the attachments of a work item (name, size, comment, date, id, URL). |
| `add_attachment` | Uploads a local file and attaches it to a work item. |
| `delete_attachment` | Removes an attachment from a work item by id or unique file name. |
| `download_attachment` | Saves an attachment to a local directory and returns the path. |

No extra dependencies beyond the MCP SDK and zod: it uses Node's built-in `fetch`, so `npx` starts fast.

## Requirements

- Node.js 20 or newer.
- A Personal Access Token (PAT) for the collection with the **Work Items (Read & Write)** scope.
- Network access from the machine running the MCP server to the Azure DevOps Server.

## Quick start

Add the server to your MCP client configuration. The generic JSON form (Claude Desktop, Cursor, Windsurf,
VS Code `mcp.json` and most other clients accept it):

```json
{
  "mcpServers": {
    "azure-devops-attachments": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "azure-devops-attachment-mcp-server"],
      "env": {
        "AZURE_DEVOPS_URL": "https://tfs.company.local/tfs/DefaultCollection",
        "AZURE_DEVOPS_PAT": "<your personal access token>",
        "AZURE_DEVOPS_PROJECT": "MyProject"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add azure-devops-attachments \
  -e AZURE_DEVOPS_URL=https://tfs.company.local/tfs/DefaultCollection \
  -e AZURE_DEVOPS_PAT=<your personal access token> \
  -e AZURE_DEVOPS_PROJECT=MyProject \
  -- npx -y azure-devops-attachment-mcp-server
```

Then ask your assistant things like:

- "List the attachments on work item 4711."
- "Attach `./reports/perf.xlsx` to bug 4711 with the comment 'perf run 2026-09'."
- "Download the attachment `spec.pdf` from work item 4711 into `~/Downloads`."
- "Remove the attachment `old-log.txt` from work item 4711."

## Configuration

All configuration is passed through environment variables.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `AZURE_DEVOPS_URL` | yes | | **Collection URL**, e.g. `https://tfs.company.local/tfs/DefaultCollection`. Include the `/tfs/<Collection>` path used by your server. |
| `AZURE_DEVOPS_PAT` | yes | | Personal Access Token. Sent only as a Basic auth header to `AZURE_DEVOPS_URL`; never logged. |
| `AZURE_DEVOPS_PROJECT` | no | | Default team project for the attachment endpoints. The work item's own project takes precedence when known. |
| `AZURE_DEVOPS_API_VERSION` | no | `7.0` | REST `api-version`. `7.0` = Azure DevOps Server 2022, `6.0` = 2020, `5.0` = 2019. |
| `AZURE_DEVOPS_DOWNLOAD_DIR` | no | process cwd | Directory where `download_attachment` saves files when no `outputDir` is given. |
| `AZURE_DEVOPS_ALLOW_INSECURE_TLS` | no | `false` | Set to `true` to accept self-signed certificates. Insecure; prefer `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. |

The server exits with code 1 and a message naming the missing variable when the configuration is incomplete.

## Tools

Every tool returns a short human-readable summary plus `structuredContent` matching the documented shape.
Errors come back as tool errors (`isError: true`) with an actionable message, for example which environment
variable to check after an HTTP 401.

### `list_attachments`

| Input | Type | Notes |
| --- | --- | --- |
| `workItemId` | integer | Required. |

Returns `{ workItemId, workItemRev, count, attachments[] }` where each attachment has
`{ id, name, size, comment, createdDate, url, relationIndex }`. `size` is `null` when the server does not
report it (older servers or migrated data).

### `add_attachment`

| Input | Type | Notes |
| --- | --- | --- |
| `workItemId` | integer | Required. |
| `filePath` | string | Required. Absolute or cwd-relative path of a local file (max 130 MB). |
| `fileName` | string | Optional. Name stored on the server; defaults to the file's base name. |
| `comment` | string | Optional. Comment shown next to the attachment. |
| `project` | string | Optional. Team project for the upload; defaults to the work item's project, then `AZURE_DEVOPS_PROJECT`. |

Returns `{ workItemId, workItemRev, attachment: { id, name, size, url, comment } }`.

### `delete_attachment`

| Input | Type | Notes |
| --- | --- | --- |
| `workItemId` | integer | Required. |
| `attachmentId` | GUID | One of `attachmentId` / `name` is required. |
| `name` | string | Exact file name; rejected with the candidate ids when several attachments share it. |

Returns `{ workItemId, workItemRev, removed: { id, name, relationIndex }, note }`. Only the link between the
work item and the file is removed; Azure DevOps has no REST endpoint that deletes the stored file itself
(this is also what the web UI does).

### `download_attachment`

| Input | Type | Notes |
| --- | --- | --- |
| `workItemId` | integer | Required. |
| `attachmentId` | GUID | One of `attachmentId` / `name` is required. |
| `name` | string | Exact file name; must be unique on the work item. |
| `fileName` | string | Optional. Local file name; defaults to the server-side name (sanitized). |
| `outputDir` | string | Optional. Defaults to `AZURE_DEVOPS_DOWNLOAD_DIR`, then the server's cwd. |
| `project` | string | Optional. Team project for the download URL. |

Returns `{ id, name, path, size, workItemId }` with the absolute path of the saved file. Existing files are
never overwritten: a ` (1)`, ` (2)`, ... suffix is added instead.

## How it maps to the REST API

| Tool | Calls |
| --- | --- |
| list | `GET {collection}/_apis/wit/workitems/{id}?$expand=relations` and filters `rel == "AttachedFile"`. |
| add | `POST {collection}/{project}/_apis/wit/attachments?fileName=...` (octet-stream), then `PATCH .../workitems/{id}` adding an `AttachedFile` relation, guarded by `test /rev`. |
| delete | `PATCH .../workitems/{id}` removing `/relations/{index}`, guarded by `test /rev`. |
| download | `GET {collection}/{project}/_apis/wit/attachments/{guid}?fileName=...&download=true`, streamed to disk. |

Details that matter on-premise:

- Work items are addressed at collection level, so a work item in any project of the collection works.
- Download URLs are rebuilt from `AZURE_DEVOPS_URL` instead of trusting the host inside the relation URL,
  which on some servers points at an internal name.
- `X-TFS-FedAuthRedirect: Suppress` is sent so a rejected PAT yields a clear 401 instead of a sign-in page.
- A failed `test /rev` (concurrent edit) triggers exactly one refetch-and-retry.

## Limitations

- Simple uploads only: files above 130 MB (chunked upload) are rejected with a clear message.
- PAT authentication only; NTLM / Windows integrated authentication is not supported.
- Deleting removes the attachment link; the blob stays on the server (no API exists to purge it).
- stdio transport only.

## Security notes

- The PAT is used solely as a Basic auth header for requests to `AZURE_DEVOPS_URL` and never appears in
  logs, tool output or error messages.
- Everything the server logs goes to stderr; stdout is reserved for the MCP protocol.
- Downloaded file names are sanitized (path separators, `..`, control characters) and files are written
  only inside the requested output directory.
- `AZURE_DEVOPS_ALLOW_INSECURE_TLS=true` disables certificate verification for the whole process. Use it only
  on trusted networks; adding your CA via `NODE_EXTRA_CA_CERTS` is the safer option.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Authentication failed (HTTP 401)` | PAT invalid, expired, created in another collection, or missing the Work Items (Read & Write) scope. |
| `returned a sign-in page instead of data` | Same as above, or `AZURE_DEVOPS_URL` is not the collection URL (missing `/tfs/DefaultCollection`). |
| `Could not reach ...: SELF_SIGNED_CERT_IN_CHAIN` | Self-signed certificate: set `NODE_EXTRA_CA_CERTS` or, less safely, `AZURE_DEVOPS_ALLOW_INSECURE_TLS=true`. |
| `Could not reach ...: ENOTFOUND` / `ECONNREFUSED` | Wrong host in `AZURE_DEVOPS_URL`, VPN not connected, or the server is down. |
| `TF401232: Work item ... does not exist` | Wrong id, or the PAT owner cannot read that work item. |
| `2 attachments named "..."` | Pass `attachmentId` (from `list_attachments`) instead of `name`. |

Run `npx @modelcontextprotocol/inspector npx -y azure-devops-attachment-mcp-server` with the environment
variables set to try the tools interactively.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit over src and tests
npm test            # vitest (builds dist/ first so the bin tests use the real entry point)
npm run build       # emits dist/
npm run inspect     # MCP Inspector against dist/index.js
```

Tests run against a fake `fetch`; no Azure DevOps Server is needed. See [docs/design.md](docs/design.md)
for the design notes.

### Releasing

1. Bump `version` in `package.json` and commit.
2. Tag it: `git tag v<version> && git push --tags`.
3. The `Publish to npm` workflow builds, tests and publishes with provenance. It needs an `NPM_TOKEN`
   repository secret (an npm automation token).

## License

[MIT](LICENSE)
