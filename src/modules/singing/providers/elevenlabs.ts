import { ProviderError, ProviderRateLimitedError } from "../../../shared/errors.js";
import type { CompositionPlan } from "../plan.js";
import type { SingingProvider } from "./provider.js";

const URL = "https://api.elevenlabs.io/v1/music";

export class ElevenLabsProvider implements SingingProvider {
  readonly name = "elevenlabs";
  constructor(private readonly apiKey: string) {}

  async sing(plan: CompositionPlan, modelId: string): Promise<Buffer> {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ composition_plan: plan, model_id: modelId }),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 429) {
      // Measured: Creator plan rejects the 3rd concurrent request with 429.
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new ProviderRateLimitedError(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000, await res.text());
    }
    if (!res.ok) throw new ProviderError(res.status, await res.text());
    return Buffer.from(await res.arrayBuffer());
  }
}
