"use strict";

// Optional GitHub OAuth + cookie sessions. The whole module degrades
// gracefully: if GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET aren't set, OTFL runs
// in anonymous-only mode and the sign-in routes return a friendly notice.
const crypto = require("crypto");
const store = require("./db");

const CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const SESSION_COOKIE = "otfl_session";
const STATE_COOKIE = "otfl_oauth_state";
const SESSION_TTL_MS =
  (Number(process.env.SESSION_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;

const enabled = () => Boolean(CLIENT_ID && CLIENT_SECRET);

function cookieOpts(req, extra = {}) {
  const secure =
    (req.headers["x-forwarded-proto"] || req.protocol) === "https";
  return { httpOnly: true, sameSite: "lax", secure, path: "/", ...extra };
}

function callbackUrl(req, publicUrl) {
  const base = publicUrl
    ? publicUrl.replace(/\/$/, "")
    : `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers.host}`;
  return `${base}/auth/github/callback`;
}

// Express middleware: resolves req.user from the session cookie (or null).
function loadUser(req, _res, next) {
  const token = req.cookies ? req.cookies[SESSION_COOKIE] : undefined;
  req.user = token ? store.getSessionUser(token) : null;
  req.sessionToken = token || null;
  next();
}

// Mounts /auth/* routes and /api/me. `publicUrl` is used for the callback URL.
function mountAuth(app, publicUrl) {
  app.get("/auth/github", (req, res) => {
    if (!enabled()) {
      return res
        .status(503)
        .type("text/plain")
        .send("GitHub sign-in is not configured on this instance.");
    }
    const state = crypto.randomBytes(16).toString("hex");
    res.cookie(STATE_COOKIE, state, cookieOpts(req, { maxAge: 10 * 60 * 1000 }));
    // Optional post-login redirect target (e.g. back to a list page).
    const rd = typeof req.query.rd === "string" ? req.query.rd : "";
    if (rd && rd.startsWith("/")) {
      res.cookie("otfl_rd", rd, cookieOpts(req, { maxAge: 10 * 60 * 1000 }));
    }
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: callbackUrl(req, publicUrl),
      scope: "read:user",
      state,
      allow_signup: "true",
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });

  app.get("/auth/github/callback", async (req, res) => {
    if (!enabled()) return res.redirect("/");
    const { code, state } = req.query;
    const expected = req.cookies ? req.cookies[STATE_COOKIE] : undefined;
    res.clearCookie(STATE_COOKIE, cookieOpts(req));
    if (!code || !state || !expected || state !== expected) {
      return res.status(400).type("text/plain").send("OAuth state mismatch. Try again.");
    }
    try {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          redirect_uri: callbackUrl(req, publicUrl),
        }),
      });
      const tokenJson = await tokenRes.json();
      const accessToken = tokenJson.access_token;
      if (!accessToken) {
        return res.status(401).type("text/plain").send("GitHub did not grant a token.");
      }
      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "otfl",
        },
      });
      const gh = await userRes.json();
      if (!gh || !gh.id) {
        return res.status(401).type("text/plain").send("Could not read your GitHub profile.");
      }
      const user = store.upsertUser({
        githubId: gh.id,
        login: gh.login,
        name: gh.name,
        avatarUrl: gh.avatar_url,
      });
      const { token } = store.createSession(user.id, SESSION_TTL_MS);
      res.cookie(SESSION_COOKIE, token, cookieOpts(req, { maxAge: SESSION_TTL_MS }));

      let rd = req.cookies ? req.cookies["otfl_rd"] : "";
      res.clearCookie("otfl_rd", cookieOpts(req));
      if (!rd || !rd.startsWith("/")) rd = "/mine";
      res.redirect(rd);
    } catch (err) {
      console.error("OAuth callback error:", err);
      res.status(500).type("text/plain").send("Sign-in failed. Try again.");
    }
  });

  app.post("/auth/logout", (req, res) => {
    if (req.sessionToken) store.deleteSession(req.sessionToken);
    res.clearCookie(SESSION_COOKIE, cookieOpts(req));
    res.json({ ok: true });
  });

  app.get("/api/me", (req, res) => {
    res.json({ user: req.user || null, auth_enabled: enabled() });
  });
}

module.exports = { loadUser, mountAuth, authEnabled: enabled };
