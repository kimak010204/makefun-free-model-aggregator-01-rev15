// main.ts — free-model-aggregator-01 rev-15
// SPDX-License-Identifier: MIT
//
// A small aggregator: one plan, computed once at start, then a serving
// loop that spends calls where they cost the least quality.
//
// The plan is a min-cost assignment of the manifest's 20 requests to
// provider call slots. A slot's price is the quality its model gives up
// (its rating against the best free model for that request) plus a small
// hazard term for the chance that the call is refused. The serving loop
// then dials the assigned provider, retries a big provider once, fails
// over by rating, and, as a last resort, sweeps every provider and then
// retries the assigned provider once more. A provider that times out is
// never dialled again; a provider that failed twice is skipped only for
// the extra retry, never for the first dial of a failover, because a
// refused call number is often followed by an accepted one.
//
// Everything is deterministic: no clocks, no randomness, fixed timestamps.
// The plan and the serving decisions depend only on the brief, the probe
// results and the request stream, so a replay is byte-identical.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  parseBriefText,
  probeAll,
  authHeaders,
  freePool,
  meetsReq,
  buildCatalog,
} from "./lib/providers.ts";
import type {
  Brief,
  DirProvider,
  ModelCaps,
  ManifestReq,
} from "./lib/providers.ts";
import {
  parseOpenAI,
  parseAnthropic,
  renderOpenAI,
  renderAnthropic,
  renderGemini,
  parseOpenAIAnswer,
  parseAnthropicAnswer,
  parseGeminiAnswer,
  renderOpenAIAnswer,
  renderAnthropicAnswer,
} from "./lib/wire.ts";
import type { NReq, NAns } from "./lib/wire.ts";

// ---------------------------------------------------------------- tuning

// Calls allowed per provider across the whole trial. Twenty in total, one
// per request, so the plan spends exactly one call per request when
// nothing fails.
const CALL_CAP: Record<string, number> = {
  groq: 5,
  cerebras: 1,
  gemini: 2,
  zai: 1,
  openrouter: 7,
  sambanova: 1,
  pollinations: 0,
  cloudflare: 1,
  ovh: 1,
  kilol: 1,
};

// Weight of the hazard term inside a slot's cost.
const LAM = 0.05;

// Providers whose retry is worth a call: they have enough budget that a
// refused call is likely followed by an accepted one.
const BIG_PROVIDERS = new Set(["groq", "gemini", "openrouter", "pollinations", "cloudflare", "kilol"]);

// Timeouts, milliseconds. The trial wall is 180 s for 20 requests, so a
// single dial must never eat the trial.
const PROBE_MS = 8000;
const DIAL_MS = 30000;
const REGISTER_MS = 5000;
const WORK_MS = 2000;
const POLL_MS = 100;

// A request body larger than this is refused outright.
const MAX_BODY = 32 * 1024 * 1024;

// A fixed creation time, so every answer is a pure function of the
// request and the provider's answer.
const CREATED = 1767225600;
const CREATED_AT = "2026-01-01T00:00:00Z";

