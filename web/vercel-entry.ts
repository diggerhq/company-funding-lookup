// Vercel function entry. Bundled to api/index.js by `npm run bundle:vercel`
// (Vercel's per-file TS compile can't resolve this repo's extensionless ESM imports).
import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "./app";

export default function handler(req: IncomingMessage, res: ServerResponse) {
  return handle(req, res);
}
