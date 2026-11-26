import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { test } from "node:test";
import { localPort } from "../scripts/local-port.ts";

test("selected media ports can bind both protocols while other media reservations remain occupied", async () => {
  const held: { tcp: ReturnType<typeof createServer>; udp: ReturnType<typeof createSocket> }[] = [];
  const ports = new Set<number>();
  try {
    for (let i = 0; i < 20; i++) {
      const port = await localPort(true), tcp = createServer(), udp = createSocket("udp4");
      assert.equal(ports.has(port), false); ports.add(port);
      await new Promise<void>((resolve, reject) => { tcp.once("error", reject); tcp.listen(port, "127.0.0.1", resolve); });
      await new Promise<void>((resolve, reject) => { udp.once("error", reject); udp.bind(port, "127.0.0.1", resolve); });
      held.push({ tcp, udp });
    }
  } finally { for (const item of held) { await new Promise<void>(resolve => item.tcp.close(() => resolve())); await new Promise<void>(resolve => item.udp.close(() => resolve())); } }
});
