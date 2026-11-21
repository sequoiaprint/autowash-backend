# Autowash backend

Express + Socket.IO service between the tablet and the ESP32.

```
Tablet (Next.js) <-- REST + Socket.IO --> this backend <-- MQTT --> EMQX <-- MQTT --> ESP32
```

- Only the backend talks to EMQX. The tablet never uses MQTT.
- The ESP32 owns the sequences, timings and wash timer. The backend never runs a wash timer.
- MySQL stores **history only** (wash runs and settings changes). It is never the source of truth for current settings.
- Trusted factory LAN, so there is no login in this version.

## Setup

Requirements: Node.js 22 or newer, MySQL 8.

```powershell
npm install                       # also generates the Prisma client
Copy-Item .env.example .env       # then edit .env (never commit it)
```

### Environment (`.env`)

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port. `4100`. The server binds to `0.0.0.0`. |
| `CORS_ORIGINS` | Comma-separated tablet origins, for example `http://localhost:3100,http://192.168.0.177:3100`. |
| `DATABASE_URL` | MySQL database `autowash`. |
| `TEST_DATABASE_URL` | MySQL database `autowash_test`. Used only by tests. |
| `SHADOW_DATABASE_URL` | MySQL database `autowash_shadow`. Used by `prisma migrate dev`. |
| `MQTT_URL` | EMQX address, for example `mqtt://192.168.0.177:1883`. |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | The backend's EMQX user. |
| `MQTT_CLIENT_ID` | Backend client ID. Must not be `autowash_esp_210` (the ESP's ID). |
| `MQTT_TOPIC_ROOT` | `autowash/ryobi2`. |
| `MQTT_ONLINE_TOPIC` | `relay/status`, retained `online` / `offline`. |
| `ACK_TIMEOUT_MS` | How long to wait for the ESP's ack. `5000`. |
| `STATUS_SETTLE_MS` | After the machine comes online, how long to wait for a fresh status before using the newest one. `3000`. |
| `LOG_LEVEL`, `NODE_ENV` | Optional. `NODE_ENV=production` turns off pretty logs. |

### Database and migrations

```powershell
npm run prisma:migrate -- --name <change>   # create and apply a migration (uses the shadow database)
npm run prisma:deploy                       # apply existing migrations (production)
npm run prisma:validate
```

Tables: `wash_runs` and `config_change_logs`.

## Run

| Command | Purpose |
|---|---|
| `npm run dev` | Start with auto-reload |
| `npm run build` then `npm start` | Production build and run |
| `npm run typecheck` | TypeScript strict check |
| `npm run lint` | ESLint |
| `npm test` | Vitest (unit and integration tests) |
| `npm run prisma:validate` | Validate the Prisma schema |
| `npm run dev:fake-esp` | Fake broker and fake ESP on `127.0.0.1:18830` (see below) |
| `npm run verify:manual` | Walks through the manual scenarios against the built backend and the fake ESP |

> **Windows:** run npm from PowerShell. From Git Bash, Node sees a lower-case drive letter (`c:\`) and Vitest loads itself twice, so every test fails with "failed to find the current suite".

Graceful shutdown: on Ctrl+C (SIGINT) or SIGTERM the backend stops MQTT, closes Socket.IO and the HTTP server, saves the latest elapsed time of an open run, and disconnects Prisma. It forces an exit after 10 seconds.

## EMQX permissions for the backend user

| Action | Topics |
|---|---|
| Publish | `autowash/ryobi2/cmd`, `autowash/ryobi2/config/set` |
| Subscribe | `autowash/ryobi2/#`, `relay/status` |

The backend never publishes to `relay/*`. It refuses to start with a topic root under `relay/`, and the publish path only allows `cmd` and `config/set`.

## REST API (`/api/v1`)

Every response is `{ "success": true, "data": ... }` or `{ "success": false, "error": { "code": "...", "message": "..." } }`.

| Method and path | Purpose |
|---|---|
| `GET /health` | `{ status: "ok" }` |
| `GET /machine/state` | `brokerConnected`, `machineOnline`, `status`, `config`, `updatedAt` |
| `PUT /wash-config/sequences/:washNumber` | Body `{ steps }`. Saves one wash. |
| `PUT /wash-config/timing` | Body `{ timing }`. |
| `GET /wash-config/history` | `page`, `limit`. Settings change log, newest first. |
| `POST /wash-control/start` | Body `{ wash }` (1 to 4) |
| `POST /wash-control/pause`, `/resume`, `/stop` | |
| `GET /wash-runs` | `page`, `limit`, `washNumber`, `outcome`, `from`, `to` |
| `GET /wash-runs/:id` | |

A save merges your change into the latest known config, sends the **full** payload (all 4 washes and all timings), and returns only after the ESP acks.

### Errors

| Situation | HTTP | Code |
|---|---|---|
| Broker down, machine offline or unknown, or the connection dropped while waiting | 503 | `MACHINE_OFFLINE` |
| Current config not known yet (save only) | 503 | `CONFIG_UNKNOWN` |
| No ack within `ACK_TIMEOUT_MS` | 504 | `MACHINE_TIMEOUT` |
| Wash is active (save), or ESP says `busy`, or another save is in flight | 409 | `MACHINE_BUSY` |
| ESP says `not_running` or `not_paused` | 409 | `INVALID_MACHINE_STATE` |
| ESP says `invalid` or `bad_command` | 422 | `MACHINE_REJECTED` |
| ESP says `storage` | 500 | `MACHINE_STORAGE_ERROR` |
| Bad request body, params or query | 400 | `VALIDATION_ERROR` |
| Unknown wash run | 404 | `RUN_NOT_FOUND` |

## Socket.IO events (server to client)

`machine:snapshot` (on connect, same shape as `GET /machine/state`), `machine:status`, `machine:config`, `machine:connection` (`{ brokerConnected, machineOnline }`).

## MQTT contract

Subscribe: `relay/status` (retained `online` / `offline`), `autowash/ryobi2/status`, `autowash/ryobi2/config/state`, `autowash/ryobi2/config/ack`, `autowash/ryobi2/cmd/ack`.
Publish (QoS 1, retain false): `autowash/ryobi2/cmd`, `autowash/ryobi2/config/set`.

Every payload is validated with Zod against the firmware limits before it is published. Limits: exactly 4 washes of 1 to 24 steps; `process`, `water`, `uv` or `break` only; `m` 1 to 99 (omitted on `break`); `releaseMs` 10 to 5000; `waitS` 1 to 600; `clean.durMin` 1 to 30; `air.sec` 5 to 120; request id 1 to 32 characters of `A-Z a-z 0-9 - _`.

### Command safety

- If the broker is disconnected or the machine is offline or unknown, the request is rejected at once. Nothing is queued.
- Nothing is sent or replayed after an MQTT reconnect. The client uses a clean session and an outgoing store that throws away unacknowledged messages on reconnect. Tests prove this.
- A request that is in flight when the connection drops fails at once with `MACHINE_OFFLINE`. Its outcome is unknown, so check the machine before trying again.
- Only one config save is in flight at a time. A second one gets `MACHINE_BUSY`, it is not queued.
- Commands never wait behind a save. A stop is sent immediately.
- There is no automatic retry.

## Run history

A run is **active** while the state is `running`, `paused` or `break`.

- Inactive to active: new `IN_PROGRESS` run with snapshots of the sequence and timing.
- Entering `break`: `breakCount + 1`. Running to paused: `pauseCount + 1` (operator) or `linkPauseCount + 1` (link).
- `done` closes the run as `COMPLETED`, `stopped` as `STOPPED`, `idle` while a run is open as `INTERRUPTED`.
- A different wash number, or `elapsedS` dropping by more than 10 seconds, closes the old run as `INTERRUPTED` and opens a new one.
- Elapsed time is saved on state changes and at most every 30 seconds, and again on shutdown.
- Retained status never creates, recovers or closes a run while the machine is offline or its state is unknown. After the machine is confirmed online, the backend waits up to `STATUS_SETTLE_MS` for a live status, then uses the newest one received.
- An open run stays open while the machine is offline. When it returns, the run continues if the status matches, or becomes `INTERRUPTED` if the status is `idle`.
- After a backend restart: an active status with a matching open run continues it. An active status with no open run creates a run with `recovered = true` and `startedAt = now - elapsedS`. A retained `done` or `stopped` closes a matching open run and never creates one.

Settings changed outside this API (for example on the machine) are logged as `EXTERNAL` / `DETECTED`. The first config seen after startup is not logged. Failed API saves are logged too.

## Tests and the fake ESP

`npm test` never connects to the real EMQX and never sends a command to the real machine:

- Tests start an in-memory MQTT broker ([aedes](https://github.com/moscajs/aedes)) on `127.0.0.1` with a random port, and a **fake ESP** (`test/support/fake-esp.ts`) that follows the firmware contract and wash logic. The test helpers refuse any broker URL that is not `127.0.0.1` or that uses port 1883.
- Integration tests use only `TEST_DATABASE_URL`, and refuse to run unless it points at `autowash_test`. Migrations are applied to that database automatically before the tests start.

For manual checks, run the fake broker and ESP on port 18830 and override `MQTT_URL`:

```powershell
npm run dev:fake-esp                     # terminal 1: machine time x10 (or: npm run dev:fake-esp -- 60)
$env:MQTT_URL = 'mqtt://127.0.0.1:18830' # terminal 2
npm run dev
```

`npm run verify:manual` (after `npm run build`) starts the built backend as a separate process against the fake ESP and the test database, then runs: save sequence, save timing, start wash 1, pause, resume, break, finish, stop, machine offline, and a backend restart during a wash.
