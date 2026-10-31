import { createServer } from "node:http";
import { registry } from "./metrics.js";

// Workers have no HTTP API, so they expose /metrics on their own port.
export function startMetricsServer(port: number) {
  const server = createServer(async (req, res) => {
    if (req.url !== "/metrics") return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": registry.contentType }).end(await registry.metrics());
  });
  server.listen(port);
  return server;
}
