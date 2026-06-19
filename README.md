# OTFL — On The Fly List

Make a shareable checklist in one click. No accounts, no logins. Every list has
a UUID and **knowing the id is the only key** — anyone with the link can read it
and check things off. There's a small JSON API so assistants and scripts can
create and drive lists too.

Live at **https://otfl.inevitable.fyi** · API docs for humans and LLMs at
[`/llms.txt`](https://otfl.inevitable.fyi/llms.txt).

## Why

Sometimes you just want a list — for a trip, a shopping run, a "did everyone
pack their stuff" check — without signing up for anything or deciding who owns
it. OTFL is that: create, share the link, done.

## How it works

- **Anonymous lists are open.** A list id (UUID v4) is the credential — anyone
  with the link can view and edit. Treat the link like a secret.
- **Optional GitHub sign-in.** Sign in with GitHub to *own* lists: name them and
  track them on a "My lists" dashboard.
- **One SQLite file** on a persistent volume. Single-writer, single-replica.
- **A static frontend** served by the same Express process.

## Ownership model

| | Anonymous list (default) | Owned list (signed in) |
| --- | --- | --- |
| Who can open/edit | Anyone with the link | Only the owner |
| Visibility | Shareable by link | Private to the owner |
| Shows on dashboard | No | Yes (`/mine`) |
| Reachable via API/MCP | Yes | No (session-less) |

- Signed-in users create **private** lists by default; pass `anonymous: true` to
  `POST /api/lists` (or use "Create shared" in the UI) to make an open one.
- **Claim**: a signed-in user can claim any anonymous list (`POST /api/lists/{id}/claim`),
  which makes it private to them. **Release** (`/release`) turns it back into an
  open list.
- The JSON API and MCP server are session-less, so they only ever touch
  anonymous lists. Owned lists are reachable only through the owner's browser
  session (cookie).

GitHub sign-in is configured via `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.
If those env vars are unset, OTFL runs in anonymous-only mode and the sign-in
UI is hidden.

## API

Base URL: `https://otfl.inevitable.fyi`. All bodies are JSON.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/lists` | Create a list. Body: `{ title?, items? }` |
| `GET` | `/api/lists/{id}` | Fetch a list + items |
| `PATCH` | `/api/lists/{id}` | Rename. Body: `{ title }` |
| `DELETE` | `/api/lists/{id}` | Delete the list |
| `POST` | `/api/lists/{id}/items` | Add item. Body: `{ text, checked? }` |
| `PATCH` | `/api/lists/{id}/items/{itemId}` | Update `{ text?, checked?, position? }` |
| `POST` | `/api/lists/{id}/items/{itemId}/toggle` | Flip checked |
| `DELETE` | `/api/lists/{id}/items/{itemId}` | Remove an item |
| `POST` | `/api/lists/{id}/clear-checked` | Remove all checked items |
| `GET` | `/healthz` | Liveness probe |

```bash
# Create a list and check the first item off
curl -s -X POST https://otfl.inevitable.fyi/api/lists \
  -H 'content-type: application/json' \
  -d '{"title":"Camping trip","items":["Tent","Headlamp"]}'
```

The full, assistant-friendly reference is generated at
[`/llms.txt`](https://otfl.inevitable.fyi/llms.txt).

## MCP server

OTFL speaks the [Model Context Protocol](https://modelcontextprotocol.io) over
stateless Streamable HTTP at **`https://otfl.inevitable.fyi/mcp`** — point any
MCP client at it:

```json
{ "mcpServers": { "otfl": { "type": "http", "url": "https://otfl.inevitable.fyi/mcp" } } }
```

Tools: `create_list`, `get_list`, `rename_list`, `delete_list`, `add_item`,
`update_item`, `toggle_item`, `delete_item`, `clear_checked`. The
`create_list`/`get_list` tools return a `share_url` to hand to the user. The
server is stateless (no sessions), so it works behind the same single replica
as the web app.

## Develop

```bash
npm install
npm start          # http://localhost:8080
# data goes to ./data/otfl.db (override with DATA_DIR)
```

Env vars: `PORT` (default `8080`), `DATA_DIR` (default `./data`),
`PUBLIC_URL` (absolute base used in `llms.txt`).

## Deploy

Pushing to `main` triggers `.github/workflows/build.yml`, which builds a
multi-arch (amd64 + arm64) image and pushes `ghcr.io/jhgaylor/otfl:latest`.

The app runs on the [home-cloud](https://github.com/jhgaylor/home-cloud) k3s
cluster. Manifests live in [`k8s/`](k8s/) and are reconciled by Flux via
`clusters/home/apps/otfl.yaml` in that repo (Longhorn PVC, single replica with
`Recreate` strategy, Traefik IngressRoute, cert-manager TLS for
`otfl.inevitable.fyi`).

## License

MIT
