import http from "node:http";

const host = process.env.MOCK_OPENAI_HOST || "127.0.0.1";
const port = Number(process.env.MOCK_OPENAI_PORT || 8790);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${host}:${port}`);
  if (req.method === "GET" && url.pathname === "/v1/models") {
    return sendJson(res, {
      object: "list",
      data: [{ id: "agent-bus-mock", object: "model", created: 0, owned_by: "mock" }]
    });
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const body = await readJson(req);
    const content = body.messages?.map((message) => message.content).join("\n") || "";
    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store"
      });
      res.write(`data: ${JSON.stringify(chunk("agent-bus-mock", "mock: "))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk("agent-bus-mock", content || "ok"))}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    return sendJson(res, {
      id: `chatcmpl_mock_${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model || "agent-bus-mock",
      choices: [{
        index: 0,
        message: { role: "assistant", content: `mock: ${content || "ok"}` },
        finish_reason: "stop"
      }]
    });
  }
  return sendJson(res, { error: "not_found" }, 404);
});

server.listen(port, host, () => {
  console.log(`mock-openai-backend listening on http://${host}:${port}`);
});

function chunk(model, content) {
  return {
    id: `chatcmpl_mock_${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}
