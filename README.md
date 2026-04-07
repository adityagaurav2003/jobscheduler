# Distributed Job Runner

A small distributed job execution system built with Node.js, BullMQ, PostgreSQL, and Docker.

It lets you:
- Submit jobs via HTTP (`POST /job`)
- Track job state in Postgres (`submitted -> runnable -> running -> succeeded/failed`)
- Execute jobs inside Docker containers
- Process jobs asynchronously with queue workers

## Tech Stack

- Node.js (ESM)
- Express
- BullMQ + Redis/Valkey
- PostgreSQL + Drizzle ORM
- Dockerode (Docker API client)

## Project Structure

- `server.js` - HTTP API
- `scheduler.js` - Scheduler bootstrap + worker import
- `queues/queues.js` - BullMQ queue definitions
- `queues/workers.js` - Dispatcher, runner, watcher workers
- `db/schema.js` - Drizzle schema
- `config.js` - Redis/Docker runtime config from env
- `docker-compose.yml` - Local Postgres + Valkey

## Prerequisites

- Node.js 18+ (recommended)
- pnpm
- Docker Desktop (or Docker Engine)

## Environment Variables

Create a `.env` file in the project root:

```env
DATABASE_URL=postgres://admin:admin@localhost:5432/dev
PORT=8000

REDIS_HOST=127.0.0.1
REDIS_PORT=6379

DOCKER_HOST=localhost
DOCKER_PORT=2375
```

Important:
- This project uses `dockerode` over TCP (`DOCKER_HOST`/`DOCKER_PORT`).
- On Docker Desktop, enable exposing Docker daemon on `tcp://localhost:2375` if needed.

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Start infra:

```bash
docker compose up -d
```

3. Run database migrations:

```bash
pnpm db:migrate
```

4. Start API server:

```bash
pnpm dev
```

5. Start workers/scheduler (new terminal):

```bash
pnpm worker
```

## Available Scripts

- `pnpm dev` - run API server with watch mode
- `pnpm worker` - run scheduler + workers with watch mode
- `pnpm db:generate` - generate Drizzle migrations
- `pnpm db:migrate` - apply migrations
- `pnpm db:studio` - open Drizzle Studio

## API

### Health

`GET /`

Response:

```json
{ "message": "server is running successfully" }
```

### Create Job

`POST /job`

Request body:

```json
{
  "image": "alpine",
  "cmd": ["sh", "-c", "echo hello && exit 0"]
}
```

Notes:
- Use `cmd` (not `command`).
- `cmd` can be:
  - array (stored as JSON string)
  - string
  - omitted/null

Success response:

```json
{ "jobId": "uuid-here" }
```

### Get Job Status

`GET /job/:id`

Response example:

```json
{
  "id": "uuid-here",
  "image": "alpine",
  "cmd": "[\"sh\",\"-c\",\"echo hello && exit 0\"]",
  "state": "running",
  "containerId": "container-id-or-null",
  "createdAt": "2026-04-07T10:00:00.000Z",
  "updatedAt": "2026-04-07T10:00:02.000Z"
}
```

## Job Lifecycle

1. API inserts job in `submitted`
2. Dispatcher worker moves jobs to `runnable`
3. CRI worker claims one runnable job and sets it to `running`
4. CRI worker creates/starts Docker container and stores `containerId`
5. Watcher inspects running containers:
   - exit code `0` -> `succeeded`
   - non-zero exit code -> `failed`
6. Watcher removes finished container and clears `containerId`

## Retry Behavior

`queues/workers.js` includes retry wrappers around Docker operations:
- `listImages`
- `pull`
- `createContainer`
- `start`
- `inspect`
- `remove`

Default retry settings:
- attempts: `3`
- delay: `1000ms` (pull uses `2000ms`)

## Rate Limiting

In-memory per-IP limiter in `server.js`:
- Global: `20` requests/minute/IP
- `POST /job`: `10` requests/minute/IP

If exceeded, API returns `429`.

## Quick Test Cases

Success case:

```bash
curl -X POST http://localhost:8000/job \
  -H "Content-Type: application/json" \
  -d "{\"image\":\"alpine\",\"cmd\":[\"sh\",\"-c\",\"echo ok && exit 0\"]}"
```

Failure case:

```bash
curl -X POST http://localhost:8000/job \
  -H "Content-Type: application/json" \
  -d "{\"image\":\"alpine\",\"cmd\":[\"sh\",\"-c\",\"exit 1\"]}"
```

Then check:

```bash
curl http://localhost:8000/job/<jobId>
```

## Common Issues

- `command` field not working:
  - Use `cmd` in request body.
- Container ID not visible:
  - It is set after container start; watcher later clears it when the container exits.
- All jobs failing:
  - Verify Docker daemon accessibility (`DOCKER_HOST`/`DOCKER_PORT`)
  - Verify Redis and Postgres are up
  - Check worker logs for `job <id> failed`
- `429 rate limit exceeded`:
  - Wait for 60-second window reset or increase limits in `server.js`.

## Future Improvements

- Persisted/distributed rate limiter (Redis-backed)
- Structured logging and metrics
- Automated integration tests for job lifecycle
- Dead-letter queue and retry policies at BullMQ job level
