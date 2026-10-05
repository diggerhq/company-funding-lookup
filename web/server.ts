// Local server: npm run web -> http://127.0.0.1:8787 (see web/app.ts for modes).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { config, handle } from "./app";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const { mode, client } = config();
if (mode === "dev" && HOST !== "127.0.0.1" && HOST !== "localhost") throw new Error("APP_DEV_USER is for local use only; bind HOST=127.0.0.1");
const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page);
  }
  void handle(req, res);
}).listen(PORT, HOST, () => console.log(`company-funding web app on http://${HOST}:${PORT} (${client.cfg.agent}@${client.cfg.environment}, mode ${mode})`));
