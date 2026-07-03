# Omnichat Dialer Microservice (`omnichat-dialer`)

The `omnichat-dialer` is a high-performance predictive and manual dialing microservice built with Node.js (Express & Socket.io), Redis, and Prisma (PostgreSQL). It acts as the orchestration brain that manages agent availability queues in real-time, calculates dialing rates using industry-standard mathematical models, communicates with the VitalPBX API, and bridges customer lines with the LiveKit SIP trunk.

---

## 🏗️ Architecture & Folders

The project follows a clean service-oriented architecture separating configurations, core engines, routing layers, and real-time socket events:

```
omnichat-dialer/
├── prisma/
│   └── schema.prisma        # Database models (copied from chat server)
├── src/
│   ├── config/              # Connections & configurations
│   │   ├── db.js            # Prisma client instantiation
│   │   ├── redis.js         # Redis client connection
│   │   ├── livekit.js       # LiveKit server SDK connection
│   │   └── vitalpbx.js      # VitalPBX API details
│   ├── services/            # Core business engines
│   │   ├── PredictiveEngine.js  # Predictive superdialing loop (500ms)
│   │   ├── LiveKitService.js    # Rooms & Token generator
│   │   └── VitalPBXService.js   # Telephony actions (Originate, Transfer, Hangup)
│   ├── routes/              # Express API endpoints
│   │   └── calls.js         # Webhooks & manual dialing routes
│   ├── sockets/             # Real-time WebSocket handlers
│   │   └── eventBus.js      # Socket.io connection & status sync
│   └── app.js               # Microservice entrypoint
├── package.json             # Dependencies & scripts
└── README.md                # Documentation
```

---

## ⚡ Core Systems

### 1. The Predictive Loop (Overdialing)
The `PredictiveEngine` runs in a background loop every 500ms applying the standard industry overdialing formula:

$$\text{Disparos} = \left\lfloor \frac{\text{Agentes Livres}}{\text{Taxa de Sucesso}} - \text{Chamadas em Curso} \right\rfloor$$

Where:
* **Agentes Livres** (`availableAgents`): Checked instantly from the Redis ZSET (`dialer:idle_agents`).
* **Taxa de Sucesso** (`successRate`): Calculated using PostgreSQL `call_history` data from the last 5 minutes ($\text{Atendida} \div \text{Total}$). Clamped between `0.05` and `1.0` to avoid extreme values. Throttled automatically by a Redis penalty override if a call abandonment occurs.
* **Chamadas em Curso** (`callsInProgress`): Number of active dialing channels stored in the Redis set `dialer:active_dialing_channels`.

If the result is positive, the engine pops leads from the Redis queue `dialer:lead_queue` (refilled dynamically in chunks from Postgres) and originates outbound calls via VitalPBX.

### 2. Real-Time Agent Queue (Redis ZSET)
Agent ociosity is managed using a Redis Sorted Set (`ZSET`) called `dialer:idle_agents`.
* When an agent connects and sets their status to `"disponivel"`, they are added to the ZSET with the current timestamp as the score: `ZADD dialer:idle_agents <timestamp> <agent_id>`.
* When a call is answered, the webhook performs an **atomic pop** using `ZPOPMIN dialer:idle_agents 1` to retrieve the agent who has been idle the longest. This atomic operation resolves concurrency race conditions when multiple customers answer at the same millisecond.
* When an agent changes status to paused/offline or closes their browser tab (socket disconnect), they are immediately removed from the ZSET via `ZREM dialer:idle_agents <agent_id>`.

### 3. Webhook Pipeline & LiveKit Bridging
When a dialed customer answers:
1. VitalPBX fires a webhook callback to `POST /api/v1/calls/webhooks/livekit` with the `channelId`.
2. The endpoint checks if agents are available (using the atomic `zPopMin` pop).
3. **If agents are available**:
   - The selected agent is marked as `ocupado` in Postgres.
   - A LiveKit room `room_<channelId>` is created, and a JWT token is generated for the agent.
   - An `agent.incoming_call` socket event containing the room name, token, and customer details (CPF, name) is sent to the agent's Vue.js client.
   - VitalPBX is commanded to transfer the customer's call to the LiveKit SIP trunk address: `sip:<roomName>@livekit-sip:5060`.
4. **If agents are NOT available (Controle de Abandono)**:
   - The call is immediately hung up via the VitalPBX API (mitigated within a 2-second threshold).
   - An `Abandono` entry is saved in `call_history`.
   - A Redis key `dialer:inflated_success_rate` is set to `1.0` (with a 30s TTL) to temporarily inflate the success rate, braking the predictive dialer from placing new calls.

---

## ⚙️ Environment Configuration (`.env`)

```ini
PORT=5001
DATABASE_URL="postgresql://postgres:password@localhost:5432/omnichat_db?schema=public"
REDIS_HOST="localhost"
REDIS_PORT=6379
REDIS_PASSWORD=""

# LiveKit Config
LIVEKIT_URL="http://localhost:7880"
LIVEKIT_API_KEY="devkey"
LIVEKIT_API_SECRET="secret"

# VitalPBX Config
VITALPBX_API_URL="http://vitalpbx-host/api/v2"
VITALPBX_API_KEY="vitalpbx_secret_api_key"
VITALPBX_TRUNK="Local/SIP_TRUNK_LIVEKIT"
VITALPBX_CONTEXT="from-internal"

# Dialer Settings
DIALER_INTERVAL_MS=500
DIALER_SUCCESS_RATE_DEFAULT=0.3
DIALER_ABANDON_TIMEOUT_MS=2000
DIALER_MIN_SUCCESS_RATE=0.05
DIALER_MAX_SUCCESS_RATE=1.0
DIALER_SUCCESS_RATE_WINDOW_MINUTES=5
```

---

## 🛠️ Commands

### Install Dependencies
```bash
npm install
```

### Generate Prisma Client
```bash
npx prisma generate
```

### Run in Development Mode (with hot-reloading)
```bash
npm run dev
```

### Start in Production Mode
```bash
npm start
```

### Run End-to-End Local Simulation
We have provided a comprehensive simulator that runs a fully mocked predictive dialing flow, webhooks, Socket.io setups, database queries, and abandonment protocol testing:
```bash
node scratch/simulate_dialer.js
```
