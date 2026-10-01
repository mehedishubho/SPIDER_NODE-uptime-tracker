#!/usr/bin/env node
// ai-stub-server.mjs — the OpenAI-compatible stub provider for the AI-surface
// e2e legs (08-07, research A3 / OQ4 resolution: stub the provider at the
// network layer, never the route layer, so the REAL lib/ai selection, the
// 08-10 guard chain, and the real SDK client hooks are all exercised).
//
// Started ONLY by playwright.ai.config.ts as a webServer entry — the default
// verify e2e project never needs it (the AI specs skip at describe level
// without the stub env, Task 3's degrade-safely posture). No AI SDK import:
// a plain node:http server speaking the chat.completions SSE wire format.
//
// Behavior discrimination is by the SYSTEM message (the route instructions):
//   - "post-mortem" in the system message -> streams the D-14 four-section
//     markdown draft (Summary, Timeline, Impact, Possible causes — the e2e
//     pins the sections AT THE UI LAYER against exactly this stream).
//   - otherwise (the monitor assistant) -> streams the form-field JSON object
//     in partial-fill chunks. A description containing the marker token
//     "unreliable" streams the schema-INVALID variant (interval 7) so the e2e
//     can pin the D-19 partial fill + manual-entry hint end-to-end.
//
// Streaming is deliberately slow (chunk delay) so the e2e can press Stop
// mid-stream and still land inside the stream window.

import { createServer } from "node:http";

const PORT = Number(process.env.AI_STUB_PORT ?? 4599);

const POST_MORTEM_MARKDOWN = [
  "## Summary\n\nThe monitored endpoint went DOWN for approximately one hour before recovering.",
  "\n\n## Timeline\n\n- DOWN first detected at 10:00 UTC\n- Incident lasted about one hour\n- Recovery confirmed at 11:02 UTC",
  "\n\n## Impact\n\nChecks failed with HTTP 503 responses; visitors saw errors during the window.",
  "\n\n## Possible causes\n\n- Upstream service failure\n- Deployment regression\n- Network interruption",
];

const ASSISTANT_VALID_JSON = '{"name":"My Portfolio Site","url":"https://example.com/portfolio","interval":5}';
const ASSISTANT_INVALID_JSON = '{"name":"Partial Config Site","url":"https://example.com/partial","interval":7}';

const CHUNK_DELAY_MS = 90;

function sseChunk(id, delta, finishReason) {
  return (
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "stub-model",
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    })}\n\n`
  );
}

function writeSseChunks(res, textParts) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const id = `stub-${Date.now()}`;
  let index = 0;
  const timer = setInterval(() => {
    if (res.destroyed) {
      clearInterval(timer);
      return;
    }
    if (index < textParts.length) {
      res.write(sseChunk(id, { role: "assistant", content: textParts[index] }));
      index += 1;
      return;
    }
    // Terminal chunk (OpenAI stream shape) + [DONE] sentinel.
    res.write(sseChunk(id, {}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
    clearInterval(timer);
  }, CHUNK_DELAY_MS);
  // Client Stop aborts the fetch and — via the route's abortSignal
  // composition — closes this socket; stop the timer so the process drains.
  res.on("close", () => clearInterval(timer));
}

function textChunks(text, size) {
  const parts = [];
  for (let i = 0; i < text.length; i += size) {
    parts.push(text.slice(i, i + size));
  }
  return parts;
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let systemMessage = "";
      let userMessage = "";
      try {
        const body = JSON.parse(raw);
        for (const message of body.messages ?? []) {
          const content = typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content.map((part) => part?.text ?? "").join("")
              : "";
          if (message.role === "system") systemMessage += content;
          if (message.role === "user") userMessage += content;
        }
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub: unparseable request" } }));
        return;
      }

      if (systemMessage.includes("post-mortem")) {
        writeSseChunks(res, textChunks(POST_MORTEM_MARKDOWN.join(""), 60));
        return;
      }
      // Monitor assistant: the "unreliable" marker in the description selects
      // the schema-invalid variant (interval 7 — outside the 1/5/10/30/60
      // literal union) so the e2e pins the D-19 partial-fill hint path.
      const invalid = userMessage.includes("unreliable");
      const json = invalid ? ASSISTANT_INVALID_JSON : ASSISTANT_VALID_JSON;
      writeSseChunks(res, textChunks(json, 14));
      return;
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[ai-stub] OpenAI-compatible stub listening on http://127.0.0.1:${PORT}/v1`);
});
