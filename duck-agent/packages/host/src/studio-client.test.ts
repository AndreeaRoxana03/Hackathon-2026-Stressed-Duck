import assert from "node:assert/strict";
import test from "node:test";
import { StaticTokenProvider } from "./auth.js";
import { StudioClient, type StudioRunRequest } from "./studio-client.js";

function response(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, { status, headers });
}

test("looks up an agent and normalizes configured models", async () => {
  let requestedUrl = "";
  let requestedHeaders: Headers | undefined;
  const client = new StudioClient({
    baseUrl: "https://agents.example.test",
    agentId: "agent one",
    configId: "config/latest",
    tokenProvider: new StaticTokenProvider("token-123"),
    fetchImplementation: async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      return response(
        JSON.stringify({
          id: "agent one",
          name: "Review Duck",
          models: [{ name: "model-a", maxOutputTokens: 4096 }],
        }),
      );
    },
  });

  const metadata = await client.getAgent();

  assert.equal(
    requestedUrl,
    "https://agents.example.test/v2/agents/agent%20one/configs/config%2Flatest?fields=models",
  );
  assert.equal(requestedHeaders?.get("authorization"), "Bearer token-123");
  assert.deepEqual(metadata, {
    id: "agent one",
    name: "Review Duck",
    models: [{ id: "model-a", maxOutputTokens: 4096 }],
  });
});

test("posts a run and consumes data and raw JSON SSE events", async () => {
  const request: StudioRunRequest = {
    messages: [{ role: "user", content: "Inspect this mock context." }],
    tools: [],
  };
  let sentBody = "";
  let sentSignal: AbortSignal | undefined;
  const events: string[] = [];
  const client = new StudioClient({
    baseUrl: "https://agents.example.test/",
    agentId: "agent-1",
    configId: "latest",
    tokenProvider: new StaticTokenProvider("token-456"),
    fetchImplementation: async (input, init) => {
      assert.equal(String(input), "https://agents.example.test/v2/agents/agent-1/runs?configId=latest");
      sentBody = String(init?.body);
      sentSignal = init?.signal ?? undefined;
      return response(
        'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Done."}\n\n{"type":"RUN_FINISHED"}\n\ndata: [DONE]\n\n',
        200,
        { "content-type": "text/event-stream" },
      );
    },
  });

  await client.run(request, (event) => events.push(event.type));

  assert.deepEqual(JSON.parse(sentBody), request);
  assert.equal(sentSignal, undefined);
  assert.deepEqual(events, ["TEXT_MESSAGE_CONTENT", "RUN_FINISHED"]);
});

test("passes cancellation to Studio fetch and reports HTTP details", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const client = new StudioClient({
    baseUrl: "https://agents.example.test",
    agentId: "agent-1",
    configId: "latest",
    tokenProvider: new StaticTokenProvider("token-789"),
    fetchImplementation: async (_input, init) => {
      receivedSignal = init?.signal ?? undefined;
      return response(JSON.stringify({ detail: "No access" }), 403, { "x-request-id": "req-1" });
    },
  });

  await assert.rejects(
    client.getAgent(controller.signal),
    /Studio agent lookup failed with HTTP 403: No access \(request req-1\)/,
  );
  assert.equal(receivedSignal, controller.signal);
});