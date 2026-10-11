# Portfolio Video Call Backend

Self-hosted backend that lets portfolio visitors request a browser video call with you.
Visitors never need Meet/Zoom/Teams: media flows browser-to-browser over **native WebRTC**; this server only
stores meeting requests, notifies you on Telegram, authenticates you, and relays **signaling metadata** (SDP/ICE) over Socket.IO.

> **Media vs signaling.** Socket.IO never carries audio/video. It exchanges SDP offers/answers and ICE candidates.
> WebRTC is peer-to-peer *when the network allows it*; behind symmetric NAT/strict firewalls traffic is relayed by
> your own **coturn** TURN server. Do not assume every call is direct.

## Stack
Node.js ≥ 20.11 · TypeScript (strict) · Express 4 · MongoDB/Mongoose 8 · Socket.IO 4 · Zod 3 · JWT (HS256) + Argon2id ·
Helmet · CORS allow-list · express-rate-limit 7 · Pino · Vitest + Supertest (+ socket.io-client, mongodb-memory-server).

Version-sensitive notes: Express **4** is used on purpose (async errors are forwarded by `asyncHandler`); express-rate-limit
**7** (`limit`, `standardHeaders: 'draft-7'`); Zod **3**; `argon2` ships prebuilt native binaries (Debian/glibc image used in Docker).

## Quick start (local)
```bash
cp .env.example .env
openssl rand -hex 48                                   # -> JWT_ACCESS_SECRET
echo -n "a long host password" | npm run hash-password --silent   # -> HOST_PASSWORD_HASH='...' (keep the quotes)
# edit .env: HOST_EMAIL, HOST_PASSWORD_HASH, JWT_ACCESS_SECRET, optionally TELEGRAM_*
docker compose up -d mongo                             # or any MongoDB 6/7 on 127.0.0.1:27017
npm install
npm run dev                                            # http://localhost:3000/api/health
```
Everything in Docker: `docker compose up -d --build` (backend published on `127.0.0.1:3000`; MongoDB is not published).

## Scripts
| Command | Purpose |
|---|---|
| `npm run dev` | tsx watch server |
| `npm run build` / `npm start` | compile to `dist/` / run compiled server |
| `npm run typecheck` | `tsc --noEmit` (src, tests, scripts) |
| `npm run lint` | ESLint |
| `npm test` | all tests · `test:unit` · `test:integration` |
| `npm run hash-password` | create Argon2id hash for `HOST_PASSWORD_HASH` |
| `npm run db:indexes` | sync indexes (also drops undeclared ones) |

Integration tests use an in-memory MongoDB (binary downloaded on first run) or, if set, `MONGODB_TEST_URI` (each run uses a
random throw-away database name that is dropped afterwards). Telegram is blocked/mocked in tests; no real message is ever sent.

## Architecture
```
src/
  app.ts server.ts                 Express app factory / bootstrap + graceful shutdown
  config/    env.ts database.ts cors.ts
  models/    Meeting HostSession CallSlot HostState
  routes/ controllers/ validators/ middleware/
  services/  meeting (state transitions) · meeting.state (lifecycle table) · notification (outbox) · telegram
             auth · ice · realtime · scheduler
  sockets/   socket.server socket.auth meeting.handlers
```

### Meeting lifecycle
```
              accept (host, needs a free call slot)        both browsers report "connected"
   pending ─────────────────────────────▶ accepted ───────────────────────────────▶ in_progress ──▶ ended
     │  ├─ reject (host) ─▶ rejected          │  ├─ not started within ACCEPTED_START_TIMEOUT ─▶ expired
     │  ├─ cancel (visitor) ─▶ cancelled      │  ├─ cancel (visitor) ─▶ cancelled
     │  └─ TTL ─▶ expired                     │  └─ end (host/visitor) ─▶ ended
                                                               in_progress ends: host/visitor end · MEETING_DURATION_LIMIT
                                                               · peer gone > RECONNECT_GRACE (endedBy = system)
```
* `startedAt` is set (and status becomes `in_progress`) **only when both** the host and the visitor have emitted `call:connected`,
  which the frontend must send when `RTCPeerConnection.connectionState === "connected"`. A button click never starts a call.
* Every transition is a single conditional `findOneAndUpdate` (`status ∈ allowedFrom(target)`), so two simultaneous accepts cannot both win.
* Terminal meetings get `purgeAt`; a MongoDB TTL index deletes them after `MEETING_RETENTION_DAYS`. Pending/active meetings are never
  TTL-deleted: expiry is application logic (lazy on read + a sweeper every `SWEEP_INTERVAL_MS`).

