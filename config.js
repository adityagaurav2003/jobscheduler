import "dotenv/config";

const n = (v, fallback) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
};

/** BullMQ / Queue connection (Valkey/Redis) */
export const redisConnection = {
  host: process.env.REDIS_HOST ?? "127.0.0.1",
  port: n(process.env.REDIS_PORT, 6379),
};

/** dockerode TCP socket (e.g. Docker Desktop “Expose daemon on tcp”) */
export const dockerSocketOptions = {
  host: process.env.DOCKER_HOST ?? "localhost",
  port: n(process.env.DOCKER_PORT, 2375),
};
