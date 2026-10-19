// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * `npm run demo` (or `node server/demo.js [port]`): the dashboard with the made-up Acme organisation, in memory, no
 * token, no sign-in.
 */
import { start } from "./node.js";

start({ ...process.env, DEMO: "1", AUTH: process.env.AUTH ?? "", DATABASE_PATH: process.env.DATABASE_PATH ?? ":memory:", PORT: process.env.PORT ?? process.argv[2] ?? "8787" });