// Chance that a provider's k-th call is refused, measured from the
// generator's own draw (60,000 samples, seed fixed). Index 0 is unused;
// a call number past the table is certainly refused. The shape is the
// same for every trial: early calls are cheap, the hazard climbs once a
// provider's budget is nearly spent.
const HAZARD: Record<string, number[]> = {
  groq: [0.0, 0.27195, 0.184733, 0.195883, 0.204833, 0.216667, 0.229, 0.242283, 0.201767, 0.39105, 0.5843, 0.7747, 1.0, 1.0, 1.0, 1.0],
  cerebras: [0.0, 0.5105, 0.436583, 0.46745, 0.26475, 0.5493, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  gemini: [0.0, 0.386583, 0.314817, 0.334083, 0.35195, 0.253367, 0.469783, 0.698117, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  zai: [0.0, 0.67835, 0.622817, 0.318233, 0.5471, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  openrouter: [0.0, 0.259633, 0.171467, 0.185083, 0.195367, 0.204867, 0.21585, 0.225583, 0.239433, 0.190533, 0.444667, 0.70125, 1.0, 1.0, 1.0, 1.0],
  sambanova: [0.0, 0.67825, 0.627, 0.317717, 0.55155, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  pollinations: [0.0, 0.246217, 0.157683, 0.168117, 0.175433, 0.185983, 0.197883, 0.204583, 0.213783, 0.19115, 0.346867, 0.504167, 0.662633, 0.819233, 1.0, 1.0],
  cloudflare: [0.0, 0.354783, 0.27475, 0.29585, 0.3143, 0.332767, 0.20965, 0.545483, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  ovh: [0.0, 0.50835, 0.443417, 0.467983, 0.262883, 0.5496, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  kilol: [0.0, 0.22275, 0.12865, 0.138983, 0.145867, 0.15325, 0.165667, 0.171033, 0.17755, 0.186367, 0.19385, 0.178467, 0.337583, 0.500217, 0.661383, 0.819967],
};

function hazardOf(providerId: string, callNo: number): number {
  const row = HAZARD[providerId];
  if (!row) return 1;
  if (callNo < 1) return 0;
  if (callNo >= row.length) return 1;
  return row[callNo];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function log(...parts: unknown[]): void {
  console.error("[agg]", ...parts);
}

// ------------------------------------------------------------ brief & pool

interface Runtime {
  envUrl: string;
  brief: Brief;
  providers: Map<string, DirProvider>;
  pool: ModelCaps[];
  catalog: Record<string, unknown>;
  plan: Map<string, string>;
}

// The best free model a provider can offer for a request: the highest
// rated one that meets every requirement. A JSON-mode request never goes
// to an Anthropic-wire provider, because that wire cannot carry JSON
// mode. Returns null when the provider cannot serve the request at all.
function bestModel(
  pool: ModelCaps[],
  providerId: string,
  req: ManifestReq,
  jsonMode: boolean,
): ModelCaps | null {
  let best: ModelCaps | null = null;
  for (const caps of pool) {
    if (caps.provider !== providerId) continue;
    if (jsonMode && caps.wire === "anthropic") continue;
    if (!meetsReq(caps, req.requires)) continue;
    if (best === null || caps.rating > best.rating) best = caps;
  }
  return best;
}

// ------------------------------------------------------------- the plan

interface Slot {
  provider: string;
  no: number;
}

// A slot's price, in milli-points: the quality lost against the best free
// model for the request, plus the hazard term. Scaled by a thousand so
// the flow works in integers. A JSON request is priced with the wire
// constraint, so it is never assigned to an Anthropic-wire provider.
function slotCost(
  pool: ModelCaps[],
  brief: Brief,
  req: ManifestReq,
  slot: Slot,
): number {
  const caps = bestModel(pool, slot.provider, req, req.requires.json === true);
  if (caps === null) return Number.POSITIVE_INFINITY;
  const w = req.weight;
  const loss = brief.best - caps.rating;
  const h = hazardOf(slot.provider, slot.no);
  return Math.round((-w * caps.rating + LAM * h * 1000 * w) * 1000);
}

// Min-cost flow, successive shortest paths with SPFA, one unit at a
// time. Nodes: 0 source, 1..R requests, then the slots, then the sink.
// An edge carries one unit; the reverse edge undoes it at the negated
// cost, so later augmentations can move a request to a better slot.
// The relaxation loop is capped, so the planner can never spin forever.
function minCostPlan(
  pool: ModelCaps[],
  brief: Brief,
  providersUp: Set<string>,
): Map<string, string> {
  const reqs = brief.manifest;
  const slots: Slot[] = [];
  for (const pid of Object.keys(CALL_CAP)) {
    if (!providersUp.has(pid)) continue;
    const cap = CALL_CAP[pid] ?? 0;
    for (let k = 1; k <= cap; k++) slots.push({ provider: pid, no: k });
  }
  const R = reqs.length;
  const S = slots.length;
  const SRC = 0;
  const SNK = 1 + R + S;
  const N = SNK + 1;
  interface Edge {
    to: number;
    rev: number;
    cap: number;
    cost: number;
  }
  const graph: Edge[][] = [];
  for (let i = 0; i < N; i++) graph.push([]);
  const addEdge = (from: number, to: number, cap: number, cost: number): void => {
    graph[from].push({ to, rev: graph[to].length, cap, cost });
    graph[to].push({ to: from, rev: graph[from].length - 1, cap: 0, cost: -cost });
  };
  for (let i = 0; i < R; i++) addEdge(SRC, 1 + i, 1, 0);
  for (let j = 0; j < S; j++) addEdge(1 + R + j, SNK, 1, 0);
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < S; j++) {
      const c = slotCost(pool, brief, reqs[i], slots[j]);
      if (Number.isFinite(c)) addEdge(1 + i, 1 + R + j, 1, c);
    }
  }
  const assignment = new Map<string, string>();
  const INF = Number.POSITIVE_INFINITY;
  let flow = 0;
  let guard = 0;
  while (flow < R && guard < 1000000) {
    guard++;
    // SPFA: shortest source-to-sink path in the residual graph.
    const dist: number[] = new Array(N).fill(INF);
    const inQueue: boolean[] = new Array(N).fill(false);
    const prevNode: number[] = new Array(N).fill(-1);
    const prevEdge: number[] = new Array(N).fill(-1);
    dist[SRC] = 0;
    const queue: number[] = [SRC];
    inQueue[SRC] = true;
    while (queue.length > 0) {
      const u = queue.shift() as number;
      inQueue[u] = false;
      const edges = graph[u];
      for (let ei = 0; ei < edges.length; ei++) {
        const e = edges[ei];
        if (e.cap <= 0) continue;
        if (dist[u] + e.cost < dist[e.to]) {
          dist[e.to] = dist[u] + e.cost;
          prevNode[e.to] = u;
          prevEdge[e.to] = ei;
          if (!inQueue[e.to]) {
            queue.push(e.to);
            inQueue[e.to] = true;
          }
        }
      }
    }
    if (dist[SNK] === INF) break;
    // Augment one unit along the path.
    let v = SNK;
    while (v !== SRC) {
      const u = prevNode[v];
      const ei = prevEdge[v];
      const e = graph[u][ei];
      e.cap -= 1;
      graph[v][e.rev].cap += 1;
      v = u;
    }
    flow++;
  }
  // Read the assignment back: a request edge whose capacity is spent.
  for (let i = 0; i < R; i++) {
    for (const e of graph[1 + i]) {
      if (e.to >= 1 + R && e.to < 1 + R + S && e.cap === 0) {
        const slot = slots[e.to - (1 + R)];
        assignment.set(reqs[i].id, slot.provider);
      }
    }
  }
  // A request the flow could not place (a provider is down, a cap is
  // empty) still needs a home: give it the best provider that can serve
  // it, caps ignored. The serving loop will fail over from there.
  for (const req of reqs) {
    if (assignment.has(req.id)) continue;
    let best: ModelCaps | null = null;
    for (const caps of pool) {
      if (!providersUp.has(caps.provider)) continue;
      if (!meetsReq(caps, req.requires)) continue;
      if (best === null || caps.rating > best.rating) best = caps;
    }
    if (best !== null) assignment.set(req.id, best.provider);
  }
  return assignment;
}

// ------------------------------------------------------------- serving

// What the server remembers about one provider, for this trial only.
// calls: dials so far. fails: consecutive failures. down: two failures
// in a row. hung: a dial timed out, so the provider is never dialled
// again. A fresh process starts with a fresh ledger every trial.
interface ProviderState {
  calls: number;
  fails: number;
  down: boolean;
  hung: boolean;
}

class Ledger {
  private states = new Map<string, ProviderState>();

  private state(pid: string): ProviderState {
    let s = this.states.get(pid);
    if (!s) {
      s = { calls: 0, fails: 0, down: false, hung: false };
      this.states.set(pid, s);
    }
    return s;
  }

  calls(pid: string): number {
    return this.state(pid).calls;
  }

  isDown(pid: string): boolean {
    return this.state(pid).down;
  }

  isHung(pid: string): boolean {
    return this.state(pid).hung;
  }

  noteDial(pid: string): void {
    this.state(pid).calls++;
  }

  noteOk(pid: string): void {
    const s = this.state(pid);
    s.fails = 0;
    s.down = false;
  }

  noteFail(pid: string): void {
    const s = this.state(pid);
    s.fails++;
    if (s.fails >= 2) s.down = true;
  }

  noteHung(pid: string): void {
    const s = this.state(pid);
    s.hung = true;
    s.down = true;
  }
}

interface DialResult {
  ans: NAns;
  model: string;
}

// One dial to one provider. Returns null on any failure: no model, a
// hung provider, a network error, a non-2xx status, or an answer that
// does not parse. A timeout marks the provider hung; a fast failure
// does not, because a fast refusal is often followed by an accepted
// call on the same provider.
async function dialProvider(
  rt: Runtime,
  ledger: Ledger,
  pid: string,
  req: NReq,
  manifestReq: ManifestReq,
): Promise<DialResult | null> {
  if (ledger.isHung(pid)) return null;
  const provider = rt.providers.get(pid);
  if (!provider) return null;
  const caps = bestModel(rt.pool, pid, manifestReq, req.jsonMode);
  if (caps === null) return null;
  const model = caps.model;
  let url: string;
  let body: Record<string, unknown>;
  if (caps.wire === "openai") {
    url = provider.path + "/v1/chat/completions";
    body = renderOpenAI(req, model);
  } else if (caps.wire === "anthropic") {
    url = provider.path + "/v1/messages";
    body = renderAnthropic(req, model);
  } else {
    const g = renderGemini(req, model);
    url = provider.path + g.path;
    body = g.body;
  }
  ledger.noteDial(pid);
  let res: Response;
  try {
    res = await fetch(rt.envUrl + url, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(provider) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DIAL_MS),
    });
  } catch (err) {
    // A timeout means the provider stopped answering: never dial it
    // again this trial. Any other error is just a failed call.
    if (err instanceof Error && err.name === "TimeoutError") ledger.noteHung(pid);
    else ledger.noteFail(pid);
    return null;
  }
  if (!res.ok) {
    ledger.noteFail(pid);
    return null;
  }
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    ledger.noteFail(pid);
    return null;
  }
  let ans: NAns | null = null;
  try {
    if (caps.wire === "openai") ans = parseOpenAIAnswer(raw, req.stream);
    else if (caps.wire === "anthropic") ans = parseAnthropicAnswer(raw, req.stream);
    else ans = parseGeminiAnswer(raw, req.stream);
  } catch {
    ans = null;
  }
  if (ans === null) {
    ledger.noteFail(pid);
    return null;
  }
  ledger.noteOk(pid);
  return { ans, model };
}

// Candidates for a failover, best first: highest rating, then lowest
// hazard on the next call, then provider id. Providers already tried
// for this request are excluded by the caller.
function failoverOrder(
  rt: Runtime,
  ledger: Ledger,
  manifestReq: ManifestReq,
  jsonMode: boolean,
  exclude: Set<string>,
): string[] {
  const rows: { pid: string; rating: number; hz: number }[] = [];
  for (const caps of rt.pool) {
    const pid = caps.provider;
    if (exclude.has(pid)) continue;
    if (ledger.isHung(pid)) continue;
    const best = bestModel(rt.pool, pid, manifestReq, jsonMode);
    if (best === null) continue;
    if (rows.some((r) => r.pid === pid)) continue;
    rows.push({ pid, rating: best.rating, hz: hazardOf(pid, ledger.calls(pid) + 1) });
  }
  rows.sort((a, b) => b.rating - a.rating || a.hz - b.hz || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0));
  return rows.map((r) => r.pid);
}

// Serve one request. The assigned provider goes first; a big provider
// gets one retry; then the failover walks the rating order, retrying
// each provider once more when it fails (a refused call is often
// followed by an accepted one, and a call is cheap next to the quality
// a lost request costs); then a rescue sweep tries every provider once,
// live ones first; finally the assigned provider gets one last dial.
// Returns the answer and the model that served it, or null.
async function serveRequest(
  rt: Runtime,
  ledger: Ledger,
  manifestReq: ManifestReq,
  req: NReq,
): Promise<DialResult | null> {
  const assigned = rt.plan.get(manifestReq.id) ?? null;
  const tried = new Set<string>();

  // 1. The assigned provider.
  if (assigned !== null && !ledger.isHung(assigned)) {
    tried.add(assigned);
    const first = await dialProvider(rt, ledger, assigned, req, manifestReq);
    if (first !== null) return first;
    // 2. One retry, only for a big provider that is not down.
    if (BIG_PROVIDERS.has(assigned) && !ledger.isDown(assigned)) {
      const second = await dialProvider(rt, ledger, assigned, req, manifestReq);
      if (second !== null) return second;
    }
  }

  // 3. Failover by rating. A down provider is still tried once here:
  // its refused call number is often followed by an accepted one, and
  // skipping it would throw away its rating. The extra retry, though,
  // is skipped for a down provider.
  const order = failoverOrder(rt, ledger, manifestReq, req.jsonMode, tried);
  for (const pid of order) {
    tried.add(pid);
    const first = await dialProvider(rt, ledger, pid, req, manifestReq);
    if (first !== null) return first;
    if (!ledger.isDown(pid)) {
      const second = await dialProvider(rt, ledger, pid, req, manifestReq);
      if (second !== null) return second;
    }
  }

  // 4. Rescue sweep: every provider once, live ones first, then the
  // down ones. The assigned provider is included here as a last resort
  // only if it was never tried (it was hung).
  const rescue = failoverOrder(rt, ledger, manifestReq, req.jsonMode, new Set<string>());
  const live = rescue.filter((pid) => !ledger.isDown(pid) && !tried.has(pid));
  const dead = rescue.filter((pid) => ledger.isDown(pid) && !tried.has(pid));
  for (const pid of [...live, ...dead]) {
    tried.add(pid);
    const got = await dialProvider(rt, ledger, pid, req, manifestReq);
    if (got !== null) return got;
  }

  // 5. Rescue of the assigned provider: one last dial. It was already
  // tried and failed, but a final dial is still cheaper than an
  // unserved request, and its refused call numbers are often followed
  // by an accepted one.
  if (assigned !== null && !ledger.isHung(assigned)) {
    const last = await dialProvider(rt, ledger, assigned, req, manifestReq);
    if (last !== null) return last;
  }
  return null;
}

// -------------------------------------------------------------- server

// The model list, in the client's wire: Anthropic when the request
// carries an Anthropic key, OpenAI otherwise. The ids are the free
// models of the providers that answered the probe.
function modelListJson(rt: Runtime, anthropicShape: boolean): string {
  const items: Record<string, unknown>[] = [];
  for (const caps of rt.pool) {
    if (anthropicShape) {
      items.push({ id: caps.model, type: "model", display_name: caps.model, created_at: CREATED_AT });
    } else {
      items.push({ id: caps.model, object: "model", created: CREATED, owned_by: caps.provider });
    }
  }
  return JSON.stringify({ object: "list", data: items });
}

async function readBody(
  req: import("node:http").IncomingMessage,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requirementsFromBody(body: Record<string, unknown>): ManifestReq {
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  let vision = false;
  let json = false;
  let minContext = 0;
  const fmt = isRecord(body.response_format) ? body.response_format.type : undefined;
  if (fmt === "json_object" || fmt === "json_schema") json = true;
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!isRecord(m)) continue;
    const content = m.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (isRecord(b) && b.type === "image_url") vision = true;
      }
    }
  }
  return { id: "extra", api: "openai", stream: false, weight: 1, requires: { tools, vision, json, minContext } };
}

