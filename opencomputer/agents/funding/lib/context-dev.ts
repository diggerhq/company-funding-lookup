import { bearer, defineConnection, useSecret } from "@opencomputer/agent";
import type { PostFn } from "./research-provider";

// Managed connection: the CONTEXT_DEV_API_KEY secret is attached by OpenComputer
// to requests for this origin/prefix only. The key never enters the runtime,
// prompts or logs. Optional: lookups work without it and report the gap.
export const contextDev = defineConnection({
  id: "context-dev",
  origin: "https://api.context.dev",
  methods: ["POST"],
  pathPrefix: "/v1/",
  headers: {
    Authorization: bearer(useSecret("CONTEXT_DEV_API_KEY")),
  },
});

export const contextDevPost: PostFn = async (path, body, signal) => {
  const res = await contextDev.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return { status: res.status, json: () => res.json() };
};