### Availability and concurrent calls
* `MAX_ACTIVE_CALLS` (default 1) is enforced by the `CallSlot` collection: one document per busy slot with unique indexes on `slot` and
  `roomId`. Acquiring a slot is an atomic insert, so it holds across multiple backend instances (MongoDB is the arbiter).
  Slots are released on every terminal transition; a reconciler removes orphaned slots (> 60 s old, no active meeting).
* `PUT /api/host/availability {available:false}` makes new requests fail with 503 `host_unavailable`.
* Duplicate/abusive requests: `MAX_PENDING_PER_VISITOR` (keyed HMAC of client IP, raw IPs are never stored), `MAX_PENDING_REQUESTS`,
  and `POST /api/host/meetings/bulk/reject-pending`. These pending-count checks are soft limits (check-then-insert); the hard
  guarantees are the slot and transition atomicity above.
* If the host is offline, requests stay `pending`, you still get the Telegram alert, and they expire after `MEETING_REQUEST_TTL_SECONDS`.
* **Limitation:** Socket.IO rooms are in-process. Run **one** backend instance, or add `@socket.io/redis-adapter` + sticky sessions
  and a shared rate-limit store (`rate-limit-redis`) before scaling out. Database correctness does not depend on this.

### Notifications (transactional outbox)
The outbox state lives inside the Meeting document (`notification.*`), so a meeting and its pending alert are created atomically.
A worker claims a row with a 30 s lease (`lockedUntil`), sends to Telegram, then marks `sent`. 429/5xx/network errors retry with
exponential backoff (honouring `retry_after`) up to `NOTIFY_MAX_ATTEMPTS`; 4xx errors fail permanently. Telegram failures never roll
back the meeting. Delivery is at-least-once: the only duplicate window is a crash between Telegram's reply and the database write.
Messages are plain text (no `parse_mode`), contain no tokens, and the dashboard link is a bare URL that still requires login.
Telegram inline buttons are intentionally **not** implemented: accept/reject happens in the authenticated dashboard.

## Security summary
Helmet · explicit CORS allow-list (HTTP and Socket.IO `allowRequest`) · 16 KB body limit · Zod validation (strict objects, so
`{"$ne":null}` style payloads are rejected) · rate limits (global, meeting creation, login by IP **and** by e-mail, host API) ·
Argon2id (constant-time-ish login incl. dummy verify) · HS256 JWT pinned to algorithm/issuer/audience **plus** a revocable server-side
session (logout takes effect immediately and disconnects live sockets) · 192-bit room ids · 256-bit visitor tokens stored only as
SHA-256 · every socket event re-validated (role from verified handshake, room membership, DB status) · SDP ≤ 20 KB, 64 KB socket buffer,
per-socket event budget · sanitized errors · pino redaction · env validated at startup · graceful shutdown.
Visitor text is stored as plain text: **render it with `textContent`/React escaping, never as HTML.**
Use HTTPS in production (camera/microphone require a secure context except on `localhost`).

