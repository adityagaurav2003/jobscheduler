import express from "express";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { jobStateTable } from "./db/schema.js";

const app = express();
const PORT = Number(process.env.PORT ?? 8000);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// very simple in-memory per-IP rate limiter
const rateBuckets = new Map();
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_ALL = 20; // max requests / window per IP (all routes)
const RATE_LIMIT_POST_JOB = 10; // stricter limit for POST /job

function rateLimit(limit) {
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";

    let bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
      bucket = { windowStart: now, total: 0, postJob: 0 };
      rateBuckets.set(ip, bucket);
    }

    bucket.total += 1;
    if (req.method === "POST" && req.path === "/job") {
      bucket.postJob += 1;
      if (bucket.postJob > RATE_LIMIT_POST_JOB) {
        return res.status(429).json({ error: "rate limit exceeded for POST /job" });
      }
    }

    if (bucket.total > RATE_LIMIT_ALL) {
      return res.status(429).json({ error: "rate limit exceeded" });
    }

    return next();
  };
}

app.use(express.json());
app.use(rateLimit(RATE_LIMIT_ALL));

app.get("/", (_req, res) => {
  return res.json({ message: "server is running successfully" });
});

app.get("/job/:id", async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: "invalid job id" });
  }
  try {
    const [row] = await db
      .select()
      .from(jobStateTable)
      .where(eq(jobStateTable.id, id))
      .limit(1);
    if (!row) {
      return res.status(404).json({ error: "job not found" });
    }
    return res.json({
      id: row.id,
      image: row.image,
      cmd: row.cmd,
      state: row.state,
      containerId: row.containerId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  } catch (err) {
    console.error("GET /job/:id failed:", err);
    return res.status(500).json({ error: "could not load job" });
  }
});

app.post("/job", rateLimit(RATE_LIMIT_POST_JOB), async (req, res) => {
  const { image, cmd } = req.body ?? {};
  if (typeof image !== "string" || !image.trim()) {
    return res.status(400).json({ error: "body.image must be a non-empty string" });
  }

  const cmdStored =
    cmd == null
      ? null
      : Array.isArray(cmd)
        ? JSON.stringify(cmd)
        : String(cmd);

  try {
    const [insertResult] = await db
      .insert(jobStateTable)
      .values({ image: image.trim(), cmd: cmdStored })
      .returning({ id: jobStateTable.id });
    return res.status(201).json({ jobId: insertResult.id });
  } catch (err) {
    console.error("POST /job failed:", err);
    return res.status(500).json({ error: "could not create job" });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  console.error(err);
  return res.status(500).json({ error: "internal server error" });
});

app.listen(PORT, () => {
  console.log(`server is running on port ${PORT}`);
});
