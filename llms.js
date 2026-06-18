"use strict";

// Rendered at GET /llms.txt. Point an assistant at <base>/llms.txt and it has
// everything needed to drive the API. https://llmstxt.org/ format.
function llmsTxt(base) {
  return `# OTFL — On The Fly List

> OTFL is a free, open, no-account service for creating shareable checklists.
> Each list has a UUID. Knowing the id is the only credential: anyone with the
> id can read and modify the list. There are no users, owners, or auth tokens.
> Treat a list id like a secret if you want the list to stay private.

Base URL: ${base}
Content type: application/JSON for all request and response bodies.
No authentication. No rate-limit headers today — be reasonable.

## MCP server (recommended for assistants)

OTFL speaks the Model Context Protocol over Streamable HTTP at:

    ${base}/mcp

It is stateless — just POST JSON-RPC (no session needed). Add it to an MCP
client config, e.g.:

\`\`\`json
{ "mcpServers": { "otfl": { "type": "http", "url": "${base}/mcp" } } }
\`\`\`

Tools: create_list, get_list, rename_list, delete_list, add_item, update_item,
toggle_item, delete_item, clear_checked. create_list/get_list return a
share_url you can hand to the user. If you can use MCP, prefer it over the raw
HTTP API below.

## Quickstart

Create a list with two items, then check the first one off:

\`\`\`
curl -s -X POST ${base}/api/lists \\
  -H 'content-type: application/json' \\
  -d '{"title":"Camping trip","items":["Tent","Headlamp"]}'
# -> {"id":"<LIST_ID>", "title":"Camping trip", "items":[{"id":"<ITEM_ID>",...}]}

curl -s -X POST ${base}/api/lists/<LIST_ID>/items/<ITEM_ID>/toggle
\`\`\`

Share the list by giving someone this URL: ${base}/l/<LIST_ID>

## Data model

list:
  id          string (uuid)   — the shareable key
  title       string
  created_at  string (ISO 8601)
  updated_at  string (ISO 8601)
  items       item[]

item:
  id          string (uuid)
  list_id     string (uuid)
  text        string
  checked     boolean
  position    integer         — sort order, ascending
  created_at  string (ISO 8601)
  updated_at  string (ISO 8601)

## Endpoints

POST   /api/lists
  Create a list. Body: { "title"?: string, "items"?: (string | {text,checked})[] }
  Returns 201 with the full list object.

GET    /api/lists/{id}
  Fetch a list and its items. 404 if the id is unknown.

PATCH  /api/lists/{id}
  Rename a list. Body: { "title": string }. Returns the full list.

DELETE /api/lists/{id}
  Delete a list and all its items. Returns 204.

POST   /api/lists/{id}/items
  Add an item. Body: { "text": string, "checked"?: boolean }. Returns 201 with the item.

PATCH  /api/lists/{id}/items/{itemId}
  Update an item. Body: any of { "text": string, "checked": boolean, "position": integer }.
  Returns the updated item.

POST   /api/lists/{id}/items/{itemId}/toggle
  Flip an item's checked state. Returns the updated item.

DELETE /api/lists/{id}/items/{itemId}
  Remove a single item. Returns 204.

POST   /api/lists/{id}/clear-checked
  Remove every checked item from the list. Returns { "removed": integer }.

GET    /healthz
  Liveness probe. Returns { "ok": true }.

## Notes for assistants

- A list id is unguessable (UUID v4) but unencrypted in transit only over HTTPS — use the https URL.
- There is no "undo". DELETE is permanent.
- To build a checklist for a user: POST /api/lists once, keep the returned id,
  then add/toggle items against it. Hand the user ${base}/l/{id} to view it.
`;
}

module.exports = { llmsTxt };
