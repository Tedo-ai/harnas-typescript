import { Log, appendUserMessage } from "../src/index.js";

const log = new Log();
appendUserMessage(log, "hello");

console.log(JSON.stringify(log.serializableEvents(), null, 2));