## API reference
All responses: `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code", "message", "details?" } }`. All responses are `Cache-Control: no-store`.
Schemas: [`docs/openapi.yaml`](docs/openapi.yaml). `$API` = `http://localhost:3000`.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /api/health` | – | `200 {status:"ok",database:"up"}` / `503` when DB is down |
| `GET /api/availability` | – | `{available, busy}` |
| `POST /api/meetings` | – (rate limited) | body `{visitorName (1-80), visitorMessage? (≤500)}` → `201 {id, roomId, status, createdAt, expiresAt, visitorToken}`. **`visitorToken` is shown once.** Errors: 400 `validation_error`, 409 `duplicate_pending`, 429 `rate_limited`, 503 `host_unavailable`/`queue_full` |
| `GET /api/meetings/:roomId/status` | – | `{roomId,status,createdAt,expiresAt,acceptedAt,endedAt}` only; 404/400 |
| `POST /api/meetings/:roomId/cancel` | `X-Visitor-Token` | pending/accepted → cancelled. 401 missing, 403 wrong token, 409 `invalid_state` |
| `GET /api/meetings/:roomId/ice-servers` | `X-Visitor-Token` | `{iceServers}` while accepted/in_progress |
| `POST /api/host/auth/login` | – (rate limited) | `{email,password}` → `{accessToken, tokenType:"Bearer", expiresAt}`; 401 `invalid_credentials`, 429 |
| `POST /api/host/auth/logout` | Bearer | revokes the session |
| `GET /api/host/meetings?status=&limit=` | Bearer | recent + pending, newest first |
| `GET /api/host/meetings/:roomId` | Bearer | host view |
| `POST /api/host/meetings/:roomId/accept` | Bearer | 409 `host_busy` / `meeting_expired` / `invalid_state` |
| `POST /api/host/meetings/:roomId/reject` | Bearer | 409 `meeting_expired` / `invalid_state` |
| `POST /api/host/meetings/:roomId/end` | Bearer | accepted/in_progress → ended |
| `POST /api/host/meetings/bulk/reject-pending` | Bearer | `{rejected: n}` |
| `GET/PUT /api/host/availability` | Bearer | PUT `{available:boolean}` |
| `GET /api/host/ice-servers` | Bearer | ICE servers for the host browser |
| `POST /api/host/telegram/test` | Bearer | 200 only if Telegram accepted it; 502 `telegram_error` otherwise; 409 if unconfigured |

```bash
curl -s $API/api/meetings -H 'content-type: application/json' -d '{"visitorName":"John","visitorMessage":"Project chat"}'
curl -s $API/api/meetings/$ROOM/status
curl -s -X POST $API/api/meetings/$ROOM/cancel -H "X-Visitor-Token: $VISITOR_TOKEN"
TOKEN=$(curl -s $API/api/host/auth/login -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"..."}' | jq -r .data.accessToken)
curl -s $API/api/host/meetings -H "Authorization: Bearer $TOKEN"
curl -s -X POST $API/api/host/meetings/$ROOM/accept -H "Authorization: Bearer $TOKEN"
curl -s -X POST $API/api/host/telegram/test -H "Authorization: Bearer $TOKEN"
```

## Socket.IO contract
Connect with credentials in the handshake (no cookies). Wrong/missing credentials → `connect_error` with message `unauthorized`.
```js
// Host dashboard
const socket = io(API, { auth: { role: 'host', token: accessToken }, transports: ['websocket'] });
// Visitor
const socket = io(API, { auth: { role: 'visitor', roomId, visitorToken }, transports: ['websocket'] });
```
`role` only selects which credential is verified; it grants nothing. Client→server events use acks: `{ok:true,data?}` or `{ok:false,error:{code,message}}`
(errors are also emitted as `call:error`). Every call-related payload carries `roomId`.

| Event (client → server) | Who | Payload | Effect |
|---|---|---|---|
| `host:register` | host | `{}` | authenticated host joins the host channel; ack `{pending[], availability}` |
| `host:join-room` | host | `{roomId}` | meeting must be accepted/in_progress; joins that signaling room |
| `meeting:join` | visitor | `{roomId?}` (must equal handshake room) | joins only the meeting bound to the visitor token; ack = public status |
| `call:ready` | both | `{roomId}` | local media and handlers are ready. Once both are ready, the **host** gets one `call:begin` |
| `call:offer` | host only | `{roomId, sdp:{type:"offer", sdp}}` | relayed to visitor |
| `call:answer` | visitor only | `{roomId, sdp:{type:"answer", sdp}}` | relayed to host |
| `call:ice-candidate` | both | `{roomId, candidate:{candidate, sdpMid?, sdpMLineIndex?, usernameFragment?}}` | relayed to peer |
| `call:connected` | both | `{roomId}` | send when `connectionState==="connected"`; both → `in_progress` |
| `call:connection-failed` | both | `{roomId, reason:"ice_failed"\|"media_error"\|"timeout"\|"other"}` | peer receives `call:error` |
| `call:end` | both | `{roomId}` | ends the call (`endedBy` = caller's authenticated role); server broadcasts `call:ended` |

| Event (server → client) | Payload |
|---|---|
| `meeting:new` (hosts) | host view of the new request |
| `meeting:updated` (hosts) | host view after any transition |
| `meeting:status` / `meeting:accepted` / `meeting:rejected` / `meeting:expired` / `meeting:cancelled` | `{roomId,status,createdAt,expiresAt,acceptedAt,endedAt,endedBy,reason}`; acceptance/rejection are triggered by the authenticated host REST dashboard actions |
| `meeting:visitor-connected` / `meeting:visitor-disconnected` (hosts) | `{roomId}` |
| `host:availability` (hosts) | availability |
| `call:peer-joined` / `call:peer-ready` / `call:peer-disconnected` | `{roomId, role}` |
| `call:begin` (host) | `{roomId}` – create the offer now |
| `call:offer` / `call:answer` / `call:ice-candidate` | as sent, relayed |
| `call:started` | status payload (`in_progress`) |
| `call:ended` | status payload; `reason`: `host_ended`, `visitor_ended`, `duration_limit`, `peer_disconnected` … |
| `call:error` | `{code,message,event?,reason?}` (`invalid_payload`, `wrong_room`, `invalid_state`, `rate_limited`, `peer_connection_failed`, `token_expired`) |

Negotiation is intentionally **host-offerer / visitor-answerer**. The server permits offers only from the authenticated host and answers
only from the token-authorized visitor, so simultaneous offers (offer glare) cannot occur. `call:begin` is emitted once when both
participants first report readiness; duplicate `call:ready` messages do not start extra negotiations. SDP is capped at 20 KB, ICE
candidate strings at 2 KB, Socket.IO frames at 64 KB, and each socket has a rolling event-rate budget. Signaling is allowed only for
the current registered participant socket and while the meeting is `accepted` or `in_progress`; terminal meetings cannot signal.

Disconnect handling: a new socket for a participant replaces and disconnects its previous socket. Cleanup clears its
`visitorSocketId`/`hostSocketId` only if the disconnecting socket is still the registered one (a reconnect is not clobbered). If a
participant of an `accepted`/`in_progress` call drops, the peer gets `call:peer-disconnected`; after
`RECONNECT_GRACE_SECONDS` without both sides, an in-progress call is ended by the system. A visitor leaving while `pending` keeps the
request alive until it expires (they may refresh).

## Frontend integration
**Visitor**
1. `POST /api/meetings` → keep `roomId` and `visitorToken` in memory (or `sessionStorage`); never put them in URLs.
2. Open the socket (visitor auth), `emit('meeting:join')`, listen for `meeting:accepted|rejected|expired|cancelled`
   (poll `GET .../status` as a fallback). Cancel button → `POST .../cancel`.
3. On `meeting:accepted`, the host will create the offer after both participants have emitted `call:ready`; the visitor only answers:
```js
const { iceServers } = (await api.get(`/api/meetings/${roomId}/ice-servers`, { 'X-Visitor-Token': visitorToken })).data;
const pc = new RTCPeerConnection({ iceServers });
const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });   // HTTPS or localhost
stream.getTracks().forEach(t => pc.addTrack(t, stream));
pc.ontrack = e => { remoteVideo.srcObject = e.streams[0]; };
pc.onicecandidate = e => e.candidate && socket.emit('call:ice-candidate', { roomId, candidate: e.candidate.toJSON() });
pc.onconnectionstatechange = () => {
  if (pc.connectionState === 'connected') socket.emit('call:connected', { roomId });
  if (pc.connectionState === 'failed') socket.emit('call:connection-failed', { roomId, reason: 'ice_failed' });
};
socket.on('call:offer', async ({ sdp }) => {
  await pc.setRemoteDescription(sdp);
  await pc.setLocalDescription(await pc.createAnswer());
  socket.emit('call:answer', { roomId, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
});
socket.on('call:ice-candidate', ({ candidate }) => pc.addIceCandidate(candidate));
socket.on('call:ended', () => { pc.close(); stream.getTracks().forEach(t => t.stop()); });
socket.emit('call:ready', { roomId });          // after local media + handlers exist
```
**Host dashboard**
1. `POST /api/host/auth/login` → access token (keep in memory; re-login when it expires). Open the host socket, `emit('host:register')`.
2. Render `meeting:new` / `meeting:updated`; escape visitor text. Accept/Reject → REST.
3. After accepting: `emit('host:join-room', {roomId})`, fetch `/api/host/ice-servers`, create the `RTCPeerConnection` with the same
   handlers as above, `emit('call:ready', {roomId})`, then **on `call:begin`**:
```js
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
socket.emit('call:offer', { roomId, sdp: { type: offer.type, sdp: offer.sdp } });
socket.on('call:answer', ({ sdp }) => pc.setRemoteDescription(sdp));
```
   (`call:ice-candidate`, `call:connected` as for the visitor). **End** → `POST /api/host/meetings/:roomId/end`.
ICE candidates may arrive before `setRemoteDescription`; queue them until it completes. Candidates received via `call:ice-candidate`
for a stale connection should be ignored after `call:ended`.

The backend never receives or stores media tracks. Browsers use `getUserMedia()` and `RTCPeerConnection`; Socket.IO relays only
validated SDP and ICE signaling data. Configure public STUN URLs with `STUN_URLS`; TURN is optional and can use the included coturn
configuration with `TURN_URL` plus shared-secret or static credentials. TURN relays encrypted peer media only when direct ICE
connectivity fails; it is self-hosted rather than a hosted calling provider.

## Configuration
See `.env.example` (every variable documented; invalid configuration aborts startup with a readable message that never prints values).
`HOST_PASSWORD_HASH` must be single-quoted because it contains `$`. In `docker-compose.yml` the backend gets its own `MONGODB_URI`
that uses the hostname `mongo`, which exists **only inside the compose network**; a browser on another device only ever talks to your
public HTTPS domain.

## Deployment on your own VPS
1. DNS: `api.example.com` → VPS. Install Docker, `git clone`, `cp .env.example .env`, set `NODE_ENV=production`, `FRONTEND_ORIGINS=https://example.com`,
   `TRUST_PROXY=1`, strong `JWT_ACCESS_SECRET`, `HOST_*`, Telegram, `MONGO_ROOT_PASSWORD` (alphanumeric).
2. `docker compose up -d --build` (backend only on `127.0.0.1:3000`).
3. Reverse proxy with HTTPS (WebSocket upgrade required).

### Deploying on Render
The repository includes `render.yaml` with the correct repository root, TypeScript build command, start command, and health check.
Create or update a Render Blueprint from this repository to apply it. For an existing Web Service that is not managed by a Blueprint,
set **Root Directory** to the repository root (leave it blank), **Build Command** to `npm ci && npm run build`, and
**Start Command** to `npm start`, then trigger a new deploy. The build log must show `tsc -p tsconfig.build.json` completing
successfully before the service starts; this produces `dist/server.js` at the repository root. Set `MONGODB_URI`,
`FRONTEND_ORIGINS`, `HOST_EMAIL`, and `HOST_PASSWORD_HASH` in Render's environment settings. Configure a strong
`JWT_ACCESS_SECRET` there as well (the Blueprint generates one for new Blueprint-managed services). Do not upload `.env` to Git.

Caddy (automatic certificates):
```
api.example.com {
    reverse_proxy 127.0.0.1:3000
}
```
nginx (certbot for TLS):
```nginx
server {
  listen 443 ssl http2;
  server_name api.example.com;
  # ssl_certificate / ssl_certificate_key from certbot
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
  }
}
```
Keep `TRUST_PROXY` equal to the number of proxies in front of the app; otherwise all visitors share one rate-limit bucket (too low)
or clients can spoof their IP (too high).
4. Back up the `mongo-data` volume (`mongodump`). Cleanup of expired meetings/sessions is automatic (sweeper + TTL indexes).
5. Logs: `docker compose logs -f backend` (JSON, secrets redacted).

### TURN server (coturn, self-hosted)
1. Set in `.env`: `TURN_EXTERNAL_IP` (public IP), `TURN_REALM`, `TURN_SHARED_SECRET` (`openssl rand -hex 32`), and
   `STUN_URLS=stun:turn.example.com:3478`, `TURN_URL=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp`
   (add `turns:turn.example.com:5349?transport=tcp` once TLS certificates are mounted in `docker/turnserver.conf`).
2. `docker compose --profile turn up -d`.
3. Firewall: **3478 UDP+TCP**, **5349 TCP** (TURNS), and the relay range **49160-49200 UDP** (matches `min-port`/`max-port`).
4. Credentials are short-lived (HMAC, `TURN_CREDENTIAL_TTL_SECONDS`) and issued only to authorized participants via the ICE endpoints.
5. Verify with the browser's `chrome://webrtc-internals` (look for `relay` candidates) or Trickle ICE test page against your own server.

## Operational notes
* Host sessions last `JWT_ACCESS_TTL` (no refresh tokens are implemented; the host logs in again). Logout revokes the session server-side.
* Meeting-specific visitor tokens live as long as the meeting row; they stop working once the meeting is terminal (signaling is refused).
* MongoDB must be reachable at startup; indexes are created by the app (`initIndexes`).
