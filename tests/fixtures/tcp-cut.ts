import { createServer, connect, type Socket } from "node:net";

/** Real directed TCP fault route. Existing and reconnecting traffic both cut. */
export async function tcpCut(target: string) {
  const url = new URL(`tcp://${target}`), sockets = new Set<Socket>(); let cut = false;
  const server = createServer(client => {
    if (cut) { client.destroy(); return; }
    const upstream = connect(Number(url.port), url.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket); socket.on("error", () => { client.destroy(); upstream.destroy(); });
      socket.on("close", () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { address: `127.0.0.1:${(server.address() as { port: number }).port}`,
    cut() { cut = true; for (const socket of sockets) socket.destroy(); }, heal() { cut = false; },
    async close() { cut = true; for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
