import { type Html, trusted } from "./html.ts";

/**
 * The signals that something waits for you, on every signed-in page: the
 * count in the tab title, a dot on the favicon, a banner linking to
 * Approvals, and the menu badge. All of them carry the count only, never
 * what is waiting: the title and favicon show in the tab strip, the task
 * switcher and screen shares.
 *
 * One live mechanism keeps them true without a reload: the page listens to
 * `GET /waiting/stream` (server-sent events). On a change it updates the
 * signals, and pages that list what waits (Home, Approvals, Connections and
 * the request pages) reload themselves, unless you are typing in them.
 */

/** `(2) Approvals · heel`: the count first, so it survives a narrow tab. */
export function documentTitle(title: string, waiting: number): string {
  return `${waiting > 0 ? `(${String(waiting)}) ` : ""}${title} · heel`;
}

export function thingsNeedYou(n: number): string {
  return n === 1 ? "1 thing needs you" : `${String(n)} things need you`;
}

/**
 * Where the banner shows.
 * - `everywhere`: on every signed-in page (variant A).
 * - `elsewhere`: not on Home or in Approvals, which list what waits
 *   already; there it appears only when the count changes while you look
 *   (variant B, the default).
 */
export type BannerMode = "everywhere" | "elsewhere";

/** lucide's bell-dot. */
const BELL = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M13.916 2.314A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.74 7.327A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673 9 9 0 0 1-.585-.665"/><circle cx="18" cy="8" r="3"/></svg>`;

/**
 * The banner: the whole strip is one link to Approvals. On pages where it
 * shows it is always in the page, hidden when nothing waits, so the live
 * script can show it. Where Home and Approvals list what waits already, it
 * isn't rendered; the live script adds it if the count changes.
 */
export function waitingBanner(waiting: number): Html {
  return trusted(bannerMarkup(waiting, waiting > 0));
}

function bannerMarkup(waiting: number, shown: boolean): string {
  return `<a id="heel-waiting" class="waiting-alert" href="/approvals"${shown ? "" : " hidden"}><span class="waiting-alert-icon">${BELL}</span><span class="waiting-alert-text" aria-live="polite">${thingsNeedYou(waiting)}</span><span class="waiting-alert-go" aria-hidden="true">→</span></a>`;
}

/**
 * The fallback when the live stream is down: how fresh the page is, and a
 * way to refresh it. The live script adds it only when needed; the preview
 * renders it to show the state.
 */
export function liveStamp(state: "stale" | "offline"): Html {
  return trusted(stampMarkup(state));
}

function stampMarkup(state: "stale" | "offline"): string {
  const words = state === "offline" ? "Offline. Updated 3 min ago" : "Updated 3 min ago";
  return `<p id="heel-live-stamp" class="live-stamp" data-state="${state}"><span class="live-stamp-text">${words}</span><button type="button" class="live-stamp-refresh" onclick="location.reload()">Refresh</button></p>`;
}

/**
 * The live script. `live` pages reload on a change; the others only update
 * the signals. Reloads wait while a dialog is open or a field has focus,
 * and while the tab is hidden (it reloads on return instead).
 */
