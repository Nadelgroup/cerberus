import { loadConfig, watchConfigFile, type AppConfig } from "./lib/config.ts";
import { randomCatUrl, fetchCatBytes } from "./lib/cat.ts";
import { contentTypeFromPath } from "./lib/mime.ts";
import { safeJoin } from "./lib/safe_path.ts";
import { makeState } from "./lib/state.ts";

const CONFIG_PATH = Deno.env.get("CATCASTER_CONFIG") ?? "./default.cfg";
let config: AppConfig = await loadConfig(CONFIG_PATH);

const state = makeState();

type WsClient = {
  ws: WebSocket;
  id: string;
  intervalMs: number;
  paused: boolean;
  lastSentAt: number;
  mode: "url" | "bin";
};

const clients = new Map<string, WsClient>();

type SseClient = { id: string; ctrl: ReadableStreamDefaultController<Uint8Array> };
const sseClients = new Map<string, SseClient>();

function nowMs() {
  return Date.now();
}

function uid() {
  // short id
  return crypto.randomUUID().split("-")[0]!;
}

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function text(data: string, status = 200, extraHeaders: HeadersInit = {}) {
  return new Response(data, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...extraHeaders },
  });
}

function html(data: string, status = 200, extraHeaders: HeadersInit = {}) {
  return new Response(data, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders },
  });
}

function corsHeaders(origin: string | null): HeadersInit {
  const allow = config.allow_origins;
  if (allow.includes("*")) {
    return {
      "access-control-allow-origin": origin ?? "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
  }

  if (origin && allow.includes(origin)) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
  }

  return {};
}

function originAllowed(origin: string | null): boolean {
  if (!origin) return true;
  if (config.allow_origins.includes("*")) return true;
  return config.allow_origins.includes(origin);
}

function broadcastSse(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const bytes = new TextEncoder().encode(payload);
  for (const { ctrl } of sseClients.values()) {
    try {
      ctrl.enqueue(bytes);
    } catch {
      // ignore; client cleanup happens on stream cancel
    }
  }
}

function broadcastConfigUpdate() {
  broadcastSse("config", safeConfigForClient());
  for (const c of clients.values()) {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify({ type: "config", config: safeConfigForClient() }));
    }
  }
}

function safeConfigForClient() {
  return {
    target_ip: config.target_ip,
    port: config.port,
    cat_interval_ms: config.cat_interval_ms,
    cat_mode: config.cat_mode,
    max_clients: config.max_clients,
  };
}

// --- Cool feature: rotating “mood” banner ---
const MOODS = [
  "Purring packets 🐾",
  "Cat delivery in progress 🚚🐱",
  "MeowSockets online ⚡",
  "Feline frames incoming 🖼️",
  "Whisker-powered streaming 🎛️",
];
function randomMood() {
  return MOODS[Math.floor(Math.random() * MOODS.length)]!;
}

// --- Global tick: sends to each client with per-client interval control ---
let ticker: number | null = null;

function startTickerIfNeeded() {
  if (ticker !== null) return;

  ticker = setInterval(async () => {
    const t = nowMs();
    if (clients.size === 0) return;

    // URL mode can be generated without fetch; BIN needs fetch
    // To avoid multiple fetches per tick, we fetch at most once if anyone wants BIN
    const someoneWantsBin = Array.from(clients.values()).some((c) => c.mode === "bin" && !c.paused);
    let binPayload: { type: string; bytes: Uint8Array } | null = null;

    if (someoneWantsBin) {
      try {
        binPayload = await fetchCatBytes();
      } catch (e) {
        state.errors++;
        for (const c of clients.values()) {
          if (c.ws.readyState === WebSocket.OPEN) {
            c.ws.send(JSON.stringify({ type: "error", message: String(e) }));
          }
        }
      }
    }

    for (const c of clients.values()) {
      if (c.paused) continue;
      if (c.ws.readyState !== WebSocket.OPEN) continue;

      if (t - c.lastSentAt < c.intervalMs) continue;
      c.lastSentAt = t;

      try {
        if (c.mode === "url") {
          const url = randomCatUrl();
          c.ws.send(JSON.stringify({ type: "cat", mode: "url", url, ts: t }));
          state.catsSent++;
        } else {
          if (!binPayload) continue;
          c.ws.send(JSON.stringify({ type: "cat", mode: "bin", mime: binPayload.type, ts: t }));
          c.ws.send(binPayload.bytes); // binary frame
          state.catsSent++;
        }
      } catch {
        // client might have gone away
      }
    }

    // tiny live “pulse” to SSE dashboard
    broadcastSse("pulse", {
      uptime_s: Math.floor((nowMs() - state.startedAt) / 1000),
      clients: clients.size,
      cats_sent: state.catsSent,
      mood: randomMood(),
    });
  }, 250) as unknown as number; // base tick, per-client intervals handled above
}

