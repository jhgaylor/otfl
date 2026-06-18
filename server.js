"use strict";

const path = require("path");
const express = require("express");
const store = require("./db");
const { llmsTxt } = require("./llms");
const { mcpPostHandler, mcpMethodNotAllowed } = require("./mcp");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

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
// API
// ---------------------------------------------------------------------------
const api = express.Router();

api.post("/lists", (req, res) => {
  const { title, items } = req.body || {};
  const list = store.createList({ title, items });
  res.status(201).json(list);
});

api.get("/lists/:id", (req, res) => {
  const list = store.getList(req.params.id);
  if (!list) return res.status(404).json({ error: "not_found" });
  res.json(list);
});

api.patch("/lists/:id", (req, res) => {
  const list = store.updateList(req.params.id, req.body || {});
  if (!list) return res.status(404).json({ error: "not_found" });
  res.json(list);
});

api.delete("/lists/:id", (req, res) => {
  const ok = store.deleteList(req.params.id);
  if (!ok) return res.status(404).json({ error: "not_found" });
  res.status(204).end();
});

api.post("/lists/:id/items", (req, res) => {
  const result = store.addItem(req.params.id, req.body || {});
  if (result.error === "not_found")
    return res.status(404).json({ error: "not_found" });
  if (result.error)
    return res.status(400).json({ error: result.error, message: result.message });
  res.status(201).json(result.item);
});

api.patch("/lists/:id/items/:itemId", (req, res) => {
  const item = store.updateItem(req.params.id, req.params.itemId, req.body || {});
  if (!item) return res.status(404).json({ error: "not_found" });
  res.json(item);
});

api.post("/lists/:id/items/:itemId/toggle", (req, res) => {
  const current = store.getList(req.params.id);
  if (!current) return res.status(404).json({ error: "not_found" });
  const found = current.items.find((i) => i.id === req.params.itemId);
  if (!found) return res.status(404).json({ error: "not_found" });
  const item = store.updateItem(req.params.id, req.params.itemId, {
    checked: !found.checked,
  });
  res.json(item);
});

api.delete("/lists/:id/items/:itemId", (req, res) => {
  const ok = store.deleteItem(req.params.id, req.params.itemId);
  if (!ok) return res.status(404).json({ error: "not_found" });
  res.status(204).end();
});

api.post("/lists/:id/clear-checked", (req, res) => {
  const result = store.clearChecked(req.params.id);
  if (!result) return res.status(404).json({ error: "not_found" });
  res.json(result);
});

app.use("/api", api);

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

app.use((_req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
});

app.listen(PORT, () => {
  console.log(`OTFL listening on :${PORT}`);
});
