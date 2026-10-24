import {
	LIVE_WINDOW_MS,
	addSample,
	contentCharCount,
	emptyAggregate,
	liveRate,
	safeJsonLength,
	sanitizeAggregate,
	type Aggregate,
	type Sample,
} from './metrics.ts';

export interface Completion {
	readonly model: string;
	readonly outputTokens: number | undefined;
	readonly durationMs: number;
	readonly ttftMs: number | undefined;
	readonly rate: number | undefined;
}

export interface LiveStats {
	readonly model: string;
	readonly elapsedMs: number;
	readonly ttftMs: number | undefined;
	readonly rate: number;
	readonly chars: number;
}

interface ActiveRequest {
	readonly model: string;
	readonly startedAt: number;
	firstContentAt: number | undefined;
	chars: number;
	contentChars: number;
	hasStreamDeltas: boolean;
	readonly seenTools: Set<string>;
	samples: {t: number; chars: number}[];
}

export interface TrackerOptions {
	readonly now?: () => number;
	readonly onSample?: (sample: Sample) => void;
}

export class TokenTracker {
	readonly session: Aggregate;
	private readonly now: () => number;
	private readonly onSample: ((sample: Sample) => void) | undefined;
	private active: ActiveRequest | undefined;
	private lastCompletion: Completion | undefined;

	constructor(options: TrackerOptions = {}) {
		this.now = options.now ?? (() => performance.now());
		this.onSample = options.onSample;
		this.session = emptyAggregate();
	}

	isActive(): boolean {
		return this.active !== undefined;
	}

	activeModel(): string | undefined {
		return this.active?.model;
	}

	last(): Completion | undefined {
		return this.lastCompletion;
	}

	hydrateSession(value: unknown): void {
		const aggregate = sanitizeAggregate(value);
		this.session.requests = aggregate.requests;
		this.session.outputTokens = aggregate.outputTokens;
		this.session.durationMs = aggregate.durationMs;
		this.session.throughputSamples = aggregate.throughputSamples;
		this.session.ttftMs = aggregate.ttftMs;
		this.session.ttftSamples = aggregate.ttftSamples;
		this.session.models = aggregate.models;
	}

	restoreLast(value: unknown): void {
		if (typeof value !== 'object' || value === null) return;
		const source = value as Record<string, unknown>;
		if (typeof source.model !== 'string' || !Number.isFinite(source.durationMs)) return;
		this.lastCompletion = {
			model: source.model,
			outputTokens:
				typeof source.outputTokens === 'number' && Number.isFinite(source.outputTokens)
					? source.outputTokens
					: undefined,
			durationMs: source.durationMs as number,
			ttftMs: typeof source.ttftMs === 'number' && Number.isFinite(source.ttftMs) ? source.ttftMs : undefined,
			rate: typeof source.rate === 'number' && Number.isFinite(source.rate) ? source.rate : undefined,
		};
	}

	modelStart(model: unknown): void {
		this.active = {
			model: typeof model === 'string' && model.length > 0 ? model : 'unknown',
			startedAt: this.now(),
			firstContentAt: undefined,
			chars: 0,
			contentChars: 0,
			hasStreamDeltas: false,
			seenTools: new Set(),
			samples: [],
		};
	}

	recordDelta(delta: unknown): void {
		if (typeof delta !== 'string' || delta.length === 0) return;
		this.activeRecord(delta.length, true);
	}

	markFirstContent(): void {
		if (!this.active || this.active.firstContentAt !== undefined) return;
		this.active.firstContentAt = this.now();
	}

	toolQueued(toolCallId: unknown, input: unknown): void {
		const active = this.active;
		if (!active) return;
		const key =
			typeof toolCallId === 'string' && toolCallId.length > 0 ? toolCallId : `anonymous-${active.seenTools.size}`;
		if (active.seenTools.has(key)) return;
		active.seenTools.add(key);
		this.markFirstContent();
		this.addChars(safeJsonLength(input));
	}

	noteContent(content: unknown): void {
		const active = this.active;
		if (!active) return;
		const chars = contentCharCount(content);
		if (chars <= 0) return;
		this.markFirstContent();
		if (active.hasStreamDeltas) return;
		if (chars > active.contentChars) {
			const delta = chars - active.contentChars;
			active.contentChars = chars;
			this.addChars(delta);
		}
	}

	streamRestart(discardedVisibleContent: boolean): void {
		const active = this.active;
		if (!active || !discardedVisibleContent) return;
		active.chars = 0;
		active.contentChars = 0;
		active.firstContentAt = undefined;
		active.hasStreamDeltas = false;
		active.samples = [];
		active.seenTools.clear();
	}

	finish(model: unknown, usage: unknown): Sample | undefined {
		const active = this.active;
		if (!active) return undefined;
		const endedAt = this.now();
		this.active = undefined;
		const usageRecord =
			typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : undefined;
		const outputTokens =
			typeof usageRecord?.outputTokens === 'number' &&
			Number.isFinite(usageRecord.outputTokens) &&
			usageRecord.outputTokens >= 0
				? usageRecord.outputTokens
				: undefined;
		const durationMs = Math.max(0, endedAt - active.startedAt);
		const ttftMs =
			active.firstContentAt === undefined ? undefined : Math.max(0, active.firstContentAt - active.startedAt);
		const sample: Sample = {
			model: typeof model === 'string' && model.length > 0 ? model : active.model,
			outputTokens,
			durationMs,
			ttftMs,
		};
		addSample(this.session, sample);
		this.lastCompletion = {
			model: sample.model ?? active.model,
			outputTokens,
			durationMs,
			ttftMs,
			rate:
				outputTokens !== undefined && outputTokens > 0 && durationMs > 0
					? outputTokens / (durationMs / 1000)
					: undefined,
		};
		this.onSample?.(sample);
		return sample;
	}

	abort(): void {
		this.active = undefined;
	}

	live(): LiveStats | undefined {
		const active = this.active;
		if (!active) return undefined;
		const now = this.now();
		return {
			model: active.model,
			elapsedMs: Math.max(0, now - active.startedAt),
			ttftMs: active.firstContentAt === undefined ? undefined : Math.max(0, active.firstContentAt - active.startedAt),
			rate: active.chars > 0 ? liveRate(active.samples, now, active.firstContentAt) : 0,
			chars: active.chars,
		};
	}

	resetSession(): void {
		this.session.requests = 0;
		this.session.outputTokens = 0;
		this.session.durationMs = 0;
		this.session.throughputSamples = 0;
		this.session.ttftMs = 0;
		this.session.ttftSamples = 0;
		this.session.models = {};
		this.lastCompletion = undefined;
	}

	private activeRecord(chars: number, streamDelta: boolean): void {
		const active = this.active;
		if (!active) return;
		this.markFirstContent();
		if (streamDelta) active.hasStreamDeltas = true;
		this.addChars(chars);
	}

	private addChars(chars: number): void {
		const active = this.active;
		if (!active || chars <= 0) return;
		active.chars += chars;
		active.samples.push({t: this.now(), chars});
		if (active.samples.length > 64 && active.samples.length % 64 === 0) {
			const cutoff = this.now() - 2 * LIVE_WINDOW_MS;
			active.samples = active.samples.filter(sample => sample.t >= cutoff);
		}
	}
}
