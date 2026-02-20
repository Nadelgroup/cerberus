# catcaster (Deno)

A small multi-file Deno app that:
- Upgrades `/ws` to WebSocket and streams random cat images
- Supports 2 WS modes:
  - `url`: sends JSON with an image URL
  - `bin`: sends JSON header + binary image bytes as the next frame
- Reads `default.cfg` (contains `target_ip`) and displays it in UI (display-only; no outbound connection)
- Serves a web UI from `public/`
- Serves a file viewer from `data/` via `/files/...`
- SSE dashboard stream at `/events`
- Hot-reloads config and pushes updates to WS + SSE

## Run

From the `catcaster/` folder:

```bash
deno task dev
# or:
deno task start