export function liveScript(options: {
  waiting: number;
  version: string | null;
  live: boolean;
  /** True where the page lists what waits: the banner shows only once the count changes. */
  bannerOnChangeOnly: boolean;
  /** The preview harness has no stream: draw the signals only. */
  stream?: boolean;
}): string {
  const config = JSON.stringify({
    waiting: options.waiting,
    version: options.version,
    live: options.live,
    bannerOnChangeOnly: options.bannerOnChangeOnly,
    bannerHtml: bannerMarkup(0, false),
    stampHtml: stampMarkup("stale"),
    stream: options.stream !== false,
  }).replace(/</g, "\\u003c");
  return `
(() => {
  const CONFIG = ${config};
  let shown = CONFIG.waiting;
  let version = CONFIG.version;
  let stale = false;
  let freshAt = Date.now();
  let hiddenAt = 0;
  let source = null;
  const baseTitle = document.title.replace(/^\\(\\d+\\) /, "");
  const icon = document.querySelector('link[rel="icon"]');
  const plainIcon = icon ? icon.href : null;
  let dotIcon = null;

  const drawDot = (done) => {
    if (dotIcon) return done(dotIcon);
    const img = new Image();
    img.onload = () => {
      const size = 64;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext("2d");
      if (!g) return;
      g.drawImage(img, 0, 0, size, size);
      g.beginPath();
      g.arc(size - 15, 15, 14, 0, Math.PI * 2);
      g.fillStyle = "#ffffff";
      g.fill();
      g.beginPath();
      g.arc(size - 15, 15, 10, 0, Math.PI * 2);
      g.fillStyle = "#dc2626";
      g.fill();
      dotIcon = canvas.toDataURL("image/png");
      done(dotIcon);
    };
    img.src = plainIcon;
  };

  const apply = (n) => {
    document.title = (n > 0 ? "(" + n + ") " : "") + baseTitle;
    for (const badge of document.querySelectorAll("[data-heel-count]")) {
      badge.hidden = n === 0;
      const number = badge.querySelector("[data-heel-count-n]");
      if (number) number.textContent = String(n);
    }
    let banner = document.getElementById("heel-waiting");
    const wanted = n > 0 && !(CONFIG.bannerOnChangeOnly && n === CONFIG.waiting);
    const main = document.getElementById("main");
    if (!banner && wanted && main) {
      const holder = document.createElement("template");
      holder.innerHTML = CONFIG.bannerHtml;
      banner = holder.content.firstElementChild;
      const pause = main.querySelector(".pause-alert");
      if (pause) pause.after(banner);
      else main.prepend(banner);
    }
    if (banner) {
      const text = banner.querySelector(".waiting-alert-text");
      if (text) text.textContent = n === 1 ? "1 thing needs you" : n + " things need you";
      banner.hidden = !wanted;
    }
    if (icon && plainIcon) {
      if (n > 0) drawDot((href) => { icon.href = href; });
      else icon.href = plainIcon;
    }
  };

  let stamp = document.getElementById("heel-live-stamp");
  const ago = () => {
    const minutes = Math.round((Date.now() - freshAt) / 60000);
    return minutes < 1 ? "just now" : minutes + " min ago";
  };
  const showStamp = (state) => {
    if (!stamp && state === "live") return;
    if (!stamp) {
      // Only pages that reload themselves need to say how fresh they are.
      const main = document.getElementById("main");
      if (!CONFIG.live || !main) return;
      const holder = document.createElement("template");
      holder.innerHTML = CONFIG.stampHtml;
      stamp = holder.content.firstElementChild;
      const after = main.querySelector(".subnav") || document.getElementById("heel-waiting") || main.querySelector(".pause-alert");
      if (after) after.after(stamp);
      else main.prepend(stamp);
    }
    stamp.dataset.state = state;
    stamp.hidden = state === "live";
    const text = stamp.querySelector(".live-stamp-text");
    if (text) text.textContent = (state === "offline" ? "Offline. Updated " : "Updated ") + ago();
  };
  setInterval(() => { if (stamp && !stamp.hidden) showStamp(stamp.dataset.state); }, 30000);

  const busy = () => {
    if (document.querySelector("dialog[open], details.nav-more[open]")) return true;
    const el = document.activeElement;
    return !!el && el.matches("input:not([type=radio]):not([type=checkbox]), textarea, select, [contenteditable]");
  };
  const reloadSoon = () => {
    stale = true;
    if (document.hidden) return;
    if (busy()) { showStamp("stale"); return; }
    location.reload();
  };

  const onEvent = (event) => {
    let state;
    try { state = JSON.parse(event.data); } catch { return; }
    freshAt = Date.now();
    showStamp("live");
    if (typeof state.waiting === "number" && state.waiting !== shown) {
      shown = state.waiting;
      apply(shown);
    }
    if (typeof state.version === "string" && state.version !== version) {
      version = state.version;
      if (CONFIG.live) reloadSoon();
    }
  };

  const connect = () => {
    if (!CONFIG.stream || !window.EventSource) return;
    if (source) source.close();
    source = new EventSource("/waiting/stream");
    source.addEventListener("waiting", onEvent);
    source.onerror = () => {
      // The browser retries on its own; a closed stream (signed out, heel down) shows the stamp.
      if (source && source.readyState === EventSource.CLOSED) showStamp(navigator.onLine ? "stale" : "offline");
    };
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (stale && CONFIG.live && !busy()) { location.reload(); return; }
    // Back after more than a few seconds: the stream may have slept with the tab.
    if (hiddenAt && Date.now() - hiddenAt > 5000) connect();
  });
  window.addEventListener("pageshow", (event) => { if (event.persisted) connect(); });
  let wasOffline = false;
  window.addEventListener("offline", () => { wasOffline = true; showStamp("offline"); });
  window.addEventListener("online", () => {
    connect();
    if (wasOffline && CONFIG.live) reloadSoon();
    wasOffline = false;
  });
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = event.data || {};
      if (data.type === "heel-changed") connect();
      if (data.type === "heel-navigate" && typeof data.url === "string" && data.url.startsWith(location.origin)) location.href = data.url;
    });
  }

  if (shown > 0) apply(shown);
  connect();
})();
`;
}
