import type { CompositionPlan } from "../plan.js";

// Everything provider-specific stays behind this interface, so swapping
// ElevenLabs for self-hosted ACE-Step later touches one file.
export interface SingingProvider {
  readonly name: string;
  sing(plan: CompositionPlan, modelId: string): Promise<Buffer>;
}