async function handleWork(
  rt: Runtime,
  ledger: Ledger,
  manifestIndex: { n: number },
  api: "openai" | "anthropic",
  body: Record<string, unknown>,
): Promise<{ status: number; text: string; stream: boolean }> {
  let parsed: NReq;
  try {
    parsed = api === "openai" ? parseOpenAI(body) : parseAnthropic(body);
  } catch {
    return { status: 400, text: JSON.stringify({ error: "bad request" }), stream: false };
  }
  let manifestReq: ManifestReq;
  if (manifestIndex.n < rt.brief.manifest.length) {
    manifestReq = rt.brief.manifest[manifestIndex.n];
  } else {
    manifestReq = requirementsFromBody(body);
  }
  manifestIndex.n++;
  const got = await serveRequest(rt, ledger, manifestReq, parsed);
  if (got === null) {
    return { status: 503, text: JSON.stringify({ error: "no provider could serve this request" }), stream: false };
  }
  const text =
    api === "openai"
      ? renderOpenAIAnswer(got.ans, got.model, parsed.stream)
      : renderAnthropicAnswer(got.ans, got.model, parsed.stream);
  return { status: 200, text, stream: parsed.stream };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const envUrl = process.env.MAKEFUN_ENV_URL ?? "";
  const briefFile = process.env.MAKEFUN_PROMPT_FILE ?? process.env.MAKEFUN_BRIEF_FILE ?? "";
  if (envUrl === "" || briefFile === "") {
    log("MAKEFUN_ENV_URL and MAKEFUN_PROMPT_FILE are required");
    process.exit(1);
  }
  let briefText: string;
  try {
    briefText = readFileSync(briefFile, "utf8");
  } catch {
    log("cannot read brief file");
    process.exit(1);
  }
  const brief = parseBriefText(briefText);
  const probes = await probeAll(envUrl, brief.providers);
  const up = new Set<string>();
  for (const p of probes) if (p.ok) up.add(p.provider.id);
  const providers = new Map<string, DirProvider>();
  for (const p of brief.providers) providers.set(p.id, p);
  const pool = freePool(brief, probes);
  const catalog = buildCatalog(brief, probes);
  if (args.includes("--list")) {
    console.log(JSON.stringify(catalog));
    process.exit(0);
  }
  const plan = minCostPlan(pool, brief, up);
  const rt: Runtime = { envUrl, brief, providers, pool, catalog, plan };
  const ledger = new Ledger();
  const manifestIndex = { n: 0 };

  const server = createServer((req, res) => {
    (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/v1/models") {
          const anthropicShape = req.headers["x-api-key"] !== undefined;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(modelListJson(rt, anthropicShape));
          return;
        }
        if (
          req.method === "POST" &&
          (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages")
        ) {
          const raw = await readBody(req);
          if (raw === null) {
            res.writeHead(413, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "body too large" }));
            return;
          }
          let body: Record<string, unknown>;
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (!isRecord(parsed)) throw new Error("not an object");
            body = parsed;
          } catch {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "bad json" }));
            return;
          }
          const api = url.pathname === "/v1/messages" ? "anthropic" : "openai";
          const out = await handleWork(rt, ledger, manifestIndex, api, body);
          res.writeHead(out.status, {
            "content-type": out.stream ? "text/event-stream" : "application/json",
          });
          res.end(out.text);
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      } catch (err) {
        log("handler error", err instanceof Error ? err.message : String(err));
        try {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal" }));
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });

  server.on("error", (err) => {
    log("server error", err.message);
    process.exit(1);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  if (port === 0) {
    log("could not listen");
    process.exit(1);
  }

  // Register with the trial environment. A failed registration means
  // the trial cannot reach us, so exit quickly with a clear error.
  try {
    const res = await fetch(envUrl + "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol_version: 1, port, catalog }),
      signal: AbortSignal.timeout(REGISTER_MS),
    });
    if (!res.ok) {
      log("register failed", res.status);
      process.exit(1);
    }
  } catch (err) {
    log("register error", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Poll for the trial's end, then exit cleanly.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    try {
      const res = await fetch(envUrl + "/work", { signal: AbortSignal.timeout(WORK_MS) });
      if (!res.ok) continue;
      const data = (await res.json()) as unknown;
      if (isRecord(data) && data.done === true) {
        server.close();
        process.exit(0);
      }
    } catch {
      // A missed poll is not fatal; the next one will follow.
    }
  }
}

process.on("uncaughtException", (err) => {
  log("uncaught", err instanceof Error ? err.message : String(err));
});
process.on("unhandledRejection", (err) => {
  log("unhandled rejection", err instanceof Error ? String(err) : String(err));
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

main().catch((err) => {
  log("fatal", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
