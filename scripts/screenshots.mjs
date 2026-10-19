// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * The README's screenshots, from the demo: desktop and phone, light and dark, every view.
 *
 *   npm i --no-save playwright-core
 *   CHROME="/path/to/chrome" npm run screenshots
 *
 * It starts the demo server in this process and drives a headless Chrome (CHROME, or the usual install places).
 * Output: docs/screenshots/<device>-<theme>-<view>.png
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../server/node.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "screenshots");
mkdirSync(out, { recursive: true });

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const chrome = process.env.CHROME ?? [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].find((p) => existsSync(p));

const port = 8899;
const server = start({ DEMO: "1", DATABASE_PATH: ":memory:", PORT: String(port), HOST: "127.0.0.1" });
const base = `http://127.0.0.1:${port}`;
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const devices = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  { name: "phone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const only = process.argv.slice(2);
for (const d of devices) {
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, isMobile: d.isMobile, hasTouch: d.hasTouch, colorScheme: theme, timezoneId: "Europe/London", locale: "en-GB" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[${d.name}/${theme}] page error:`, e.message));
    page.on("console", (m) => { if (m.type() === "error") console.error(`[${d.name}/${theme}] console:`, m.text()); });
    const shot = async (view, url, { full = false, prepare } = {}) => {
      if (only.length && !only.includes(view)) return;
      await page.goto(base + url, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);
      if (prepare) await prepare();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, `${d.name}-${theme}-${view}.png`), fullPage: full });
      console.log("saved", `${d.name}-${theme}-${view}.png`);
    };
    await shot("overview", "/", { full: d.name === "desktop" });
    // A commit with its diff: the newest one with a few files.
    const commits = await (await fetch(`${base}/api/commits?range=7d`)).json();
    const c = commits.items.find((x) => x.agent === "claude" && x.files >= 2 && x.files <= 5) ?? commits.items[0];
    await shot("commits", `/?tab=commits&sel=${c.repo}:${c.sha}`);
    const prs = await (await fetch(`${base}/api/prs?state=open&range=7d`)).json();
    const p = prs.items.find((x) => x.ci === "failure") ?? prs.items[0];
    await shot("prs", `/?tab=prs&sel=${p.repo}%23${p.number}`);
    await shot("story", "/?tab=story");
    if (d.name === "phone") await shot("list", "/?tab=commits");
    await ctx.close();
  }
}
await browser.close();
server.close();
process.exit(0);
