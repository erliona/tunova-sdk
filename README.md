# Tunova SDK

Tiny, **zero-dependency** clients + MCP manifest for the [Tunova](https://tunova.ai) music API —
generate music with Suno (v5.5) over a simple REST or MCP interface.
Generation is async and **billed only on success**: a failed render refunds itself.

- **Python** → [`python/tunova.py`](python/tunova.py) — stdlib only, Python 3.8+.
- **Node / TypeScript** → [`node/tunova.ts`](node/tunova.ts) — Node 18+ (`fetch` built in).
- **MCP** → [`server.json`](server.json) — hosted Streamable-HTTP server at `https://api.tunova.ai/mcp`.

Get a key (50 free tokens, no card) at **<https://tunova.ai>**. Full reference:
<https://api.tunova.ai/docs> · live status: <https://tunova.ai/status>.

> Tunova is an independent service, not affiliated with or endorsed by Suno. Tracks come from paid
> Suno plans; review Suno's terms for your use case.

## Python

```bash
pip install tunova
```

```python
from tunova import Tunova

t = Tunova("sk_live_…")
job = t.generate("warm lo-fi piano to study to", model="v5.5")
print(job["clips"][0]["audio_url"] if job["status"] == "complete" else job["error"])
```

Prefer no install? `python/tunova.py` is stdlib-only — vendor the single file and `import` it.

## Node / TypeScript

```bash
npm i tunova
```

```ts
import { Tunova } from "tunova";

const t = new Tunova(process.env.TUNOVA_API_KEY!);
const job = await t.generate("warm lo-fi piano to study to", { model: "v5.5" });
console.log(job.status === "complete" ? job.clips[0]?.audio_url : job.error);
```

Both `generate()` calls submit a job and poll until the track is delivered. Prefer fire-and-forget?
Use `submit()` with a `callback_url` and take an HMAC-signed webhook instead.

## MCP — give an AI agent the power to make music

```bash
claude mcp add --transport http tunova https://api.tunova.ai/mcp \
  --header "X-API-Key: sk_live_…"
```

Tools: `generate_song` · `wait_for_song` · `check_song`. Same API key, same billed-on-success rule.

## Verifying webhooks

If you pass `callback_url`, Tunova POSTs the terminal job with
`X-Webhook-Signature: sha256=<hmac>` over `<X-Webhook-Timestamp>.<rawBody>`, keyed with your
`whsec_…` secret (view/rotate it on the dashboard's API-keys page). Verify against the **raw** body
before parsing — both SDKs ship a verifier (`Tunova.verify_webhook` / `verifyWebhook`).

## License

MIT — see [LICENSE](LICENSE). The SDK code is yours to use freely; your use of the Tunova API is
governed by the [terms](https://tunova.ai/terms).
