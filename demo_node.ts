/** Automated node scenario; each invocation runs in an independent OS process. */

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { Participant } from "./client.ts";
import { configureLogging, intOption, usageError } from "./protocol.ts";

const TOPIC = "meeting.announcements";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      role: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string" },
      meeting: { type: "string", default: "demo-room" },
      "log-dir": { type: "string" },
      "ready-file": { type: "string" },
    },
  });
  const name = values.name ?? usageError("the following argument is required: --name");
  const logDir = values["log-dir"] ?? usageError("the following argument is required: --log-dir");
  if (values.role !== "publisher" && values.role !== "subscriber") {
    usageError("argument --role: choose from 'publisher', 'subscriber'");
  }
  const log = configureLogging(name, logDir, true);
  const user = new Participant(name, {
    meeting: values.meeting, host: values.host, port: intOption("port", values.port), logger: log, trace: true,
  });
  try {
    console.log("JOIN_REPLY:", JSON.stringify(await user.connect()));
    if (values.role === "subscriber") {
      console.log("SUBSCRIBE_REPLY:", JSON.stringify(await user.subscribe(TOPIC)));
      writeFileSync(values["ready-file"] ?? usageError("--ready-file is required for subscribers"), "subscribed\n", "utf8");
      const event = await user.waitFor((packet) => packet.type === "event" && packet.body.topic === TOPIC);
      console.log("PUBSUB_RECEIVED:", event.sender, JSON.stringify(event.body));
      const group = await user.waitFor((packet) => packet.type === "group_message");
      console.log("GROUP_RECEIVED:", group.sender, JSON.stringify(group.body));
    } else {
      console.log("REQUEST_REPLY:", JSON.stringify(await user.request("list_participants")));
      console.log("PUBLISH_REPLY:", JSON.stringify(await user.publish(TOPIC, "The demo meeting has started.")));
      console.log("GROUP_SEND_REPLY:", JSON.stringify(await user.groupSend("Welcome to our meeting!")));
    }
    console.log("RESULT: PASS");
  } finally {
    user.close();
  }
}

if (import.meta.main) {
  await main();
}
