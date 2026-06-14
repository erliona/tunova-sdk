/**
 * Tunova — tiny zero-dependency TypeScript/Node client for the Suno music API
 * (https://api.tunova.ai). Requires Node 18+ (global `fetch`).
 *
 * Generation is asynchronous: `submit()` returns a job_id; `generate()` submits and polls
 * until the track is delivered. You're billed only when a song actually delivers — failed
 * renders are auto-refunded.
 *
 *   import { Tunova } from "./tunova";
 *   const t = new Tunova(process.env.TUNOVA_API_KEY!);
 *   const job = await t.generate("lofi hip hop to code to", { model: "v5" });
 *   if (job.status === "complete") console.log(job.clips[0]?.audio_url);
 *   else console.error("failed (auto-refunded):", job.error);
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_BASE = "https://api.tunova.ai";
const TERMINAL = new Set(["complete", "failed"]);

export interface Clip {
  id: string;
  status?: string;
  audio_url?: string;
  image_url?: string;
  title?: string;
  model?: string;
  tags?: string;
  duration?: number;
  [k: string]: unknown;
}
export interface Job {
  job_id: string;
  status: "queued" | "processing" | "submitted" | "complete" | "failed";
  clips: Clip[];
  error: string | null;
  created_at: number;
  updated_at: number;
}
export interface JobAccepted {
  job_id: string;
  status: string;
  status_url: string;
  idempotent_replay?: boolean;
}
export interface GenerateOptions {
  /** Lyrics mode: `prompt` is your lyrics; add `tags`/`title`. */
  custom?: boolean;
  tags?: string;
  title?: string;
  make_instrumental?: boolean;
  /** e.g. "v4.5" | "v5" | "v5.5" (default: account default). */
  model?: string;
  /** Public https URL for an HMAC-signed completion webhook. */
  callback_url?: string;
  /** A retried submit with the same key returns the same job — never double-charged. */
  idempotencyKey?: string;
}

export class TunovaError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail: string,
    public readonly requestId?: string,
  ) {
    super(`[${status}] ${code}: ${detail}`);
    this.name = "TunovaError";
  }
}

export class Tunova {
  private readonly baseUrl: string;
  constructor(private readonly apiKey: string, baseUrl: string = DEFAULT_BASE) {
    if (!apiKey) throw new Error("apiKey is required (your sk_live_… key)");
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T>(method: string, path: string, headers: Record<string, string>, body?: string): Promise<T> {
    const res = await fetch(this.baseUrl + path, { method, headers, body });
    const text = await res.text();
    let json: { code?: string; detail?: string; request_id?: string } & Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON body (e.g. an edge error) — fall through with raw text */
    }
    if (!res.ok) {
      throw new TunovaError(res.status, json.code ?? "HTTP_ERROR", json.detail ?? text.slice(0, 300), json.request_id);
    }
    return json as T;
  }

  /** Submit a generation job (returns immediately with a job_id). Tokens settle on success only. */
  async submit(prompt: string, opts: GenerateOptions = {}): Promise<JobAccepted> {
    const body: Record<string, unknown> = { prompt };
    if (opts.custom) {
      if (opts.tags != null) body.tags = opts.tags;
      if (opts.title != null) body.title = opts.title;
    }
    if (opts.make_instrumental) body.make_instrumental = true;
    if (opts.model) body.model = opts.model;
    if (opts.callback_url) body.callback_url = opts.callback_url;
    const headers: Record<string, string> = { "X-API-Key": this.apiKey, "Content-Type": "application/json" };
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    return this.request<JobAccepted>("POST", opts.custom ? "/api/custom_generate" : "/api/generate", headers, JSON.stringify(body));
  }

  /** Fetch a job's current state. Once `status === "complete"`, `clips[].audio_url` is set. */
  getJob(jobId: string): Promise<Job> {
    return this.request<Job>("GET", `/api/jobs/${jobId}`, { "X-API-Key": this.apiKey });
  }

  /** Poll until the job is terminal ("complete"/"failed") or the timeout elapses. */
  async waitFor(jobId: string, { pollIntervalMs = 3000, timeoutMs = 300_000 }: { pollIntervalMs?: number; timeoutMs?: number } = {}): Promise<Job> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.getJob(jobId);
      if (TERMINAL.has(job.status)) return job;
      if (Date.now() >= deadline) throw new TunovaError(0, "TIMEOUT", `job ${jobId} not terminal after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  /** submit + waitFor. Returns the terminal job — check `job.status` ("complete" or "failed"). */
  async generate(prompt: string, opts: GenerateOptions & { pollIntervalMs?: number; timeoutMs?: number } = {}): Promise<Job> {
    const { pollIntervalMs, timeoutMs, ...submitOpts } = opts;
    const accepted = await this.submit(prompt, submitOpts);
    return this.waitFor(accepted.job_id, { pollIntervalMs, timeoutMs });
  }
}

/**
 * Verify a Tunova webhook delivery. The header `X-Webhook-Signature: sha256=<hmac>` is the
 * HMAC-SHA256 of `<X-Webhook-Timestamp>.<rawBody>` keyed with your `whsec_…` secret. Verify
 * against the RAW body before parsing. Returns true iff the signature matches AND the timestamp
 * is within `toleranceSec` (anti-replay; pass 0 to skip the freshness check).
 */
export function verifyWebhook(opts: {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
  toleranceSec?: number;
}): boolean {
  const { secret, timestamp, body, signature, toleranceSec = 300 } = opts;
  if (toleranceSec) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
