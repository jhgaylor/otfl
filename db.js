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

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    github_id     INTEGER UNIQUE NOT NULL,
    login         TEXT NOT NULL,
    name          TEXT,
    avatar_url    TEXT,
    created_at    TEXT NOT NULL,
    last_login_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// Migration: add lists.owner_id (nullable; NULL = anonymous/open). Existing
// rows stay anonymous, which is the correct legacy behavior.
const listCols = db.prepare("PRAGMA table_info(lists)").all();
if (!listCols.some((c) => c.name === "owner_id")) {
  db.exec(
    "ALTER TABLE lists ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE SET NULL"
  );
}
db.exec("CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists(owner_id)");

const now = () => new Date().toISOString();

// ---- prepared statements ----
const stmts = {
  insertList: db.prepare(
    "INSERT INTO lists (id, title, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ),
  getList: db.prepare("SELECT * FROM lists WHERE id = ?"),
  setOwner: db.prepare(
    "UPDATE lists SET owner_id = ?, updated_at = ? WHERE id = ?"
  ),
  listsByOwner: db.prepare(
    `SELECT l.*,
            (SELECT COUNT(*) FROM items WHERE list_id = l.id) AS item_count,
            (SELECT COUNT(*) FROM items WHERE list_id = l.id AND checked = 1) AS done_count
     FROM lists l WHERE l.owner_id = ? ORDER BY l.updated_at DESC`
  ),

  upsertUser: db.prepare(
    `INSERT INTO users (id, github_id, login, name, avatar_url, created_at, last_login_at)
     VALUES (@id, @github_id, @login, @name, @avatar_url, @created_at, @last_login_at)
     ON CONFLICT(github_id) DO UPDATE SET
       login = excluded.login,
       name = excluded.name,
       avatar_url = excluded.avatar_url,
       last_login_at = excluded.last_login_at`
  ),
  userByGithubId: db.prepare("SELECT * FROM users WHERE github_id = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),

  insertSession: db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ),
  sessionUser: db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`
  ),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
  deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
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

function serializeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    login: row.login,
    name: row.name,
    avatar_url: row.avatar_url,
  };
}

function serializeList(row, items) {
  const owner = row.owner_id ? serializeUser(stmts.userById.get(row.owner_id)) : null;
  return {
    id: row.id,
    title: row.title,
    owner_id: row.owner_id || null,
    owner, // {id, login, name, avatar_url} or null (anonymous)
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: items.map(serializeItem),
  };
}

// ---- public data API ----

function createList({ title, items, ownerId } = {}) {
  const id = randomUUID();
  const ts = now();
  const listTitle =
    typeof title === "string" && title.trim() ? title.trim() : "Untitled list";

  const tx = db.transaction(() => {
    stmts.insertList.run(id, listTitle, ownerId || null, ts, ts);
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

// Returns the raw lists row (with owner_id) without loading items — used for
// authorization checks before doing work.
function getListMeta(id) {
  return stmts.getList.get(id) || null;
}

// Set or clear a list's owner. ownerId null releases it back to anonymous.
function setListOwner(listId, ownerId) {
  const row = stmts.getList.get(listId);
  if (!row) return null;
  stmts.setOwner.run(ownerId || null, now(), listId);
  return getList(listId);
}

function listsForOwner(ownerId) {
  return stmts.listsByOwner.all(ownerId).map((r) => ({
    id: r.id,
    title: r.title,
    item_count: r.item_count,
    done_count: r.done_count,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

// ---- users & sessions ----

function upsertUser({ githubId, login, name, avatarUrl }) {
  const existing = stmts.userByGithubId.get(githubId);
  const ts = now();
  stmts.upsertUser.run({
    id: existing ? existing.id : randomUUID(),
    github_id: githubId,
    login,
    name: name || null,
    avatar_url: avatarUrl || null,
    created_at: existing ? existing.created_at : ts,
    last_login_at: ts,
  });
  return serializeUser(stmts.userByGithubId.get(githubId));
}

function createSession(userId, ttlMs) {
  const token = require("crypto").randomBytes(32).toString("hex");
  const ts = now();
  const expires = new Date(Date.now() + ttlMs).toISOString();
  stmts.deleteExpiredSessions.run(ts);
  stmts.insertSession.run(token, userId, ts, expires);
  return { token, expires };
}

function getSessionUser(token) {
  if (!token) return null;
  return serializeUser(stmts.sessionUser.get(token, now()));
}

function deleteSession(token) {
  if (token) stmts.deleteSession.run(token);
}

module.exports = {
  db,
  createList,
  getList,
  getListMeta,
  updateList,
  deleteList,
  setListOwner,
  listsForOwner,
  addItem,
  updateItem,
  deleteItem,
  clearChecked,
  upsertUser,
  createSession,
  getSessionUser,
  deleteSession,
};
