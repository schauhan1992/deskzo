/**
 * The Customer inbox's chat bubble, as the script a website includes (src/app/api/inbox/public/widget.js):
 * `<script src="https://<workspace>/api/inbox/public/widget.js" data-key="<channel key>" async></script>`.
 *
 * Plain JavaScript, no framework, drawn in a shadow root so the site's styles and the bubble's never
 * meet. It talks only to the workspace it was loaded from (src/app/api/inbox/public/web/[key]), with
 * text/plain bodies so a browser sends them without a preflight. The visitor is known by a token the
 * site's own storage keeps; nothing else is stored, and no cookie is set. While the panel is open it
 * asks for new messages every few seconds, and every half minute while closed once there is a
 * conversation, to show a dot.
 *
 * Kept free of backticks and dollar-brace, so it can sit in this String.raw as it is.
 */
export const WIDGET_SCRIPT = String.raw`(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || window.__deskzoChat) return;
  window.__deskzoChat = true;
  var key = script.getAttribute("data-key") || "";
  var base = new URL(script.src).origin;
  var api = base + "/api/inbox/public/web/" + encodeURIComponent(key);
  var storeKey = "deskzo-chat:" + key;
  var token = null;
  try { token = window.localStorage.getItem(storeKey); } catch (e) {}
  var config = null, open = false, last = null, seen = {}, timer = null, sending = false, primed = false;

  function call(body) {
    return fetch(api, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body), credentials: "omit" })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }

  var host = document.createElement("div");
  host.setAttribute("data-deskzo-chat", "");
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  var style = document.createElement("style");

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var bubble = el("button", "bubble");
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Open chat");
  bubble.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M12 3C6.5 3 2 6.9 2 11.7c0 2.4 1.1 4.6 3 6.2L4.3 21l3.8-1.7c1.2.4 2.5.6 3.9.6 5.5 0 10-3.9 10-8.7S17.5 3 12 3z"/></svg>';
  var dot = el("span", "dot");
  dot.hidden = true;
  bubble.appendChild(dot);

  var panel = el("div", "panel");
  panel.setAttribute("role", "dialog");
  panel.hidden = true;
  var head = el("div", "head");
  var title = el("span", "title", "Chat");
  var close = el("button", "close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close chat");
  head.appendChild(title);
  head.appendChild(close);
  var awayLine = el("div", "awayline");
  awayLine.hidden = true;
  var list = el("div", "list");
  list.setAttribute("aria-live", "polite");
  var form = el("form", "form");
  var input = el("textarea", "input");
  input.rows = 1;
  input.maxLength = 2000;
  input.placeholder = "Type a message";
  input.setAttribute("aria-label", "Your message");
  var send = el("button", "send", "Send");
  send.type = "submit";
  form.appendChild(input);
  form.appendChild(send);
  var foot = el("div", "foot", "Powered by Deskzo");
  panel.appendChild(head);
  panel.appendChild(awayLine);
  panel.appendChild(list);
  panel.appendChild(form);
  panel.appendChild(foot);
  root.appendChild(style);
  root.appendChild(panel);
  root.appendChild(bubble);

  function css(colour, left) {
    var side = left ? "left:20px;" : "right:20px;";
    return [
      ":host{all:initial}",
      ".bubble{position:fixed;bottom:20px;" + side + "z-index:2147483646;width:56px;height:56px;border-radius:50%;border:0;background:" + colour + ";color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer;display:flex;align-items:center;justify-content:center}",
      ".bubble:focus-visible,.close:focus-visible,.send:focus-visible{outline:3px solid #111;outline-offset:2px}",
      ".dot{position:absolute;top:6px;right:6px;width:12px;height:12px;border-radius:50%;background:#e11d48;border:2px solid #fff}",
      ".panel{position:fixed;bottom:88px;" + side + "z-index:2147483647;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:#fff;color:#111;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}",
      ".panel[hidden],.dot[hidden]{display:none}",
      ".head{background:" + colour + ";color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;font-weight:600}",
      ".awayline{background:#fef3c7;color:#92400e;font-size:12px;padding:8px 14px}",
      ".awayline[hidden]{display:none}",
      ".close{background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px}",
      ".list{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f6f7f9}",
      ".msg{max-width:80%;padding:8px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}",
      ".msg.you{align-self:flex-end;background:" + colour + ";color:#fff;border-bottom-right-radius:4px}",
      ".msg.them{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:4px}",
      ".who{display:block;font-size:11px;color:#6b7280;margin-bottom:2px}",
      ".form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff}",
      ".input{flex:1;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:8px 10px;font:inherit;color:inherit;max-height:96px}",
      ".input:focus{outline:2px solid " + colour + ";outline-offset:0;border-color:transparent}",
      ".send{border:0;border-radius:10px;padding:0 14px;background:" + colour + ";color:#fff;font:inherit;font-weight:600;cursor:pointer}",
      ".send:disabled{opacity:.6;cursor:default}",
      ".foot{font-size:11px;color:#9ca3af;text-align:center;padding:0 0 8px;background:#fff}",
      ".note{font-size:12px;color:#b91c1c;align-self:center}",
      "@media (max-width:480px){.panel{bottom:0;left:0;right:0;width:100%;max-width:100%;height:100%;max-height:100%;border-radius:0}}"
    ].join("");
  }

  function add(m) {
    if (m.id && seen[m.id]) return;
    if (m.id) seen[m.id] = true;
    var you = m.from === "you";
    var n = el("div", "msg " + (you ? "you" : "them"));
    if (!you && m.name) n.appendChild(el("span", "who", m.name));
    n.appendChild(document.createTextNode(m.body));
    list.appendChild(n);
    list.scrollTop = list.scrollHeight;
    if (m.at && (!last || m.at > last)) last = m.at;
    // The first fetch after loading only catches up: what was there before is not news.
    if (!you && !open && primed) dot.hidden = false;
  }

  function note(text) {
    var n = el("div", "note", text);
    list.appendChild(n);
    list.scrollTop = list.scrollHeight;
  }

  function poll() {
    if (!token) return;
    call({ op: "poll", token: token, after: last }).then(function (r) {
      if (r && r.ok && r.messages) r.messages.forEach(add);
      primed = true;
      if (r && r.forget) { token = null; try { window.localStorage.removeItem(storeKey); } catch (e) {} }
    }).catch(function () {});
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = token ? setInterval(poll, open ? 4000 : 30000) : null;
  }

  function show(on) {
    open = on;
    panel.hidden = !on;
    bubble.setAttribute("aria-label", on ? "Close chat" : "Open chat");
    if (on) {
      dot.hidden = true;
      if (!token && !list.childNodes.length && config && config.greeting) add({ from: "bot", body: config.greeting });
      poll();
      setTimeout(function () { input.focus(); }, 50);
    }
    schedule();
  }

  bubble.addEventListener("click", function () { show(!open); });
  close.addEventListener("click", function () { show(false); bubble.focus(); });
  panel.addEventListener("keydown", function (e) { if (e.key === "Escape") { show(false); bubble.focus(); } });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit")); }
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || sending) return;
    sending = true;
    send.disabled = true;
    call({ op: "send", token: token, text: text, page: String(location.href).slice(0, 500) }).then(function (r) {
      if (r && r.ok) {
        input.value = "";
        // A new conversation: the server has it from the start, greeting and all, so the local copy goes.
        if (r.token && r.token !== token) { token = r.token; list.textContent = ""; seen = {}; last = null; try { window.localStorage.setItem(storeKey, token); } catch (e2) {} }
        if (r.messages) r.messages.forEach(add);
        schedule();
      } else {
        note((r && r.error) || "That didn't send. Please try again.");
      }
    }).catch(function () { note("That didn't send. Please try again."); })
      .then(function () { sending = false; send.disabled = false; });
  });

  call({ op: "config" }).then(function (r) {
    if (!r || !r.ok) return;
    config = r;
    style.textContent = css(r.colour || "#0249FE", r.position === "left");
    title.textContent = r.title || "Chat";
    if (r.away) { awayLine.textContent = r.away; awayLine.hidden = false; }
    panel.setAttribute("aria-label", r.title || "Chat");
    (document.body || document.documentElement).appendChild(host);
    if (token) { poll(); schedule(); }
  }).catch(function () {});
})();
`;
