import { Queue } from "bullmq";
import { redisConnection } from "../config.js";

const queueOpts = { connection: redisConnection };

export const jobDispatchScheduler = new Queue("job-dispatcher", queueOpts);
export const jobCriScheduler = new Queue("job-cri", queueOpts);
export const jobWatcherScheduler = new Queue("job-watcher", queueOpts);