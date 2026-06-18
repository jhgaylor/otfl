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

- **No users / no auth.** A list id (UUID v4) is the credential. Treat the link
  like a secret if you want the list to stay private.
- **One SQLite file** on a persistent volume. Single-writer, single-replica.
- **A static frontend** served by the same Express process.

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
