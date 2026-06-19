"use strict";

const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const store = require("./db");
const { llmsTxt } = require("./llms");
const { mcpPostHandler, mcpMethodNotAllowed } = require("./mcp");
const { loadUser, mountAuth } = require("./auth");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());
app.use(loadUser);

const PORT = process.env.PORT || 8080;
// PUBLIC_URL is used to render absolute URLs in llms.txt. Falls back to the
// request's own origin when unset.
const PUBLIC_URL = process.env.PUBLIC_URL || "";

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.headers.host}`;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Access control
//
// Anonymous lists (owner_id null) are fully open — anyone with the id can read
// and write (the original "knowing the id is the magic" model). Owned lists are
// private to the owner: a non-owner gets 403, an unauthenticated request gets
// 401. Unknown ids get 404. Returns the list row on success.
// ---------------------------------------------------------------------------
function authorizeList(req, res) {
  const row = store.getListMeta(req.params.id);
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (row.owner_id) {
    if (!req.user) {
      res.status(401).json({ error: "auth_required" });
      return null;
    }
    if (req.user.id !== row.owner_id) {
      res.status(403).json({ error: "forbidden" });
      return null;
    }
  }
  return row;
}

const withOwnership = (req, list) =>
  list ? { ...list, owned_by_me: !!(req.user && list.owner_id === req.user.id) } : list;

const api = express.Router();

api.post("/lists", (req, res) => {
  const { title, items, anonymous } = req.body || {};
  // Signed-in users get a private, tracked list by default. Pass
  // anonymous:true to make an open, shareable list even while signed in.
  const ownerId = req.user && !anonymous ? req.user.id : null;
  const list = store.createList({ title, items, ownerId });
  res.status(201).json(withOwnership(req, list));
});

api.get("/lists/:id", (req, res) => {
  if (!authorizeList(req, res)) return;
  res.json(withOwnership(req, store.getList(req.params.id)));
});

api.patch("/lists/:id", (req, res) => {
  if (!authorizeList(req, res)) return;
  res.json(withOwnership(req, store.updateList(req.params.id, req.body || {})));
});

api.delete("/lists/:id", (req, res) => {
  if (!authorizeList(req, res)) return;
  store.deleteList(req.params.id);
  res.status(204).end();
});

// Claim an anonymous list (must be signed in). Once claimed it becomes private.
api.post("/lists/:id/claim", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "auth_required" });
  const row = store.getListMeta(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.owner_id && row.owner_id !== req.user.id)
    return res.status(403).json({ error: "forbidden", message: "Already owned by someone else." });
  const list = store.setListOwner(req.params.id, req.user.id);
  res.json(withOwnership(req, list));
});

// Release ownership back to anonymous/open (owner only).
api.post("/lists/:id/release", (req, res) => {
  if (!authorizeList(req, res)) return;
  const row = store.getListMeta(req.params.id);
  if (!row.owner_id) return res.json(withOwnership(req, store.getList(req.params.id)));
  const list = store.setListOwner(req.params.id, null);
  res.json(withOwnership(req, list));
});

api.post("/lists/:id/items", (req, res) => {
  if (!authorizeList(req, res)) return;
  const result = store.addItem(req.params.id, req.body || {});
  if (result.error)
    return res.status(400).json({ error: result.error, message: result.message });
  res.status(201).json(result.item);
});

api.patch("/lists/:id/items/:itemId", (req, res) => {
  if (!authorizeList(req, res)) return;
  const item = store.updateItem(req.params.id, req.params.itemId, req.body || {});
  if (!item) return res.status(404).json({ error: "not_found" });
  res.json(item);
});

api.post("/lists/:id/items/:itemId/toggle", (req, res) => {
  if (!authorizeList(req, res)) return;
  const current = store.getList(req.params.id);
  const found = current.items.find((i) => i.id === req.params.itemId);
  if (!found) return res.status(404).json({ error: "not_found" });
  const item = store.updateItem(req.params.id, req.params.itemId, {
    checked: !found.checked,
  });
  res.json(item);
});

api.delete("/lists/:id/items/:itemId", (req, res) => {
  if (!authorizeList(req, res)) return;
  const ok = store.deleteItem(req.params.id, req.params.itemId);
  if (!ok) return res.status(404).json({ error: "not_found" });
  res.status(204).end();
});

api.post("/lists/:id/clear-checked", (req, res) => {
  if (!authorizeList(req, res)) return;
  res.json(store.clearChecked(req.params.id));
});

// Dashboard: lists owned by the signed-in user.
api.get("/my/lists", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "auth_required" });
  res.json({ lists: store.listsForOwner(req.user.id) });
});

app.use("/api", api);

// Auth routes (/auth/github, /auth/github/callback, /auth/logout, /api/me)
mountAuth(app, PUBLIC_URL);

// ---------------------------------------------------------------------------
// MCP — stateless Streamable HTTP endpoint for AI assistants
// ---------------------------------------------------------------------------
app.post("/mcp", mcpPostHandler(store, PUBLIC_URL));
app.get("/mcp", mcpMethodNotAllowed);
app.delete("/mcp", mcpMethodNotAllowed);

// ---------------------------------------------------------------------------
// llms.txt — teach an assistant how to use the service
// ---------------------------------------------------------------------------
app.get("/llms.txt", (req, res) => {
  res.type("text/plain; charset=utf-8").send(llmsTxt(baseUrl(req)));
});

// ---------------------------------------------------------------------------
// Frontend (static + client-routed list pages)
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// /l/:id renders the same SPA shell; the client reads the id from the path.
app.get(["/l/:id", "/l/:id/*"], (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "list.html"));
});

// Dashboard shell — the client fetches /api/my/lists and handles the
// signed-out state.
app.get("/mine", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "mine.html"));
});

app.use((_req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
});

app.listen(PORT, () => {
  console.log(`OTFL listening on :${PORT}`);
});
