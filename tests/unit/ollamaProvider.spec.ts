import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { runAuditedReviewLoop } from "../../src/orchestration/runAuditedReviewLoop";
import { createOllamaAdapter } from "../../src/providers/ollamaAdapter";
import { createOllamaSiteBridge } from "../../src/providers/ollamaSiteBridge";

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void | Promise<void>;

async function mockHttp(handler: Handler): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void Promise.resolve(handler(request, response, Buffer.concat(chunks).toString("utf8")))
        .catch(() => { response.writeHead(500); response.end(); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server has no TCP port");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function chatResponse(content: string, model = "test-model:latest"): unknown {
  return { model, done: true, message: { role: "assistant", content } };
}

test("local Ollama adapter preserves exact response and explicit provider provenance", async () => {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const server = await mockHttp((request, response, body) => {
    requests.push({ path: request.url ?? "", method: request.method ?? "", body: body ? JSON.parse(body) : undefined });
    if (request.url === "/api/tags") json(response, { models: [{ name: "test-model:latest" }] });
    else if (request.url === "/api/chat") json(response, chatResponse("  exact answer\n"));
    else { response.writeHead(404); response.end(); }
  });
  try {
    const provider = createOllamaAdapter({ endpoint: server.endpoint, modelName: "test-model" });
    const session = provider.createSession();
    expect(provider.provenance).toEqual({
      providerName: "ollama", modelName: "test-model", executionMode: "local_http",
    });
    expect(await provider.checkReady(session)).toBe("ready");
    const baseline = await provider.captureTurnBaseline(session);
    expect(baseline).toEqual({ count: 0, ids: new Set() });
    await provider.sendPrompt(session, "Review this answer");
    expect(await provider.waitForGenerationStart(session, baseline)).toBe("started");
    expect(await provider.waitForGenerationComplete(session, baseline, 1_000)).toEqual({ outcome: "complete" });
    expect(await provider.getLatestAssistantResponse(session, baseline)).toBe("  exact answer\n");
    expect((await provider.captureTurnBaseline(session)).count).toBe(1);
    expect(requests).toEqual([
      { path: "/api/tags", method: "GET", body: undefined },
      { path: "/api/chat", method: "POST", body: {
        model: "test-model", messages: [{ role: "user", content: "Review this answer" }], stream: false,
      } },
    ]);
  } finally {
    await server.close();
  }
});

test("adapter rejects non-local endpoints and missing models", async () => {
  for (const endpoint of ["https://127.0.0.1:11434", "http://example.com:11434", "http://127.0.0.1:11434/path", "http://user:pass@127.0.0.1:11434"]) {
    expect(() => createOllamaAdapter({ endpoint, modelName: "test-model" })).toThrow(/local HTTP origin/);
  }
  const server = await mockHttp((_request, response) => json(response, { models: [] }));
  try {
    const provider = createOllamaAdapter({ endpoint: server.endpoint, modelName: "test-model" });
    await expect(provider.checkReady(provider.createSession())).rejects.toMatchObject({ code: "model_unavailable" });
  } finally {
    await server.close();
  }
});

test("unavailable and malformed local HTTP responses fail explicitly", async () => {
  const server = await mockHttp((request, response) => {
    if (request.url === "/api/tags") json(response, { models: [{ name: "test-model:latest" }] });
    else json(response, { done: true, message: { role: "assistant", content: "no model field" } });
  });
  try {
    const provider = createOllamaAdapter({ endpoint: server.endpoint, modelName: "test-model" });
    const session = provider.createSession();
    const baseline = await provider.captureTurnBaseline(session);
    await provider.sendPrompt(session, "prompt");
    await expect(provider.waitForGenerationComplete(session, baseline, 1_000)).rejects.toMatchObject({ code: "malformed_response" });
    await expect(provider.getLatestAssistantResponse(session, baseline)).rejects.toMatchObject({ code: "operation_state" });
  } finally {
    await server.close();
  }

  const unavailable = await mockHttp((_request, response) => json(response, { models: [] }));
  const endpoint = unavailable.endpoint;
  await unavailable.close();
  const provider = createOllamaAdapter({ endpoint, modelName: "test-model" });
  await expect(provider.checkReady(provider.createSession())).rejects.toMatchObject({ code: "unavailable" });
});

test("generation timeout aborts the HTTP request and never exposes partial text", async () => {
  const server = await mockHttp((request, response) => {
    if (request.url === "/api/tags") json(response, { models: [{ name: "test-model" }] });
    // Intentionally leave /api/chat pending until the client aborts.
  });
  try {
    const provider = createOllamaAdapter({ endpoint: server.endpoint, modelName: "test-model" });
    const session = provider.createSession();
    const baseline = await provider.captureTurnBaseline(session);
    await provider.sendPrompt(session, "slow request");
    expect(await provider.waitForGenerationStart(session, baseline)).toBe("started");
    await expect(provider.waitForGenerationComplete(session, baseline, 10)).resolves.toMatchObject({
      outcome: "timeout", partialText: "",
    });
    await expect(provider.getLatestAssistantResponse(session, baseline)).rejects.toMatchObject({ code: "operation_state" });
  } finally {
    await server.close();
  }
});

test("temporary bridge ignores Page and runs the unchanged audited loop with local HTTP", async () => {
  const server = await mockHttp((request, response, body) => {
    if (request.url === "/api/tags") { json(response, { models: [{ name: "test-model:latest" }] }); return; }
    const prompt = (JSON.parse(body) as { messages: { content: string }[] }).messages[0].content;
    const content = prompt.includes("BEGIN_STRUCTURED_REVIEW")
      ? `BEGIN_STRUCTURED_REVIEW\n${JSON.stringify({
        reviewStatus: "CANDIDATE_CONVERGED", resolvedClaimIds: [], resolutionEvidence: {},
        stillOpenClaims: [], reopenedClaims: [], newClaims: [],
      })}\nEND_STRUCTURED_REVIEW`
      : "A complete draft answer";
    json(response, chatResponse(content));
  });
  try {
    const provider = createOllamaAdapter({ endpoint: server.endpoint, modelName: "test-model" });
    const generator = createOllamaSiteBridge(provider, "generator", 1_000);
    const reviewer = createOllamaSiteBridge(provider, "reviewer", 1_000);
    expect(generator.adapter.name).toBe("ollama-generator");
    expect(reviewer.adapter.name).toBe("ollama-reviewer");
    expect(generator.providerProvenance).toEqual(provider.provenance);
    expect(reviewer.providerProvenance).toEqual(provider.provenance);
    const forbiddenPage = new Proxy({}, { get() { throw new Error("Page was dereferenced"); } }) as Page;
    expect(await generator.adapter.checkReady(forbiddenPage)).toBe("ready");
    const result = await runAuditedReviewLoop({
      originalTask: "Give a short answer",
      chatgpt: generator,
      claude: reviewer,
      humanGate: { async presentAndAwaitDecision() { return {
        requestedOutcome: "ACCEPT", decidedAt: "2026-09-24T00:00:00.000Z",
      }; } },
      options: { hardMaxRounds: 2, recommendedMaxRounds: 2 },
    });
    expect(result.initial.response).toBe("A complete draft answer");
    expect(result.rounds).toHaveLength(1);
    expect(result.outcome).toBe("ACCEPTED");
    expect(JSON.parse(JSON.stringify({
      result,
      providerProvenance: [generator.providerProvenance, reviewer.providerProvenance],
    })).providerProvenance).toEqual([provider.provenance, provider.provenance]);
  } finally {
    await server.close();
  }
});
