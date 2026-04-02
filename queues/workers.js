import { Worker } from "bullmq";
import { db } from "../db/index.js";
import { jobStateTable, jobStatusenumValues } from "../db/schema.js";
import { inArray, sql, eq } from "drizzle-orm";
import Docker from "dockerode";

const docker = new Docker({
  host: "localhost",
  port: 2375,
});

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
        WHERE ${jobStateTable.state} = ${jobStatusenumValues[0]}
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
          .set({ state: "runnable" })
          .where(inArray(jobStateTable.id, jobIds));
      }
    });
  },
  {
    connection: {
      host: "127.0.0.1",
      port: 6379,
    },
  }
);

/* ---------------- CRI WORKER ---------------- */
export const jobCriWorker = new Worker(
  "job-cri",
  async () => {
    console.log(`[jobCriWorker]: checking for runnable jobs`);

    await db.transaction(async (tx) => {
      const stmt = sql`
        SELECT id 
        FROM ${jobStateTable}
        WHERE ${jobStateTable.state} = ${jobStatusenumValues[1]}
        ORDER BY ${jobStateTable.createdAt} ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1;
      `;

      const result = await tx.execute(stmt);
      const jobIds = result.rows.map((e) => e.id);

      console.log(`[jobCriWorker]: Found ${jobIds.length} jobs`, jobIds);

      for (const jobId of jobIds) {
        const job = await tx
          .select()
          .from(jobStateTable)
          .where(eq(jobStateTable.id, jobId))
          .limit(1);

        const jobData = job[0];

        try {
          /* mark running */
          await tx
            .update(jobStateTable)
            .set({ state: "running" })
            .where(eq(jobStateTable.id, jobId));

          /* ensure image */
          const images = await docker.listImages({
            filters: {
              reference: [`${jobData.image}:latest`],
            },
          });

          if (!images || images.length === 0) {
            console.log(`pulling image ${jobData.image}:latest`);
            await pullImage(`${jobData.image}:latest`);
          }

          /* create + start container */
          const container = await docker.createContainer({
            Image: `${jobData.image}:latest`,
            Tty: false,
            HostConfig: { AutoRemove: false },
            Cmd: jobData.cmd,
          });

          await container.start();
          console.log(`container started for job ${jobId}`);

          /* store container id */
          await tx
            .update(jobStateTable)
            .set({
              ContainerId: container.id,
            })
            .where(eq(jobStateTable.id, jobId));

          /* OPTIONAL: mark success (you can delay this later) */
          await tx
            .update(jobStateTable)
            .set({ state: "succeeded" })
            .where(eq(jobStateTable.id, jobId));

        } catch (err) {
          console.log(`job ${jobId} failed`, err);

          await tx
            .update(jobStateTable)
            .set({ state: "failed" })
            .where(eq(jobStateTable.id, jobId));
        }
      }
    });
  },
  {
    connection: {
      host: "127.0.0.1",
      port: 6379,
    },
  }
);

export const jobWatch=new Worker("job-watch",async()=>{
await db.transaction(async (tx) => {
      const stmt = sql`
        SELECT id 
        FROM ${jobStateTable}
        WHERE ${jobStateTable.state} = ${jobStatusenumValues[2]}
        ORDER BY ${jobStateTable.createdAt} ASC
        FOR UPDATE 
        LIMIT 1;
      `;

      const result = await tx.execute(stmt);
      const jobIds = result.rows.map((e) => e.id);

      for(const jobId of jobIds){
        const [job]=await db.select()
        .from(jobStateTable)
        .where(eq(jobStateTable.id,jobId));
        if (job.ContainerId){
            const container=docker.getContainer(job.ContainerId)
            const containerStatus=await container.inspect()
            console.log(`status`,containerStatus.State.Status);
            if(containerStatus.State.Status==='exited'){
                await tx.update(jobStateTable).set({state:'succeeded',ContainerId:null})
                .where(eq(jobStateTable.id,jobId));
                await container.remove();
            }
        }
      }

},{accessMode:'read write',isolationLevel:'read committed'},);
},{
    connection:{
        host:'127.0.0.1',
        port:6379,
    },
});
    