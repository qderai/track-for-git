// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * A list that stays fast with tens of thousands of rows: only the rows on screen (and a few around them) exist in the
 * page. Rows have one fixed height (the CSS variable --row-h on the list). It loads the next page when the reader
 * nears the end.
 *
 * For keyboards and screen readers it is one listbox: focus stays on the list, the arrow keys, Page Up/Down, Home and
 * End move the active row (aria-activedescendant), Enter opens it. Each row says where it is (aria-posinset/setsize).
 */
import { h } from "./dom.js";

export class VirtualList {
  /**
   * @param {HTMLElement} el an empty element to fill
   * @param {{ render: (item: any, i: number) => HTMLElement, key: (item: any) => string, onOpen?: (item: any) => void,
   *   onMore?: () => void, label: string, id: string }} opts
   */
  constructor(el, opts) {
    this.opts = opts;
    this.items = [];
    this.total = null;
    this.hasMore = false;
    this.loading = false;
    this.active = -1;
    this.selected = null;
    this.nodes = new Map();
    this.el = el;
    el.classList.add("vl");
    el.setAttribute("role", "listbox");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", opts.label);
    this.space = h("div", { class: "vl-space" });
    this.foot = h("div", { class: "vl-foot", "aria-hidden": "true" });
    el.append(this.space, this.foot);
    this.rowH = 64;
    this.measure();
    let raf = 0;
    el.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.draw(); }); }, { passive: true });
    el.addEventListener("keydown", (e) => this.key(e));
    el.addEventListener("click", (e) => {
      const row = e.target.closest?.("[data-i]");
      if (!row || e.target.closest("a")) return;
      const i = Number(row.dataset.i);
      this.setActive(i, false);
      this.opts.onOpen?.(this.items[i]);
    });
    el.addEventListener("focus", () => { if (this.active < 0 && this.items.length) this.setActive(this.firstVisible(), false); });
    new ResizeObserver(() => { if (this.measure()) this.redrawAll(); else this.draw(); }).observe(el);
  }

  measure() {
    const v = parseFloat(getComputedStyle(this.el).getPropertyValue("--row-h"));
    const old = this.rowH;
    if (v > 0) this.rowH = v;
    return old !== this.rowH;
  }

  firstVisible() { return Math.min(this.items.length - 1, Math.floor(this.el.scrollTop / this.rowH)); }

  /** Replace the items (a new query). */
  set(items, { total = null, hasMore = false, keepActive = false } = {}) {
    const activeKey = keepActive && this.active >= 0 ? this.opts.key(this.items[this.active]) : null;
    this.items = items;
    this.total = total;
    this.hasMore = hasMore;
    this.loading = false;
    if (!keepActive) { this.el.scrollTop = 0; this.active = -1; }
    else this.active = activeKey ? items.findIndex((x) => this.opts.key(x) === activeKey) : -1;
    this.redrawAll();
  }

  /** Add the next page. */
  append(items, hasMore) {
    this.items = this.items.concat(items);
    this.hasMore = hasMore;
    this.loading = false;
    this.draw();
  }

  /** Mark the open item (aria-selected). */
  select(key) {
    this.selected = key;
    for (const [i, node] of this.nodes) node.setAttribute("aria-selected", String(this.opts.key(this.items[i]) === key));
  }

  redrawAll() {
    for (const n of this.nodes.values()) n.remove();
    this.nodes.clear();
    this.draw();
  }

  draw() {
    const n = this.items.length;
    this.space.style.height = `${n * this.rowH}px`;
    const top = this.el.scrollTop, height = this.el.clientHeight || 600;
    const from = Math.max(0, Math.floor(top / this.rowH) - 8);
    const to = Math.min(n, Math.ceil((top + height) / this.rowH) + 8);
    for (const [i, node] of this.nodes) if (i < from || i >= to) { node.remove(); this.nodes.delete(i); }
    for (let i = from; i < to; i++) {
      if (this.nodes.has(i)) continue;
      const item = this.items[i];
      const row = this.opts.render(item, i);
      row.id = `${this.opts.id}-${i}`;
      row.dataset.i = String(i);
      row.setAttribute("role", "option");
      row.setAttribute("aria-posinset", String(i + 1));
      row.setAttribute("aria-setsize", String(this.total ?? (this.hasMore ? -1 : n)));
      row.setAttribute("aria-selected", String(this.opts.key(item) === this.selected));
      row.classList.toggle("active", i === this.active);
      row.style.transform = `translateY(${i * this.rowH}px)`;
      row.style.height = `${this.rowH}px`;
      this.space.append(row);
      this.nodes.set(i, row);
    }
    this.foot.textContent = "";
    if (this.hasMore && !this.loading && to >= n - 20 && this.opts.onMore) { this.loading = true; this.opts.onMore(); }
  }

  setActive(i, scroll = true) {
    if (!this.items.length) return;
    i = Math.max(0, Math.min(this.items.length - 1, i));
    this.nodes.get(this.active)?.classList.remove("active");
    this.active = i;
    this.el.setAttribute("aria-activedescendant", `${this.opts.id}-${i}`);
    if (scroll) {
      const y = i * this.rowH;
      if (y < this.el.scrollTop) this.el.scrollTop = y;
      else if (y + this.rowH > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = y + this.rowH - this.el.clientHeight;
      this.draw();
    }
    this.nodes.get(i)?.classList.add("active");
  }

  key(e) {
    const page = Math.max(1, Math.floor(this.el.clientHeight / this.rowH) - 1);
    const moves = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
    if (e.key in moves) { e.preventDefault(); this.setActive((this.active < 0 ? this.firstVisible() - (moves[e.key] > 0 ? 1 : 0) : this.active) + moves[e.key]); }
    else if (e.key === "Home") { e.preventDefault(); this.setActive(0); }
    else if (e.key === "End") { e.preventDefault(); this.setActive(this.items.length - 1); }
    else if ((e.key === "Enter" || e.key === " ") && this.active >= 0) { e.preventDefault(); this.opts.onOpen?.(this.items[this.active]); }
  }
}
