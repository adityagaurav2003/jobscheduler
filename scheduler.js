import "./queues/workers.js";
import { jobDispatchScheduler, jobCriScheduler, jobWatcherScheduler } from "./queues/queues.js";

async function init() {
  console.log("Scheduler starting...");

  await Promise.all([
    jobDispatchScheduler.upsertJobScheduler("job-dispatcher-tick", {
      every: 2 * 1000,
    }),
    jobCriScheduler.upsertJobScheduler("job-cri-tick", {
      every: 5 * 1000,
    }),
    jobWatcherScheduler.upsertJobScheduler("job-watcher-tick", {
      every: 10 * 1000,
    }),
  ]);
  console.log("Schedulers registered");
}

init().catch((err) => {
  console.error("Scheduler failed:", err);
  process.exit(1);
});