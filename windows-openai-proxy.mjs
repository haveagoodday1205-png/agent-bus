import http from "node:http";

const listenHost = process.env.AGENT_BUS_WINDOWS_HOST || "127.0.0.1";
const listenPort = Number(process.env.AGENT_BUS_WINDOWS_PORT || 8789);
const upstream = (process.env.AGENT_BUS_UPSTREAM || "http://127.0.0.1:8788").replace(/\/$/, "");
const token = process.env.AGENT_BUS_TOKEN || "";

const server = http.createServer(async (req, res) => {
  try {
    const target = new URL(`${upstream}${req.url || "/"}`);
    const headers = { ...req.headers };
    headers.host = target.host;
    if (token && !headers.authorization) headers.authorization = `Bearer ${token}`;
    const upstreamRes = await fetch(target, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : req,
      duplex: "half"
    });
    res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers.entries()));
    if (!upstreamRes.body) {
      res.end();
      return;
    }
    const reader = upstreamRes.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(`${JSON.stringify({ error: err.message || String(err) })}\n`);
  }
});

server.listen(listenPort, listenHost, () => {
  console.log(`windows-openai-proxy listening on http://${listenHost}:${listenPort}`);
  console.log(`forwarding to ${upstream}`);
});
