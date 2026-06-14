// Minimal example. Node 18+ (global fetch). Run with tsx:
//   TUNOVA_API_KEY=sk_live_… npx tsx example.ts
import { Tunova } from "./tunova";

const t = new Tunova(process.env.TUNOVA_API_KEY!);

// Submit + poll until the track is delivered (billed only on success).
const job = await t.generate("calm rainy-night lofi", { model: "v5.5" });

console.log(job.status === "complete" ? job.clips[0]?.audio_url : `failed (auto-refunded): ${job.error}`);
