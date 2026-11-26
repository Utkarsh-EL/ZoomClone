import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { randomInt } from "node:crypto";

/** Select an available loopback endpoint. For media, choose UDP first: Windows
 * can exclude UDP ranges that are valid TCP ephemeral ports. Startup still
 * fails explicitly if another process wins the bind after reservation closes. */
export async function localPort(udp = false): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const datagram = udp ? createSocket("udp4") : undefined, server = createServer(socket => socket.destroy());
    let udpBound = false, tcpBound = false;
    try {
      let selected = 0;
      if (datagram) {
        // UDP port-zero allocation can repeatedly recycle the same candidate
        // from a TCP-excluded range. Independent candidates make retries useful.
        await new Promise<void>((resolve, reject) => { datagram.once("error", reject); datagram.bind(randomInt(10240, 49152), "127.0.0.1", () => { udpBound = true; resolve(); }); });
        selected = datagram.address().port;
      }
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(selected, "127.0.0.1", () => { tcpBound = true; resolve(); }); });
      return (server.address() as { port: number }).port;
    } catch (error) { if (attempt === 19) throw error; }
    finally {
      if (tcpBound) await new Promise<void>(resolve => server.close(() => resolve()));
      if (udpBound) await new Promise<void>(resolve => datagram!.close(() => resolve()));
    }
  }
  throw new Error("NO_LOCAL_PORT");
}
