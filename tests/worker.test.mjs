import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const env = { ACCESS_TOKEN: "test-secret-not-for-production", TAVILY_API_KEY: "tvly-test" };
const url = "https://buscador-casa.example.workers.dev/preguntar";

const request = (body, token = env.ACCESS_TOKEN) => new Request(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

test("health responde sin exponer configuración", async () => {
  const res = await worker.fetch(new Request("https://example.workers.dev/health"), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { estado: "ok" });
});

test("rechaza token incorrecto antes de buscar", async () => {
  const res = await worker.fetch(request({ pregunta: "Nebulosas" }, "incorrecto"), env);
  assert.equal(res.status, 401);
});

test("valida pregunta y tipo", async () => {
  assert.equal((await worker.fetch(request({ pregunta: "" }), env)).status, 400);
  assert.equal((await worker.fetch(request({ pregunta: "hola", tipo: "finanzas" }), env)).status, 400);
});

test("normaliza respuesta, fuentes y contexto para IA sin filtrar API key", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let requested;
    globalThis.fetch = async (address, options) => {
      requested = { address, options };
      return new Response(JSON.stringify({
        answer: "Una nebulosa es una nube de gas y polvo.",
        results: [
          { title: "NASA", url: "https://science.nasa.gov/", content: "Nebulosas: gas y polvo." },
          { title: "Falso", url: "javascript:alert(1)", content: "No debe usarse" },
        ],
        usage: { credits: 1 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const res = await worker.fetch(request({ pregunta: "Qué es una nebulosa" }), env);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.estado, "ok");
    assert.equal(data.respuesta, "Una nebulosa es una nube de gas y polvo.");
    assert.equal(data.fuentes.length, 1);
    assert.match(data.contexto_para_ia, /Nebulosas: gas y polvo/);
    assert.ok(!JSON.stringify(data).includes(env.TAVILY_API_KEY));
    assert.equal(requested.address, "https://api.tavily.com/search");
    const sent = JSON.parse(requested.options.body);
    assert.equal(sent.search_depth, "basic");
    assert.equal(sent.include_answer, "basic");
    assert.equal(sent.topic, "general");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("señala resultado sin respuesta preliminar", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ results: [
      { title: "Fuente", url: "https://example.com", content: "Contenido para el modelo" }
    ] });
    const data = await (await worker.fetch(request({ pregunta: "Algo nuevo" }), env)).json();
    assert.equal(data.estado, "sin_respuesta_directa");
    assert.equal(data.respuesta, null);
    assert.equal(data.fuentes.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cuota agotada propaga HTTP 429", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("{}", { status: 432 });
    const res = await worker.fetch(request({ pregunta: "Nebulosas" }), env);
    assert.equal(res.status, 429);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