function stopTickerIfNoClients() {
  if (clients.size === 0 && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

// --- Static file serving (public/) + a “data/” viewer ---
async function serveFile(path: string) {
  const file = await Deno.open(path, { read: true });
  const stat = await file.stat();

  const headers = new Headers();
  headers.set("content-type", contentTypeFromPath(path));
  headers.set("content-length", String(stat.size));
  headers.set("cache-control", path.includes("/public/") ? "public, max-age=60" : "no-store");

  return new Response(file.readable, { status: 200, headers });
}

async function servePublic(req: Request, pathname: string) {
  const publicRoot = "./public";
  const rel = pathname === "/" ? "/index.html" : pathname;
  const full = safeJoin(publicRoot, rel);

  try {
    return await serveFile(full);
  } catch {
    return null;
  }
}

async function serveDataFile(req: Request, pathname: string) {
  // /files/<name>
  const dataRoot = "./data";
  const rel = pathname.slice("/files".length) || "/";
  const full = safeJoin(dataRoot, rel);

  try {
    const raw = await Deno.readTextFile(full);
    // cool feature: render as HTML with tiny “viewer”
    const escaped = raw
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

    const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>File Viewer</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="wrap">
    <a class="pill" href="/">← Back</a>
    <h2>Viewing: <code>${full}</code></h2>
    <pre class="viewer">${escaped}</pre>
  </div>
</body>
</html>`;
    return html(page);
  } catch {
    return null;
  }
}

// --- WebSocket handlers ---
function handleWs(req: Request) {
  const origin = req.headers.get("origin");
  if (!originAllowed(origin)) return text("Origin not allowed", 403);

  if (clients.size >= config.max_clients) return text("Too many clients", 429);

  const { socket, response } = Deno.upgradeWebSocket(req);
  const id = uid();

  const client: WsClient = {
    ws: socket,
    id,
    intervalMs: config.cat_interval_ms,
    paused: false,
    lastSentAt: 0,
    mode: config.cat_mode,
  };

  clients.set(id, client);
  state.wsConnections++;
  startTickerIfNeeded();

  socket.onopen = () => {
    socket.send(
      JSON.stringify({
        type: "hello",
        id,
        mood: randomMood(),
        config: safeConfigForClient(),
        tips: [
          'Try commands: "help", "interval 1200", "pause", "resume", "mode url", "mode bin"',
          'Or send JSON: {"cmd":"interval","ms":1200}',
        ],
      }),
    );
  };

  socket.onmessage = (ev) => {
    state.wsMessages++;

    // Allow plain text commands OR JSON
    const handleCommand = (cmd: string, args: string[]) => {
      const c = clients.get(id);
      if (!c) return;

      const reply = (obj: unknown) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
      };

      switch (cmd) {
        case "help":
          reply({
            type: "help",
            commands: [
              "help",
              "interval <ms>      (per-client)",
              "pause | resume",
              "mode url | mode bin (per-client)",
              "ping",
              "whoami",
            ],
          });
          break;

        case "interval": {
          const ms = Number(args[0]);
          if (!Number.isFinite(ms) || ms < 200 || ms > 60_000) {
            reply({ type: "error", message: "interval must be 200..60000 ms" });
            break;
          }
          c.intervalMs = ms;
          reply({ type: "ok", message: `interval set to ${ms} ms` });
          break;
        }

        case "pause":
          c.paused = true;
          reply({ type: "ok", message: "paused" });
          break;

        case "resume":
          c.paused = false;
          reply({ type: "ok", message: "resumed" });
          break;

        case "mode": {
          const m = (args[0] ?? "").toLowerCase();
          if (m !== "url" && m !== "bin") {
            reply({ type: "error", message: 'mode must be "url" or "bin"' });
            break;
          }
          c.mode = m;
          reply({ type: "ok", message: `mode set to ${m}` });
          break;
        }

        case "ping":
          reply({ type: "pong", ts: Date.now() });
          break;

        case "whoami":
          reply({ type: "you", id: c.id, intervalMs: c.intervalMs, paused: c.paused, mode: c.mode });
          break;

        default:
          reply({ type: "error", message: `unknown command: ${cmd}` });
      }
    };

    if (typeof ev.data === "string") {
      const s = ev.data.trim();
      if (!s) return;

      if (s.startsWith("{")) {
        try {
          const obj = JSON.parse(s) as { cmd?: string; [k: string]: unknown };
          const cmd = String(obj.cmd ?? "");
          if (!cmd) return;
          if (cmd === "interval") handleCommand("interval", [String(obj.ms ?? "")]);
          else if (cmd === "mode") handleCommand("mode", [String(obj.mode ?? "")]);
          else if (cmd === "pause") handleCommand("pause", []);
          else if (cmd === "resume") handleCommand("resume", []);
          else if (cmd === "help") handleCommand("help", []);
          else if (cmd === "ping") handleCommand("ping", []);
          else if (cmd === "whoami") handleCommand("whoami", []);
          else handleCommand(cmd, []);
          return;
        } catch {
          // fall through to text parsing
        }
      }

      const [cmd, ...args] = s.split(/\s+/);
      handleCommand(cmd.toLowerCase(), args);
    }
  };

  const cleanup = () => {
    clients.delete(id);
    stopTickerIfNoClients();
  };

  socket.onclose = cleanup;
  socket.onerror = cleanup;

  return response;
}

// --- SSE endpoint ---
function handleSse(req: Request) {
  const id = uid();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseClients.set(id, { id, ctrl: controller });

      // hello event
      controller.enqueue(
        encoder.encode(`event: hello\ndata: ${JSON.stringify({ id, mood: randomMood(), config: safeConfigForClient() })}\n\n`),
      );

      // keepalive every 15s
      const keep = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`event: keepalive\ndata: {"t":${Date.now()}}\n\n`));
        } catch {
          // ignored
        }
      }, 15000);

      // cleanup on cancel
      (stream as unknown as { _keep?: number })._keep = keep as unknown as number;
    },
    cancel() {
      const keep = (stream as unknown as { _keep?: number })._keep;
      if (keep) clearInterval(keep);
      sseClients.delete(id);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "connection": "keep-alive",
    },
  });
}

// --- Tiny request logger (cool feature) ---
async function withLog(req: Request, handler: () => Promise<Response> | Response): Promise<Response> {
  const t0 = performance.now();
  try {
    const res = await handler();
    const dt = Math.round(performance.now() - t0);
    console.log(`${req.method} ${new URL(req.url).pathname} -> ${res.status} (${dt}ms)`);
    return res;
  } catch (e) {
    const dt = Math.round(performance.now() - t0);
    console.log(`${req.method} ${new URL(req.url).pathname} -> 500 (${dt}ms)`);
    state.errors++;
    return text(`Internal error: ${String(e)}`, 500);
  }
}

// --- Config hot-reload (cool feature) ---
(async () => {
  for await (const _ of watchConfigFile(CONFIG_PATH)) {
    try {
      config = await loadConfig(CONFIG_PATH);
      // update existing clients defaults only if they haven't changed per-client
      for (const c of clients.values()) {
        // keep their current mode/interval; but if you want global override, change this
      }
      broadcastConfigUpdate();
      console.log("Config reloaded from", CONFIG_PATH);
    } catch (e) {
      console.log("Config reload failed:", String(e));
      state.errors++;
    }
  }
})();

// --- Main server ---
Deno.serve({ port: config.port }, (req) =>
  withLog(req, async () => {
    state.httpRequests++;

    const url = new URL(req.url);
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      const origin = req.headers.get("origin");
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // API
    if (pathname === "/api/health") {
      return json({ ok: true, at: new Date().toISOString(), mood: randomMood() }, 200, corsHeaders(req.headers.get("origin")));
    }

    if (pathname === "/api/config") {
      return json(safeConfigForClient(), 200, corsHeaders(req.headers.get("origin")));
    }

    if (pathname === "/api/stats") {
      return json(
        {
          uptime_s: Math.floor((nowMs() - state.startedAt) / 1000),
          clients: clients.size,
          sse_clients: sseClients.size,
          cats_sent: state.catsSent,
          http_requests: state.httpRequests,
          ws_connections: state.wsConnections,
          ws_messages: state.wsMessages,
          errors: state.errors,
        },
        200,
        corsHeaders(req.headers.get("origin")),
      );
    }

    if (pathname === "/api/cat/preview") {
      // redirects to a random cat
      return new Response(null, { status: 302, headers: { location: randomCatUrl() } });
    }

    // WebSockets
    if (pathname === "/ws") {
      return handleWs(req);
    }

    // SSE
    if (pathname === "/events") {
      return handleSse(req);
    }

    // Data file viewer
    if (pathname.startsWith("/files")) {
      const res = await serveDataFile(req, pathname);
      if (res) return res;
      return text("Not found", 404);
    }

    // Public assets (UI)
    const pub = await servePublic(req, pathname);
    if (pub) return pub;

    return text("Not found", 404);
  }),
);

console.log(`catcaster listening on http://localhost:${config.port}`);
console.log(`websocket: ws://localhost:${config.port}/ws`);
console.log(`SSE:       http://localhost:${config.port}/events`);
console.log(`files:     http://localhost:${config.port}/files/sample.txt`);