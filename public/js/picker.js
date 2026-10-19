// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * The filter pickers: a small dialog under its button with a search box and the choices (checkboxes for many,
 * radio buttons for one, or a text box for a path). Hundreds of repositories are fine: only the first 200 matches
 * are drawn. Escape or a click outside closes it and puts the focus back on its button.
 */
import { clear, h } from "./dom.js";
import { t } from "./i18n.js";

let current = null;

export function closePicker(restore = true) {
  if (!current) return;
  const { el, button, onDoc } = current;
  current = null;
  el.remove();
  button.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onDoc, true);
  if (restore) button.focus();
}

/**
 * @param {HTMLElement} button
 * @param {{ title: string, multi?: boolean, text?: { placeholder: string, value: string }, options?: { value: string, label: string, hint?: string, sw?: string }[],
 *   selected?: string[], onApply: (values: string[]) => void }} o
 */
export function openPicker(button, o) {
  if (current?.button === button) { closePicker(); return; }
  closePicker(false);
  const id = `pick-${Math.random().toString(36).slice(2, 8)}`;
  const chosen = new Set(o.selected ?? []);
  const el = h("div", { class: "picker", role: "dialog", "aria-label": o.title, id });
  const apply = (values) => { closePicker(); o.onApply(values); };

  if (o.text) {
    const input = h("input", { type: "text", class: "input", value: o.text.value ?? "", placeholder: o.text.placeholder, "aria-label": o.title, spellcheck: "false", autocomplete: "off" });
    const form = h("form", { class: "picker-text", onsubmit: (e) => { e.preventDefault(); apply(input.value.trim() ? [input.value.trim()] : []); } },
      input, h("button", { type: "submit", class: "btn sm" }, t("filter.apply")));
    el.append(form);
    mount(button, el);
    input.focus();
    input.select();
    return;
  }

  const search = h("input", { type: "search", class: "input", placeholder: t("filter.search"), "aria-label": `${o.title}: ${t("filter.search")}`, autocomplete: "off", spellcheck: "false" });
  const list = h("ul", { class: "picker-list", role: o.multi ? "group" : "radiogroup", "aria-label": o.title });
  const draw = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const matches = o.options.filter((x) => !q || x.label.toLowerCase().includes(q) || x.value.toLowerCase().includes(q) || (x.hint ?? "").toLowerCase().includes(q));
    // The chosen ones first, then the rest.
    matches.sort((a, b) => Number(chosen.has(b.value)) - Number(chosen.has(a.value)));
    for (const x of matches.slice(0, 200)) {
      const input = h("input", { type: o.multi ? "checkbox" : "radio", name: id, value: x.value, checked: chosen.has(x.value),
        onchange: (e) => { if (o.multi) { if (e.target.checked) chosen.add(x.value); else chosen.delete(x.value); } else apply([x.value]); } });
      list.append(h("li", null, h("label", null, input, x.sw ? h("i", { class: `sw ${x.sw}`, "aria-hidden": "true" }) : null, h("span", { class: "lbl" }, x.label), x.hint ? h("small", null, x.hint) : null)));
    }
    if (!matches.length) list.append(h("li", { class: "empty" }, t("filter.none")));
    else if (matches.length > 200) list.append(h("li", { class: "empty" }, t("filter.more", { n: matches.length - 200 })));
  };
  search.addEventListener("input", draw);
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); list.querySelector("input")?.focus(); }
    if (e.key === "Enter") { e.preventDefault(); const first = list.querySelector("input"); if (first && !o.multi) apply([first.value]); else if (o.multi) apply([...chosen]); }
  });
  el.append(search, list);
  if (o.multi) {
    el.append(h("div", { class: "picker-foot" },
      h("button", { type: "button", class: "btn ghost sm", onclick: () => apply([]) }, t("filter.clear")),
      h("button", { type: "button", class: "btn sm", onclick: () => apply([...chosen]) }, t("filter.apply"))));
  }
  draw();
  mount(button, el);
  search.focus();
}

function mount(button, el) {
  document.body.append(el);
  const r = button.getBoundingClientRect();
  const w = Math.min(340, innerWidth - 16);
  el.style.width = `${w}px`;
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  el.style.top = `${r.bottom + 6 + scrollY}px`;
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-controls", el.id || "");
  const onDoc = (e) => { if (!el.contains(e.target) && !button.contains(e.target)) closePicker(false); };
  document.addEventListener("pointerdown", onDoc, true);
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closePicker(); } });
  current = { el, button, onDoc };
}
