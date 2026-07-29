/**
 * Resolves the Colyseus WebSocket endpoint.
 *
 * In development the client runs on Vite (port 5173) and the server on 2567.
 * In production both are the same origin, because the Node service serves the
 * built client itself.
 */
export function resolveServerEndpoint(): string {
  const override = import.meta.env.VITE_SERVER_URL;
  if (override) return override;

  if (import.meta.env.DEV) {
    return 'ws://localhost:2567';
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}`;
}
