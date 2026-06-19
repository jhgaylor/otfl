// Shared client-side auth header. Each page includes this and provides a
// <span id="auth-slot"></span> inside its nav. We fetch /api/me once, fill the
// slot, and broadcast the result so pages can react (e.g. show claim controls).
(function () {
  const GH_ICON =
    '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="currentColor" style="vertical-align:-2px"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

  async function render() {
    const slot = document.getElementById("auth-slot");
    let me = { user: null, auth_enabled: false };
    try {
      me = await (await fetch("/api/me")).json();
    } catch (_) {}
    window.__OTFL_ME = me;
    document.dispatchEvent(new CustomEvent("otfl:me", { detail: me }));

    if (!slot) return me;
    if (me.user) {
      slot.innerHTML =
        '<a class="authlink" href="/mine">My lists</a>' +
        '<a class="userchip" href="/mine" title="' +
        esc(me.user.name || me.user.login) +
        '"><img src="' +
        esc(me.user.avatar_url || "") +
        '" alt=""> ' +
        esc(me.user.login) +
        "</a>" +
        '<a class="authlink" href="#" id="otfl-signout">Sign out</a>';
      document
        .getElementById("otfl-signout")
        .addEventListener("click", async (e) => {
          e.preventDefault();
          await fetch("/auth/logout", { method: "POST" });
          location.href = "/";
        });
      return me;
    } else if (me.auth_enabled) {
      const rd = encodeURIComponent(location.pathname + location.search);
      slot.innerHTML =
        '<a class="authlink signin" href="/auth/github?rd=' +
        rd +
        '">' +
        GH_ICON +
        " Sign in</a>";
    }
    return me;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Promise pages can await to get /api/me without a second request.
  window.otflMe = render();
})();
