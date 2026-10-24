export const CHARS_PER_TOKEN = 4;
export const LIVE_WINDOW_MS = 2000;
export const MIN_WINDOW_MS = 500;

export interface Sample {
	readonly model?: string;
	readonly outputTokens?: number;
	readonly durationMs?: number;
	readonly ttftMs?: number;
}

export interface ModelAggregate {
	requests: number;
	outputTokens: number;
	durationMs: number;
	throughputSamples: number;
	ttftMs: number;
	ttftSamples: number;
}

export interface Aggregate {
	requests: number;
	outputTokens: number;
	durationMs: number;
	throughputSamples: number;
	ttftMs: number;
	ttftSamples: number;
	models: Record<string, ModelAggregate>;
}

export interface Averages {
	readonly throughput: number | undefined;
	readonly ttftMs: number | undefined;
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function emptyModelAggregate(): ModelAggregate {
	return {
		requests: 0,
		outputTokens: 0,
		durationMs: 0,
		throughputSamples: 0,
		ttftMs: 0,
		ttftSamples: 0,
	};
}

export function emptyAggregate(): Aggregate {
	return {
		requests: 0,
		outputTokens: 0,
		durationMs: 0,
		throughputSamples: 0,
		ttftMs: 0,
		ttftSamples: 0,
		models: {},
	};
}

export function isEmptyAggregate(value: Aggregate): boolean {
	return value.requests === 0 && Object.keys(value.models).length === 0;
}

export function sanitizeModelAggregate(value: unknown): ModelAggregate {
	const source = isRecord(value) ? value : {};
	return {
		requests: count(source.requests),
		outputTokens: count(source.outputTokens),
		durationMs: count(source.durationMs),
		throughputSamples: count(source.throughputSamples),
		ttftMs: count(source.ttftMs),
		ttftSamples: count(source.ttftSamples),
	};
}

export function sanitizeAggregate(value: unknown): Aggregate {
	const source = isRecord(value) ? value : {};
	const aggregate = emptyAggregate();
	aggregate.requests = count(source.requests);
	aggregate.outputTokens = count(source.outputTokens);
	aggregate.durationMs = count(source.durationMs);
	aggregate.throughputSamples = count(source.throughputSamples);
	aggregate.ttftMs = count(source.ttftMs);
	aggregate.ttftSamples = count(source.ttftSamples);
	if (isRecord(source.models)) {
		for (const [name, model] of Object.entries(source.models)) {
			if (name.length > 0 && isRecord(model)) aggregate.models[name] = sanitizeModelAggregate(model);
		}
	}
	return aggregate;
}

export function modelKey(model: unknown): string {
	return typeof model === 'string' && model.length > 0 ? model : 'unknown';
}

export function addSample(aggregate: Aggregate, sample: Sample): void {
	aggregate.requests += 1;
	const name = modelKey(sample.model);
	const model = (aggregate.models[name] ??= emptyModelAggregate());
	model.requests += 1;
	const outputTokens = count(sample.outputTokens);
	const durationMs = count(sample.durationMs);
	if (outputTokens > 0 && durationMs > 0) {
		aggregate.outputTokens += outputTokens;
		aggregate.durationMs += durationMs;
		aggregate.throughputSamples += 1;
		model.outputTokens += outputTokens;
		model.durationMs += durationMs;
		model.throughputSamples += 1;
	}
	if (typeof sample.ttftMs === 'number' && Number.isFinite(sample.ttftMs) && sample.ttftMs >= 0) {
		aggregate.ttftMs += sample.ttftMs;
		aggregate.ttftSamples += 1;
		model.ttftMs += sample.ttftMs;
		model.ttftSamples += 1;
	}
}

function mergeModelAggregate(target: ModelAggregate, delta: ModelAggregate): void {
	target.requests += delta.requests;
	target.outputTokens += delta.outputTokens;
	target.durationMs += delta.durationMs;
	target.throughputSamples += delta.throughputSamples;
	target.ttftMs += delta.ttftMs;
	target.ttftSamples += delta.ttftSamples;
}

export function mergeAggregate(target: Aggregate, delta: Aggregate): Aggregate {
	target.requests += delta.requests;
	target.outputTokens += delta.outputTokens;
	target.durationMs += delta.durationMs;
	target.throughputSamples += delta.throughputSamples;
	target.ttftMs += delta.ttftMs;
	target.ttftSamples += delta.ttftSamples;
	for (const [name, model] of Object.entries(delta.models)) {
		mergeModelAggregate((target.models[name] ??= emptyModelAggregate()), model);
	}
	return target;
}

export function aggregateFromSample(sample: Sample): Aggregate {
	const aggregate = emptyAggregate();
	addSample(aggregate, sample);
	return aggregate;
}

export function aggregateAverages(aggregate: Aggregate): Averages {
	return {
		throughput:
			aggregate.throughputSamples > 0 && aggregate.durationMs > 0
				? aggregate.outputTokens / (aggregate.durationMs / 1000)
				: undefined,
		ttftMs: aggregate.ttftSamples > 0 ? aggregate.ttftMs / aggregate.ttftSamples : undefined,
	};
}

export function endToEndRate(outputTokens: number | undefined, durationMs: number | undefined): number | undefined {
	if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens <= 0) return undefined;
	if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) return undefined;
	return outputTokens / (durationMs / 1000);
}

export function estimateTokensFromChars(chars: number): number {
	return Math.max(0, chars) / CHARS_PER_TOKEN;
}

export function liveRate(
	samples: readonly {t: number; chars: number}[],
	now: number,
	firstContentAt: number | undefined,
	windowMs: number = LIVE_WINDOW_MS,
	minWindowMs: number = MIN_WINDOW_MS,
): number {
	let chars = 0;
	const start = Math.max(firstContentAt ?? now, now - windowMs);
	for (const sample of samples) {
		if (sample.t >= start) chars += sample.chars;
	}
	const elapsed = Math.max(now - start, minWindowMs);
	return estimateTokensFromChars(chars) / (elapsed / 1000);
}

export function contentCharCount(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (typeof block.text === 'string') chars += block.text.length;
		if (typeof block.thinking === 'string') chars += block.thinking.length;
	}
	return chars;
}

export function safeJsonLength(value: unknown): number {
	if (value === undefined) return 0;
	if (typeof value === 'string') return value.length;
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}

export function formatRate(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return '—';
	if (value >= 100) return value.toFixed(0);
	return value.toFixed(1);
}

export function formatDuration(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value) || value < 0) return '—';
	if (value < 1000) return `${Math.round(value)}ms`;
	if (value < 10000) return `${(value / 1000).toFixed(2)}s`;
	return `${(value / 1000).toFixed(1)}s`;
}

export function formatSampleCount(value: number): string {
	return Number.isFinite(value) && value > 0 ? `${Math.floor(value)}` : '0';
}
