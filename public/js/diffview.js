// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * The files of a commit or a pull request with a readable diff: one fold per file, its lines with old and new line
 * numbers. Nothing is drawn until a fold is opened, and then 400 lines at a time, so a 5,000-line lock file cannot
 * freeze the page. Lock files, generated output and very long diffs start folded; small changes start open.
 */
import { clear, h } from "./dom.js";
import { clock, num, t } from "./i18n.js";
import { GENERATED, parsePatch } from "./lib.js";

const CHUNK = 400;

/**
 * @param {HTMLElement} box
 * @param {{ files: any[]|null, filesTotal?: number, cutAll?: boolean, filesError?: string, retryAt?: number }} d
 * @param {{ url?: string|null }} o
 */
export function drawFiles(box, d, o = {}) {
  clear(box);
  if (!d.files) {
    const why = d.filesError === "rate_limited" ? t("diff.rate", { at: clock(d.retryAt) }) : d.filesError === "gone" ? t("diff.gone") : t("diff.error");
    box.append(h("p", { class: "note warn" }, t("diff.unavailable", { why })));
    return;
  }
  const changed = d.files.reduce((a, f) => a + f.additions + f.deletions, 0);
  const openAll = d.files.length <= 6 && changed <= 600;
  const folds = [];
  const bar = h("div", { class: "files-bar" },
    h("button", { type: "button", class: "btn ghost sm", onclick: () => folds.forEach((f) => { f.open = true; }) }, t("diff.expand")),
    h("button", { type: "button", class: "btn ghost sm", onclick: () => folds.forEach((f) => { f.open = false; }) }, t("diff.collapse")));
  box.append(bar);
  for (const f of d.files) {
    const lines = f.patch ? parsePatch(f.patch) : [];
    const generated = f.generated ?? GENERATED.test(f.path);
    const big = lines.length > 300;
    const det = h("details", { class: "file" });
    const status = t(`diff.status.${["added", "removed", "renamed"].includes(f.status) ? f.status : "modified"}`);
    det.append(h("summary", null,
      h("span", { class: `st st-${f.status}`, title: status }, f.status === "added" ? "A" : f.status === "removed" ? "D" : f.status === "renamed" ? "R" : "M", h("span", { class: "sr-only" }, ` ${status}`)),
      h("span", { class: "path", dir: "ltr" }, f.path, f.previous ? h("small", null, ` ${t("diff.renamed", { from: f.previous })}`) : null,
        generated || big ? h("span", { class: "badge", title: generated ? t("diff.generated") : t("diff.large") }, generated ? t("diff.badge.generated") : t("diff.badge.large")) : null),
      h("span", { class: "counts" }, h("span", { class: "add" }, `+${num(f.additions)}`), h("span", { class: "del" }, `−${num(f.deletions)}`))));
    const body = h("div", { class: "file-body" });
    det.append(body);
    let drawn = 0;
    const more = () => {
      const pre = body.querySelector("table") ?? body.appendChild(h("table", { class: "diff", role: "presentation" }));
      const tb = pre.tBodies[0] ?? pre.appendChild(h("tbody"));
      const end = Math.min(lines.length, drawn + CHUNK);
      const frag = document.createDocumentFragment();
      for (let i = drawn; i < end; i++) {
        const l = lines[i];
        frag.append(l.t === "h"
          ? h("tr", { class: "hunk" }, h("td", { class: "ln", colspan: "2" }), h("td", { class: "code" }, l.text))
          : h("tr", { class: l.t }, h("td", { class: "ln" }, l.a ?? ""), h("td", { class: "ln" }, l.b ?? ""),
            h("td", { class: "code" }, h("span", { class: "sign", "aria-hidden": "true" }, l.t === "a" ? "+" : l.t === "d" ? "−" : " "),
              h("span", { class: "sr-only" }, l.t === "a" ? "added: " : l.t === "d" ? "removed: " : ""), l.text || " ")));
      }
      tb.append(frag);
      drawn = end;
      body.querySelector(".more")?.remove();
      if (drawn < lines.length) {
        body.append(h("button", { type: "button", class: "btn ghost sm more", onclick: (e) => { e.target.disabled = true; more(); } }, t("diff.more", { n: Math.min(CHUNK, lines.length - drawn) })));
      } else if (f.cut) body.append(h("p", { class: "note" }, t("diff.cut")));
    };
    det.addEventListener("toggle", () => {
      if (!det.open || drawn || body.childElementCount) return;
      if (!lines.length) { body.append(h("p", { class: "note" }, f.binary ? t("diff.binary") : t("diff.cut"))); return; }
      more();
    });
    if (openAll && !generated && !big) det.open = true;
    folds.push(det);
    box.append(det);
  }
  const rest = (d.filesTotal ?? d.files.length) - d.files.length;
  if (rest > 0) box.append(h("p", { class: "note" }, t("diff.moreFiles", { n: rest })));
  if (d.cutAll) box.append(h("p", { class: "note" }, t("diff.cutAll")));
}
