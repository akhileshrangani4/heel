/**
 * shadcn/ui's Select look for every single <select> on a page, as a
 * progressive enhancement. The native select stays in the DOM, in its form,
 * with its id and name, so labels, form posts, passkey ceremonies that read
 * a fieldset's values, and onchange handlers keep working; it's only hidden
 * visually. A trigger button and a listbox popover stand in for its popup.
 * Choosing an option sets the select's value and fires bubbling `input` and
 * `change` events. Without script the native select shows, already styled.
 * A select marked `data-native` is left alone.
 */
export const SELECT_SCRIPT = `
(() => {
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  let count = 0;
  let openOne = null;

  const enhance = (select) => {
    if (select.multiple || select.dataset.native !== undefined || select.dataset.heelSelect) return;
    select.dataset.heelSelect = "1";
    const n = ++count;
    if (!select.id) select.id = "heel-select-" + n;
    const listId = "heel-select-list-" + n;

    const wrap = document.createElement("span");
    wrap.className = "ui-select";
    select.parentNode.insertBefore(wrap, select.nextSibling);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "ui-select-trigger";
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", listId);
    const label = select.id ? document.querySelector('label[for="' + CSS.escape(select.id) + '"]') : null;
    if (label) {
      if (!label.id) label.id = "heel-select-label-" + n;
      trigger.setAttribute("aria-labelledby", label.id + " " + "heel-select-value-" + n);
    } else if (select.getAttribute("aria-label")) {
      trigger.setAttribute("aria-label", select.getAttribute("aria-label"));
    }
    const value = document.createElement("span");
    value.className = "ui-select-value";
    value.id = "heel-select-value-" + n;
    trigger.appendChild(value);
    trigger.insertAdjacentHTML("beforeend", '<span class="ui-select-chevron">' + CHEVRON + "</span>");

    const list = document.createElement("div");
    list.className = "ui-select-content";
    list.id = listId;
    list.setAttribute("role", "listbox");
    list.tabIndex = -1;
    list.hidden = true;
    if (label) list.setAttribute("aria-labelledby", label.id);

    wrap.appendChild(trigger);
    wrap.appendChild(list);
    select.classList.add("ui-select-native");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");

    let active = -1;
    let typed = "";
    let typedAt = 0;
    const items = () => Array.from(list.querySelectorAll('[role="option"]'));
    const sync = () => {
      const chosen = select.options[select.selectedIndex];
      value.textContent = chosen ? chosen.textContent : "";
      trigger.disabled = select.disabled;
    };
    const build = () => {
      list.textContent = "";
      Array.from(select.options).forEach((option, i) => {
        const item = document.createElement("div");
        item.className = "ui-select-item";
        item.id = listId + "-" + i;
        item.setAttribute("role", "option");
        item.dataset.index = String(i);
        item.setAttribute("aria-selected", i === select.selectedIndex ? "true" : "false");
        if (option.disabled) item.setAttribute("aria-disabled", "true");
        const text = document.createElement("span");
        text.textContent = option.textContent;
        item.appendChild(text);
        item.insertAdjacentHTML("beforeend", '<span class="ui-select-check">' + CHECK + "</span>");
        list.appendChild(item);
      });
    };
    const highlight = (i) => {
      const all = items();
      if (all.length === 0) return;
      active = Math.max(0, Math.min(i, all.length - 1));
      all.forEach((el, j) => el.classList.toggle("is-active", j === active));
      trigger.setAttribute("aria-activedescendant", all[active].id);
      all[active].scrollIntoView({ block: "nearest" });
    };
    const step = (from, dir) => {
      const all = items();
      let i = from;
      for (let k = 0; k < all.length; k++) {
        i += dir;
        if (i < 0 || i >= all.length) return from;
        if (all[i].getAttribute("aria-disabled") !== "true") return i;
      }
      return from;
    };
    const place = () => {
      list.classList.remove("is-up");
      const box = trigger.getBoundingClientRect();
      // The room inside whatever clips the popover: the viewport, or a scrolling
      // ancestor such as a dialog's panel.
      let top = 0;
      let bottom = window.innerHeight;
      for (let el = wrap.parentElement; el && el !== document.body; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowY !== "visible" || style.overflowX !== "visible") {
          const clip = el.getBoundingClientRect();
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
      }
      const below = bottom - box.bottom;
      const above = box.top - top;
      const height = Math.min(list.scrollHeight, 288);
      if (below < height + 12 && above > below) list.classList.add("is-up");
    };
    const close = (refocus) => {
      if (list.hidden) return;
      list.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-activedescendant");
      if (openOne === close) openOne = null;
      if (refocus) trigger.focus();
    };
    const open = () => {
      if (select.disabled) return;
      if (openOne && openOne !== close) openOne(false);
      build();
      list.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      place();
      highlight(select.selectedIndex < 0 ? 0 : select.selectedIndex);
      openOne = close;
    };
    const choose = (i) => {
      const option = select.options[i];
      if (!option || option.disabled) return;
      const changed = select.selectedIndex !== i;
      select.selectedIndex = i;
      sync();
      close(true);
      if (changed) {
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };

    trigger.addEventListener("click", () => (list.hidden ? open() : close(true)));
    trigger.addEventListener("keydown", (event) => {
      const isOpen = !list.hidden;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          if (!isOpen) open();
          else highlight(step(active, 1));
          return;
        case "ArrowUp":
          event.preventDefault();
          if (!isOpen) open();
          else highlight(step(active, -1));
          return;
        case "Home":
          if (isOpen) { event.preventDefault(); highlight(step(-1, 1)); }
          return;
        case "End":
          if (isOpen) { event.preventDefault(); highlight(step(items().length, -1)); }
          return;
        case "Enter":
        case " ":
          event.preventDefault();
          if (!isOpen) open();
          else if (event.key === "Enter" || !typed) choose(active);
          return;
        case "Escape":
          if (isOpen) { event.preventDefault(); close(true); }
          return;
        case "Tab":
          close(false);
          return;
        default:
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const now = Date.now();
            typed = now - typedAt > 700 ? event.key.toLowerCase() : typed + event.key.toLowerCase();
            typedAt = now;
            if (!isOpen) open();
            const found = Array.from(select.options).findIndex((o) => !o.disabled && o.textContent.trim().toLowerCase().startsWith(typed));
            if (found >= 0) highlight(found);
            setTimeout(() => { if (Date.now() - typedAt >= 700) typed = ""; }, 750);
          }
      }
    });
    list.addEventListener("mousedown", (event) => event.preventDefault());
    list.addEventListener("click", (event) => {
      const item = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
      if (item) choose(Number(item.dataset.index));
    });
    list.addEventListener("mousemove", (event) => {
      const item = event.target instanceof Element ? event.target.closest('[role="option"]') : null;
      if (item && item.getAttribute("aria-disabled") !== "true") highlight(Number(item.dataset.index));
    });
    select.addEventListener("change", sync);
    const form = select.form;
    if (form) form.addEventListener("reset", () => setTimeout(sync));
    sync();
  };

  document.addEventListener("click", (event) => {
    if (openOne && !(event.target instanceof Element && event.target.closest(".ui-select"))) openOne(false);
  });
  window.addEventListener("resize", () => { if (openOne) openOne(false); });
  document.querySelectorAll("select").forEach(enhance);
})();
`;
