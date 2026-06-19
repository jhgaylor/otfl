"use strict";

// Stateless Streamable-HTTP MCP server embedded in the OTFL Express app.
// Each POST /mcp gets a fresh server + transport (no sessions), and the tools
// call the SQLite data layer (store) directly — no internal HTTP round-trip.
const {
  McpServer,
} = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const SERVER_INFO = { name: "otfl", version: "1.0.0" };

const INSTRUCTIONS = `OTFL ("On The Fly List") is an open, no-account checklist service.
Each list has a UUID; knowing the id is the only credential — there are no users or auth.
Use create_list to start a list (keep the returned id), then add/toggle/update items against it.
Hand the user the share_url from create_list/get_list so they can view the list in a browser.
There is no undo: delete_list and delete_item are permanent.`;

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function notFound(what) {
  return {
    isError: true,
    content: [{ type: "text", text: `${what} not found. Check the id.` }],
  };
}

// MCP is sessionless, so it can only act on anonymous (unowned) lists. Owned
// lists are private to a signed-in web user. Returns an error result if the
// list exists but is owned; null if it's accessible (or doesn't exist — the
// caller's own not-found handling covers that).
function ownershipBlock(store, listId) {
  const meta = store.getListMeta(listId);
  if (meta && meta.owner_id) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "This list is private to a signed-in OTFL user and can't be accessed over the API/MCP. MCP can only read and modify anonymous lists.",
        },
      ],
    };
  }
  return null;
}

// Build a fresh McpServer with all OTFL tools registered.
function buildServer(store, shareBase) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  const shareUrl = (id) =>
    shareBase ? `${shareBase.replace(/\/$/, "")}/l/${id}` : undefined;
  const withShare = (list) =>
    list ? { ...list, share_url: shareUrl(list.id) } : list;

  server.registerTool(
    "create_list",
    {
      title: "Create list",
      description:
        "Create a new list and return it (with its id and shareable share_url). Optionally seed a title and items.",
      inputSchema: {
        title: z.string().optional().describe("List title. Defaults to 'Untitled list'."),
        items: z
          .array(z.string())
          .optional()
          .describe("Initial item texts, in order."),
      },
    },
    async ({ title, items }) => ok(withShare(store.createList({ title, items }))),
  );

  server.registerTool(
    "get_list",
    {
      title: "Get list",
      description: "Fetch a list and all its items by id.",
      inputSchema: { list_id: z.string().describe("The list UUID.") },
    },
    async ({ list_id }) => {
      const blk = ownershipBlock(store, list_id);
      if (blk) return blk;
      const list = store.getList(list_id);
      return list ? ok(withShare(list)) : notFound("List");
    },
  );

  server.registerTool(
    "rename_list",
    {
      title: "Rename list",
      description: "Change a list's title.",
      inputSchema: {
        list_id: z.string().describe("The list UUID."),
        title: z.string().describe("The new title."),
      },
    },
    async ({ list_id, title }) => {
      const blk = ownershipBlock(store, list_id);
      if (blk) return blk;
      const list = store.updateList(list_id, { title });
      return list ? ok(withShare(list)) : notFound("List");
    },
  );

  server.registerTool(
    "delete_list",
    {
      title: "Delete list",
      description: "Permanently delete a list and all its items. Cannot be undone.",
      inputSchema: { list_id: z.string().describe("The list UUID.") },
    },
    async ({ list_id }) => {
      const blk = ownershipBlock(store, list_id);
      if (blk) return blk;
      return store.deleteList(list_id)
        ? ok({ deleted: true, list_id })
        : notFound("List");
    },
  );

  server.registerTool(
    "add_item",
    {
      title: "Add item",
      description: "Add an item to a list. Returns the created item.",
      inputSchema: {
        list_id: z.string().describe("The list UUID."),
        text: z.string().describe("The item text."),
        checked: z.boolean().optional().describe("Start checked. Defaults to false."),
      },
    },
    async ({ list_id, text, checked }) => {
      const blk = ownershipBlock(store, list_id);
      if (blk) return blk;
      const result = store.addItem(list_id, { text, checked });
      if (result.error === "not_found") return notFound("List");
      if (result.error)
        return { isError: true, content: [{ type: "text", text: result.message || result.error }] };
      return ok(result.item);
    },
  );

  server.registerTool(
    "update_item",
    {
      title: "Update item",
      description: "Update an item's text and/or checked state. Returns the updated item.",
      inputSchema: {
        list_id: z.string().describe("The list UUID."),
        item_id: z.string().describe("The item UUID."),
        text: z.string().optional().describe("New text."),
        checked: z.boolean().optional().describe("New checked state."),
      },
    },
    async ({ list_id, item_id, text, checked }) => {
      const blk = ownershipBlock(store, list_id);
      if (blk) return blk;
      const item = store.updateItem(list_id, item_id, { text, checked });
      return item ? ok(item) : notFound("Item");
    },
  );

  server.registerTool(
    "toggle_item",
    {
      title: "Toggle item",
      description: "Flip an item's checked state. Returns the updated item.",
      inputSchema: {
        list_id: z.string().describe("The list UUID."),
        item_id: z.string().describe("The item UUID."),
      },
    },
    async ({ list_id, item_id }) => {
      const blk = ownershipBlock(store, list_id);
      if (blk) return blk;
      const list = store.getList(list_id);
      if (!list) return notFound("List");
      const found = list.items.find((i) => i.id === item_id);
      if (!found) return notFound("Item");
      return ok(store.updateItem(list_id, item_id, { checked: !found.checked }));
    },
  );

  server.registerTool(
    "delete_item",
    {
      title: "Delete item",
      description: "Remove a single item from a list. Cannot be undone.",
      inputSchema: {
        list_id: z.string().describe("The list UUID."),
        item_id: z.string().describe("The item UUID."),
      },
    },
    async ({ list_id, item_id }) => {
      const blk = ownershipBlock(store, list_id);
      if (blk) return blk;
      return store.deleteItem(list_id, item_id)
        ? ok({ deleted: true, item_id })
        : notFound("Item");
    },
  );

  server.registerTool(
    "clear_checked",
    {
      title: "Clear checked items",
      description: "Remove every checked item from a list. Returns how many were removed.",
      inputSchema: { list_id: z.string().describe("The list UUID.") },
    },
    async ({ list_id }) => {
      const blk = ownershipBlock(store, list_id);
      if (blk) return blk;
      const result = store.clearChecked(list_id);
      return result ? ok(result) : notFound("List");
    },
  );

  return server;
}

// Returns an Express handler for POST /mcp (stateless).
function mcpPostHandler(store, shareBase) {
  return async function (req, res) {
    const server = buildServer(store, shareBase);
    const transport = new StreamableHTTPServerTransport({
      // Stateless: a new transport per request, no session tracking.
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };
}

// GET/DELETE aren't used in stateless mode — reply with a JSON-RPC error.
function mcpMethodNotAllowed(_req, res) {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. This MCP endpoint is stateless; use POST." },
    id: null,
  });
}

module.exports = { mcpPostHandler, mcpMethodNotAllowed };
