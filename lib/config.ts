export type AppConfig = {
  target_ip: string;
  port: number;
  cat_interval_ms: number;
  cat_mode: "url" | "bin";
  max_clients: number;
  allow_origins: string[]; // list or ["*"]
};

const DEFAULTS: AppConfig = {
  target_ip: "127.0.0.1",
  port: 8000,
  cat_interval_ms: 2500,
  cat_mode: "url",
  max_clients: 50,
  allow_origins: ["*"],
};

function clampInt(v: unknown, min: number, max: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const x = Math.floor(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function parseCfg(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

export async function loadConfig(path: string): Promise<AppConfig> {
  let text = "";
  try {
    text = await Deno.readTextFile(path);
  } catch {
    // if missing, return defaults (still valid)
    return { ...DEFAULTS };
  }

  const kv = parseCfg(text);

  const catMode = (kv.cat_mode ?? DEFAULTS.cat_mode).toLowerCase() === "bin" ? "bin" : "url";

  const allowRaw = (kv.allow_origins ?? "*").trim();
  const allowOrigins = allowRaw === "*"
    ? ["*"]
    : allowRaw.split(",").map((s) => s.trim()).filter(Boolean);

  return {
    target_ip: kv.target_ip ?? DEFAULTS.target_ip,
    port: clampInt(kv.port, 1, 65535, DEFAULTS.port),
    cat_interval_ms: clampInt(kv.cat_interval_ms, 200, 60_000, DEFAULTS.cat_interval_ms),
    cat_mode: catMode,
    max_clients: clampInt(kv.max_clients, 1, 10_000, DEFAULTS.max_clients),
    allow_origins: allowOrigins.length ? allowOrigins : ["*"],
  };
}

export async function* watchConfigFile(path: string): AsyncGenerator<void> {
  // Watch the config file (and its parent directory, for editors that write temp files)
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  const watcher = Deno.watchFs([path, parent], { recursive: false });
  for await (const ev of watcher) {
    if (ev.kind === "modify" || ev.kind === "create") yield;
  }
}
