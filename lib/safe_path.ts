function normalize(p: string) {
  // Force forward slashes, drop query-ish stuff
  return p.replaceAll("\\", "/");
}

export function safeJoin(root: string, requested: string) {
  const req = normalize(requested);

  // Ensure it starts with '/'
  const rel = req.startsWith("/") ? req : `/${req}`;

  // Collapse /./ and reject /../
  const parts = rel.split("/").filter((x) => x.length > 0);

  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") throw new Error("path traversal denied");
    if (part.includes("\0")) throw new Error("bad path");
  }

  // Rebuild
  const clean = parts.join("/");
  return `${root}/${clean}`;
}
