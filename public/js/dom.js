// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Building the page without innerHTML: every name, message, path and line of code from GitHub goes in as text, so
 * nothing in a commit message can become markup.
 */

const SVG = "http://www.w3.org/2000/svg";

function apply(el, attrs) {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "text") el.textContent = v;
    else if (k === "style" && typeof v === "object") for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith("--")) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    else if (k === "data") for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "tip") el.__tip = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  return el;
}

function add(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** An HTML element: h("a", { href, class }, "text", child…). */
export const h = (tag, attrs, ...children) => add(apply(document.createElement(tag), attrs), children);
/** An SVG element. */
export const s = (tag, attrs, ...children) => add(apply(document.createElementNS(SVG, tag), attrs), children);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clear = (el) => { el.replaceChildren(); return el; };

/** An icon from the inline sprite in index.html (decorative unless labelled by its button). */
export const icon = (name, cls = "i") => s("svg", { class: cls, "aria-hidden": "true", focusable: "false" }, s("use", { href: `#i-${name}` }));

// ---------------------------------------------------------------------------------------------------- tooltip

let tip;
/**
 * One tooltip for the whole page. Any element with a `tip` (an array of lines, the first in bold) shows it on hover
 * and on keyboard focus; Escape hides it.
 */
export function initTooltips() {
  tip = h("div", { class: "tip", role: "tooltip", id: "tip", hidden: true });
  document.body.append(tip);
  const find = (t) => { for (let el = t; el && el !== document.body; el = el.parentNode) if (el.__tip) return el; return null; };
  const show = (el, x, y) => {
    clear(tip);
    const lines = typeof el.__tip === "function" ? el.__tip() : el.__tip;
    lines.filter(Boolean).forEach((line, i) => tip.append(h(i === 0 ? "strong" : "span", null, line)));
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const px = Math.min(Math.max(8, x + 14), innerWidth - r.width - 8);
    const py = y + 18 + r.height > innerHeight ? y - r.height - 12 : y + 18;
    tip.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
  };
  document.addEventListener("pointermove", (e) => { const el = find(e.target); if (el) show(el, e.clientX, e.clientY); else tip.hidden = true; }, { passive: true });
  document.addEventListener("pointerleave", () => { tip.hidden = true; });
  document.addEventListener("focusin", (e) => {
    const el = find(e.target);
    if (!el || !e.target.matches(":focus-visible")) { tip.hidden = true; return; }
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width / 2, r.bottom - 10);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") tip.hidden = true; });
  addEventListener("scroll", () => { tip.hidden = true; }, { passive: true, capture: true });
}
export const hideTip = () => { if (tip) tip.hidden = true; };

/** Say something to screen readers without moving focus. */
export function announce(text) {
  const live = $("#live");
  if (!live) return;
  live.textContent = "";
  setTimeout(() => { live.textContent = text; }, 50);
}

/** Read a stored preference; storage can be unavailable (private windows), which is fine. */
export function pref(key, fallback = null) { try { return localStorage.getItem(`tfg:${key}`) ?? fallback; } catch { return fallback; } }
export function setPref(key, value) { try { localStorage.setItem(`tfg:${key}`, value); } catch { /* not kept */ } }
