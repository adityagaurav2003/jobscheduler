import { Worker } from "bullmq";
import { db } from "../db/index.js";
import { jobStateTable } from "../db/schema.js";
import { inArray, sql, eq } from "drizzle-orm";
import Docker from "dockerode";
import { dockerSocketOptions, redisConnection } from "../config.js";

const docker = new Docker(dockerSocketOptions);

async function withRetry(fn, { attempts = 3, delayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

/** Explicit states — avoids fragile `enumValues` index ordering. */
const S = {
  submitted: "submitted",
  runnable: "runnable",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
};

const workerOpts = { connection: redisConnection };

function dockerCmd(cmd) {
  if (cmd == null || cmd === "null") return undefined;
  try {
    const parsed = JSON.parse(cmd);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* plain string command */
  }
  return ["/bin/sh", "-c", String(cmd)];
}

/* pull image properly */
async function pullImage(image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);

      docker.modem.followProgress(stream, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

/* ---------------- DISPATCHER ---------------- */
export const jobDispatchWorker = new Worker(
  "job-dispatcher",
  async () => {
    console.log(`[jobDispatcher]: checking for new submitted jobs`);

    await db.transaction(async (tx) => {
      const stmt = sql`
        SELECT id 
        FROM ${jobStateTable}
        WHERE ${jobStateTable.state} = ${S.submitted}
        ORDER BY ${jobStateTable.createdAt} ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 5;
      `;

      const result = await tx.execute(stmt);
      const jobIds = result.rows.map((e) => e.id);

      console.log(`[jobDispatcher]: Found ${jobIds.length} jobs`, jobIds);

      if (jobIds.length > 0) {
        await tx
          .update(jobStateTable)
          .set({ state: S.runnable })
          .where(inArray(jobStateTable.id, jobIds));
      }
    });
  },
  workerOpts
);

/* ---------------- CRI WORKER ---------------- */
export const jobCriWorker = new Worker(
  "job-cri",
  async () => {
    console.log(`[jobCriWorker]: checking for runnable jobs`);

    let jobId;
    let jobData;

    await db.transaction(async (tx) => {
      const stmt = sql`
        SELECT id 
        FROM ${jobStateTable}
        WHERE ${jobStateTable.state} = ${S.runnable}
        ORDER BY ${jobStateTable.createdAt} ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1;
      `;

      const result = await tx.execute(stmt);
      const jobIds = result.rows.map((e) => e.id);

      console.log(`[jobCriWorker]: Found ${jobIds.length} jobs`, jobIds);

      if (jobIds.length === 0) return;

      jobId = jobIds[0];
      const [row] = await tx
        .select()
        .from(jobStateTable)
        .where(eq(jobStateTable.id, jobId))
        .limit(1);
      jobData = row;

      await tx
        .update(jobStateTable)
        .set({ state: S.running })
        .where(eq(jobStateTable.id, jobId));
    });

    if (!jobId || !jobData) return;

    try {
      const images = await withRetry(
        () =>
          docker.listImages({
            filters: {
              reference: [`${jobData.image}:latest`],
            },
          }),
        { attempts: 3, delayMs: 1000 }
      );

      if (!images || images.length === 0) {
        console.log(`pulling image ${jobData.image}:latest`);
        await withRetry(() => pullImage(`${jobData.image}:latest`), {
          attempts: 3,
          delayMs: 2000,
        });
      }

      const container = await withRetry(
        () =>
          docker.createContainer({
            Image: `${jobData.image}:latest`,
            Tty: false,
            HostConfig: { AutoRemove: false },
            Cmd: dockerCmd(jobData.cmd),
          }),
        { attempts: 3, delayMs: 1000 }
      );

      await withRetry(() => container.start(), { attempts: 3, delayMs: 1000 });
      console.log(`container started for job ${jobId}`);

      await db
        .update(jobStateTable)
        .set({ containerId: container.id })
        .where(eq(jobStateTable.id, jobId));
    } catch (err) {
      console.log(`job ${jobId} failed`, err);

      await db
        .update(jobStateTable)
        .set({ state: S.failed })
        .where(eq(jobStateTable.id, jobId));
    }
  },
  workerOpts
);

export const jobWatch = new Worker(
  "job-watcher",
  async () => {
    await db.transaction(
      async (tx) => {
        const stmt = sql`
          SELECT id 
          FROM ${jobStateTable}
          WHERE ${jobStateTable.state} = ${S.running}
          ORDER BY ${jobStateTable.createdAt} ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1;
        `;

        const result = await tx.execute(stmt);
        const jobIds = result.rows.map((e) => e.id);

        for (const jobId of jobIds) {
          const [job] = await tx
            .select()
            .from(jobStateTable)
            .where(eq(jobStateTable.id, jobId));

          if (!job?.containerId) continue;

          const container = docker.getContainer(job.containerId);
          const containerStatus = await withRetry(
            () => container.inspect(),
            { attempts: 3, delayMs: 1000 }
          );
          console.log(`status`, containerStatus.State.Status);

          if (containerStatus.State.Status === "exited") {
            const exitCode = containerStatus.State.ExitCode ?? -1;
            const ok = exitCode === 0;
            await tx
              .update(jobStateTable)
              .set({
                state: ok ? S.succeeded : S.failed,
                containerId: null,
              })
              .where(eq(jobStateTable.id, jobId));
            await withRetry(() => container.remove(), {
              attempts: 3,
              delayMs: 1000,
            });
          }
        }
      },
      { accessMode: "read write", isolationLevel: "read committed" }
    );
  },
  workerOpts
);
