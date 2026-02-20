let ws = null;
let pendingMime = "image/jpeg";
let lastObjectUrl = null;

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const imgEl = $("catImg");
const logEl = $("log");

const modeSel = $("modeSel");
const intervalInp = $("intervalInp");

const targetIpEl = $("targetIp");
const uptimeEl = $("uptime");
const clientsEl = $("clients");
const catsSentEl = $("catsSent");
const moodEl = $("mood");

function log(line) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent = `[${ts}] ${line}\n` + logEl.textContent;
}

function setStatus(s) {
  statusEl.textContent = s;
}

function cleanupImgUrl() {
  if (lastObjectUrl) {
    URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = null;
  }
}

function closeWs() {
  if (ws) ws.close();
  ws = null;
  setStatus("disconnected");
}

function applySettings() {
  const mode = modeSel.value;
  const ms = Number(intervalInp.value);

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("not connected");
    return;
  }

  ws.send(JSON.stringify({ cmd: "mode", mode }));
  ws.send(JSON.stringify({ cmd: "interval", ms }));
}

$("btnConnect").onclick = () => {
  closeWs();
  cleanupImgUrl();

  ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    setStatus("connected");
    log("connected");
    applySettings();
  };

  ws.onclose = () => {
    setStatus("disconnected");
    log("disconnected");
  };

  ws.onerror = () => log("ws error");

  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data);

        if (msg.type === "hello") {
          log(`hello: id=${msg.id}`);
          if (msg.config) {
            targetIpEl.textContent = msg.config.target_ip ?? "—";
            intervalInp.value = String(msg.config.cat_interval_ms ?? intervalInp.value);
            modeSel.value = msg.config.cat_mode ?? modeSel.value;
          }
          return;
        }

        if (msg.type === "config" && msg.config) {
          targetIpEl.textContent = msg.config.target_ip ?? targetIpEl.textContent;
          log("config updated (hot reload)");
          return;
        }

        if (msg.type === "cat") {
          if (msg.mode === "url") {
            cleanupImgUrl();
            imgEl.src = msg.url;
          } else if (msg.mode === "bin") {
            // Next frame is binary. Remember mime:
            pendingMime = msg.mime || "image/jpeg";
          }
          return;
        }

        if (msg.type === "help") {
          log("commands:\n- " + msg.commands.join("\n- "));
          return;
        }

        if (msg.type === "ok") {
          log("ok: " + msg.message);
          return;
        }

        if (msg.type === "error") {
          log("error: " + msg.message);
          return;
        }

        if (msg.type === "pong") {
          log("pong");
          return;
        }

        if (msg.type === "you") {
          log(`you: ${JSON.stringify(msg)}`);
          return;
        }

        log("msg: " + ev.data);
      } catch {
        log("text: " + ev.data);
      }
      return;
    }

    // binary image payload
    try {
      const blob = new Blob([ev.data], { type: pendingMime });
      cleanupImgUrl();
      lastObjectUrl = URL.createObjectURL(blob);
      imgEl.src = lastObjectUrl;
    } catch (e) {
      log("bin decode error: " + String(e));
    }
  };
};

$("btnClose").onclick = closeWs;

$("btnApply").onclick = applySettings;

$("btnSend").onclick = () => {
  const v = $("cmdInp").value.trim();
  if (!v) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log("not connected");
    return;
  }
  ws.send(v);
  log("> " + v);
  $("cmdInp").value = "";
};

$("cmdInp").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btnSend").click();
});

// Copy IP button (display-only; no connections)
$("btnCopyIp").onclick = async () => {
  const txt = targetIpEl.textContent || "";
  await navigator.clipboard.writeText(txt);
  log("copied target IP");
};

// SSE live pulse
(function startSse() {
  const es = new EventSource("/events");

  es.addEventListener("hello", (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.config) targetIpEl.textContent = msg.config.target_ip ?? targetIpEl.textContent;
      log("SSE hello");
    } catch {}
  });

  es.addEventListener("pulse", (ev) => {
    try {
      const p = JSON.parse(ev.data);
      uptimeEl.textContent = `${p.uptime_s}s`;
      clientsEl.textContent = String(p.clients);
      catsSentEl.textContent = String(p.cats_sent);
      moodEl.textContent = p.mood || "—";
    } catch {}
  });

  es.addEventListener("config", (ev) => {
    try {
      const c = JSON.parse(ev.data);
      targetIpEl.textContent = c.target_ip ?? targetIpEl.textContent;
      log("SSE config update");
    } catch {}
  });

  es.onerror = () => {
    // EventSource auto-reconnects
  };
})();