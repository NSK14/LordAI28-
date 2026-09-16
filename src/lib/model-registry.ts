import type { ModelRegistryEntry } from "./lord-config";
import { MODEL_REGISTRY_ENTRIES, DEFAULT_MODEL_ID, validateModelId } from "./lord-config";

export { DEFAULT_MODEL_ID, validateModelId };

export const MODEL_REGISTRY: readonly ModelRegistryEntry[] = MODEL_REGISTRY_ENTRIES;
