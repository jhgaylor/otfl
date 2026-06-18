"use strict";

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { randomUUID } = require("crypto");

// DATA_DIR holds the SQLite file. In the container this is a mounted PVC.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "otfl.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS lists (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT 'Untitled list',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS items (
    id          TEXT PRIMARY KEY,
    list_id     TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    checked     INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id, position, created_at);
`);

const now = () => new Date().toISOString();

// ---- prepared statements ----
const stmts = {
  insertList: db.prepare(
    "INSERT INTO lists (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
  ),
  getList: db.prepare("SELECT * FROM lists WHERE id = ?"),
  updateListTitle: db.prepare(
    "UPDATE lists SET title = ?, updated_at = ? WHERE id = ?"
  ),
  touchList: db.prepare("UPDATE lists SET updated_at = ? WHERE id = ?"),
  deleteList: db.prepare("DELETE FROM lists WHERE id = ?"),

  itemsForList: db.prepare(
    "SELECT * FROM items WHERE list_id = ? ORDER BY position ASC, created_at ASC"
  ),
  maxPosition: db.prepare(
    "SELECT COALESCE(MAX(position), -1) AS max FROM items WHERE list_id = ?"
  ),
  insertItem: db.prepare(
    `INSERT INTO items (id, list_id, text, checked, position, created_at, updated_at)
     VALUES (@id, @list_id, @text, @checked, @position, @created_at, @updated_at)`
  ),
  getItem: db.prepare("SELECT * FROM items WHERE id = ? AND list_id = ?"),
  deleteItem: db.prepare("DELETE FROM items WHERE id = ? AND list_id = ?"),
  clearChecked: db.prepare(
    "DELETE FROM items WHERE list_id = ? AND checked = 1"
  ),
};

function serializeItem(row) {
  return {
    id: row.id,
    list_id: row.list_id,
    text: row.text,
    checked: !!row.checked,
    position: row.position,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeList(row, items) {
  return {
    id: row.id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: items.map(serializeItem),
  };
}

// ---- public data API ----

function createList({ title, items } = {}) {
  const id = randomUUID();
  const ts = now();
  const listTitle =
    typeof title === "string" && title.trim() ? title.trim() : "Untitled list";

  const tx = db.transaction(() => {
    stmts.insertList.run(id, listTitle, ts, ts);
    if (Array.isArray(items)) {
      items.forEach((raw, i) => {
        const text = typeof raw === "string" ? raw : raw && raw.text;
        if (typeof text !== "string" || !text.trim()) return;
        const checked = typeof raw === "object" && raw ? !!raw.checked : false;
        stmts.insertItem.run({
          id: randomUUID(),
          list_id: id,
          text: text.trim(),
          checked: checked ? 1 : 0,
          position: i,
          created_at: ts,
          updated_at: ts,
        });
      });
    }
  });
  tx();
  return getList(id);
}

function getList(id) {
  const row = stmts.getList.get(id);
  if (!row) return null;
  const items = stmts.itemsForList.all(id);
  return serializeList(row, items);
}

function updateList(id, { title }) {
  const row = stmts.getList.get(id);
  if (!row) return null;
  if (typeof title === "string" && title.trim()) {
    stmts.updateListTitle.run(title.trim(), now(), id);
  }
  return getList(id);
}

function deleteList(id) {
  const info = stmts.deleteList.run(id);
  return info.changes > 0;
}

function addItem(listId, { text, checked } = {}) {
  const list = stmts.getList.get(listId);
  if (!list) return { error: "not_found" };
  if (typeof text !== "string" || !text.trim()) {
    return { error: "invalid", message: "`text` is required" };
  }
  const ts = now();
  const position = stmts.maxPosition.get(listId).max + 1;
  const item = {
    id: randomUUID(),
    list_id: listId,
    text: text.trim(),
    checked: checked ? 1 : 0,
    position,
    created_at: ts,
    updated_at: ts,
  };
  stmts.insertItem.run(item);
  stmts.touchList.run(ts, listId);
  return { item: serializeItem(stmts.getItem.get(item.id, listId)) };
}

function updateItem(listId, itemId, { text, checked, position } = {}) {
  const row = stmts.getItem.get(itemId, listId);
  if (!row) return null;
  const ts = now();
  const next = {
    text:
      typeof text === "string" && text.trim() ? text.trim() : row.text,
    checked: checked === undefined ? row.checked : checked ? 1 : 0,
    position:
      Number.isInteger(position) ? position : row.position,
  };
  db.prepare(
    "UPDATE items SET text = ?, checked = ?, position = ?, updated_at = ? WHERE id = ? AND list_id = ?"
  ).run(next.text, next.checked, next.position, ts, itemId, listId);
  stmts.touchList.run(ts, listId);
  return serializeItem(stmts.getItem.get(itemId, listId));
}

function deleteItem(listId, itemId) {
  const info = stmts.deleteItem.run(itemId, listId);
  if (info.changes > 0) stmts.touchList.run(now(), listId);
  return info.changes > 0;
}

function clearChecked(listId) {
  const list = stmts.getList.get(listId);
  if (!list) return null;
  const info = stmts.clearChecked.run(listId);
  stmts.touchList.run(now(), listId);
  return { removed: info.changes };
}

module.exports = {
  db,
  createList,
  getList,
  updateList,
  deleteList,
  addItem,
  updateItem,
  deleteItem,
  clearChecked,
};
