import { defineTool } from "@opencomputer/agent";

// The project database attaches to Code Mode asynchronously (observed 13-20 s after
// session start in Production). Code Mode has no timers, so retries wait here.
export const fundingWait = defineTool({
  name: "funding_wait",
  description: "Wait a few seconds before retrying code that returned retry: true (database tools still attaching).",
  input: {
    type: "object",
    properties: { seconds: { type: "integer", minimum: 1, maximum: 15 } },
    required: ["seconds"],
    additionalProperties: false,
  },
  async run({ input, signal }) {
    const ms = Math.min(15, Math.max(1, Number(input.seconds) || 10)) * 1000;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), resolve()));
    });
    return { waited_seconds: ms / 1000 };
  },
});
