export { MemoryStore } from "./store.js";
export type {
	DecayResult,
	EmbedFn,
	MemelordConfig,
	Memory,
	MemoryCategory,
	MemoryStats,
	ReportCorrectionInput,
	ReportUserInput,
	SelfReportEntry,
	StartTaskResult,
	TaskEndInput,
	UserInputSource,
	VectorType,
} from "./types.js";

import { MemoryStore } from "./store.js";
import type { MemelordConfig } from "./types.js";

export function createMemoryStore(config: MemelordConfig): MemoryStore {
	return new MemoryStore(config);
}
