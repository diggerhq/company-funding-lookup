import { defineSchedule } from "@opencomputer/agent";

// Shared daily dispatcher for opted-in watches. Production only by default;
// Development shows it as "Manual only" (Run now). Overlapping runs are skipped.
export default defineSchedule({
  id: "watch-dispatch",
  cron: "0 14 * * *",
  timezone: "UTC",
  enabled: ["production"],
  overlap: "skip",
  dispatch: {
    text: "Process due funding watches.",
    payload: { mode: "watch-dispatch" },
  },
});
