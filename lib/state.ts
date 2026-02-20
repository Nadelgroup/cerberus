export function makeState() {
  return {
    startedAt: Date.now(),
    httpRequests: 0,
    wsConnections: 0,
    wsMessages: 0,
    catsSent: 0,
    errors: 0,
  };
}
