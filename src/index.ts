import {homedir} from 'node:os';
import {join} from 'node:path';
import type {ModApi} from '@commandcode/harness';
import {
	aggregateAverages,
	aggregateFromSample,
	emptyAggregate,
	formatDuration,
	formatRate,
	formatSampleCount,
	isEmptyAggregate,
	mergeAggregate,
	sanitizeAggregate,
	type Aggregate,
} from './metrics.ts';
import {describe, LifetimeStore, type LifetimeData} from './lifetime.ts';
import {TokenTracker} from './tracker.ts';

const STORE_FILE = join(homedir(), '.commandcode', 'mods', '.store', 'token-metrics', 'lifetime.json');
const REFRESH_MS = 250;
const FLUSH_MS = 500;

interface TextNode {
	type: 'text';
	text: string;
	color?: 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'gray';
	dim?: boolean;
	bold?: boolean;
}

interface RowNode {
	type: 'row';
	children: TextNode[];
}

type WidgetNode = TextNode | RowNode;

function valueNode(value: number | undefined): string {
	return value === undefined ? '—' : formatRate(value);
}

function sinceLabel(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 10);
}

export interface TokenMetricsOptions {
	readonly storeFile?: string;
	readonly now?: () => number;
}

export async function createTokenMetricsMod(cmd: ModApi, options: TokenMetricsOptions = {}): Promise<void> {
	const clock = options.now ?? (() => performance.now());
	const storePath = options.storeFile ?? STORE_FILE;
	const store = new LifetimeStore(storePath, message => cmd.ui.notify(message, 'warning'));
	let lifetime: LifetimeData = await store.load();
	let pending: Aggregate = emptyAggregate();
	let flushTimer: {dispose(): void} | undefined;
	let flushChain: Promise<void> = Promise.resolve();
	let saveFailureReported = false;
	let sessionId: string | undefined;

	const tracker = new TokenTracker({
		now: clock,
		onSample: sample => {
			const delta = aggregateFromSample(sample);
			mergeAggregate(pending, delta);
			mergeAggregate(lifetime.overall, delta);
			writeSessionState();
			scheduleFlush();
			cmd.ui.refreshWidgets();
		},
	});

	tracker.hydrateSession(cmd.state.get('session'));
	tracker.restoreLast(cmd.state.get('last'));

	function writeSessionState(): void {
		cmd.state.set('session', sanitizeAggregate(tracker.session));
		cmd.state.set('last', tracker.last() ?? null);
	}

	function reportSaveFailure(error: unknown): void {
		if (saveFailureReported) return;
		saveFailureReported = true;
		cmd.ui.notify(
			`Token metrics could not save lifetime stats to ${storePath}: ${describe(error)}. Live stats keep working.`,
			'warning',
		);
	}

	async function flushPending(): Promise<void> {
		const run = flushChain.then(async () => {
			if (isEmptyAggregate(pending)) return;
			const delta = pending;
			pending = emptyAggregate();
			try {
				const merged = await store.merge(delta);
				mergeAggregate(merged.overall, pending);
				lifetime = merged;
			} catch (error) {
				mergeAggregate(pending, delta);
				reportSaveFailure(error);
			}
		});
		flushChain = run.catch(() => {});
		await run;
	}

	function scheduleFlush(): void {
		if (flushTimer) return;
		flushTimer = cmd.clock.after(FLUSH_MS, () => {
			flushTimer = undefined;
			void flushPending();
		});
	}

	function resetSessionView(): void {
		tracker.resetSession();
		cmd.state.set('session', emptyAggregate());
		cmd.state.set('last', null);
		cmd.ui.refreshWidgets();
	}

	function renderWidget(width: number): WidgetNode[] {
		const live = tracker.live();
		const last = tracker.last();
		const session = aggregateAverages(tracker.session);
		const life = aggregateAverages(lifetime.overall);
		if (!live && !last && tracker.session.requests === 0 && lifetime.overall.requests === 0) return [];
		const wide = width >= 118;
		const mid = width >= 74;
		const children: TextNode[] = [];
		const dot = () => children.push({type: 'text', text: ' · ', dim: true});
		if (live) {
			children.push({type: 'text', text: 'live ', dim: true});
			if (live.ttftMs === undefined) {
				children.push({type: 'text', text: `waiting for first token (${formatDuration(live.elapsedMs)})`, dim: true});
			} else {
				children.push({type: 'text', text: `~${formatRate(live.rate)} tok/s`, color: 'cyan'});
				dot();
				children.push({type: 'text', text: `ttft ${formatDuration(live.ttftMs)}`});
			}
		} else if (last) {
			children.push({type: 'text', text: 'last ', dim: true});
			children.push({
				type: 'text',
				text: last.rate === undefined ? 'no reported usage' : `${formatRate(last.rate)} tok/s`,
				color: 'green',
			});
			dot();
			children.push({type: 'text', text: `ttft ${formatDuration(last.ttftMs)}`});
		} else {
			children.push({type: 'text', text: 'token metrics ready', dim: true});
		}
		if (mid && session.throughput !== undefined) {
			dot();
			children.push({type: 'text', text: `avg ${formatRate(session.throughput)} tok/s`, dim: true});
		}
		if (wide && life.throughput !== undefined) {
			dot();
			children.push({type: 'text', text: `lifetime ${formatRate(life.throughput)} tok/s`, dim: true});
		}
		return [{type: 'row', children}];
	}

	cmd.ui.widget({
		placement: 'above-editor',
		render: props => {
			try {
				const width = Number.isFinite(props?.width) ? Number(props?.width) : 80;
				return renderWidget(width);
			} catch {
				return [];
			}
		},
	});

	if (cmd.ui.capabilities?.surface !== false) {
		cmd.clock.every(REFRESH_MS, () => {
			if (tracker.isActive()) cmd.ui.refreshWidgets();
		});
	}

	cmd.on('run_start', event => {
		const nextSessionId =
			typeof (event as {sessionId?: unknown}).sessionId === 'string'
				? (event as {sessionId: string}).sessionId
				: undefined;
		if (sessionId !== undefined && nextSessionId !== undefined && sessionId !== nextSessionId) {
			resetSessionView();
		}
		if (nextSessionId !== undefined) sessionId = nextSessionId;
	});

	cmd.on('session_start', () => {
		tracker.abort();
		tracker.hydrateSession(cmd.state.get('session'));
		tracker.restoreLast(cmd.state.get('last'));
		cmd.ui.refreshWidgets();
	});

	cmd.on('model_request_start', event => {
		tracker.modelStart((event as {model?: unknown}).model);
		cmd.ui.refreshWidgets();
	});

	cmd.on('text_delta', event => {
		tracker.recordDelta((event as {delta?: unknown}).delta);
	});

	cmd.on('thinking_delta', event => {
		tracker.recordDelta((event as {delta?: unknown}).delta);
	});

	cmd.on('thinking_end', event => {
		const payload = event as {text?: unknown};
		if (typeof payload.text === 'string' && payload.text.length > 0) tracker.markFirstContent();
	});

	cmd.on('tool_queued', event => {
		const payload = event as {toolCallId?: unknown; input?: unknown};
		tracker.toolQueued(payload.toolCallId, payload.input);
	});

	cmd.on('message_update', event => {
		tracker.noteContent((event as {content?: unknown}).content);
	});

	cmd.on('stream_restart', event => {
		const payload = event as {discardedVisibleContent?: unknown};
		tracker.streamRestart(payload.discardedVisibleContent !== false);
	});

	cmd.on('model_request_end', event => {
		const payload = event as {model?: unknown; usage?: unknown};
		tracker.finish(payload.model, payload.usage);
	});

	cmd.on('interrupted', () => {
		tracker.abort();
		cmd.ui.refreshWidgets();
	});

	cmd.on('run_error', () => {
		tracker.abort();
		cmd.ui.refreshWidgets();
	});

	cmd.on('run_end', () => {
		tracker.abort();
		void flushPending();
	});

	cmd.on('session_shutdown', () => {
		tracker.abort();
		void flushPending();
	});

	function buildReport(): string {
		const live = tracker.live();
		const last = tracker.last();
		const session = tracker.session;
		const sessionAverages = aggregateAverages(session);
		const lifeAverages = aggregateAverages(lifetime.overall);
		const lines: string[] = ['Token metrics'];
		if (live) {
			const state =
				live.ttftMs === undefined
					? `waiting for first token (${formatDuration(live.elapsedMs)})`
					: `~${formatRate(live.rate)} tok/s est. · ttft ${formatDuration(live.ttftMs)}`;
			lines.push(`live      ${state} · ${live.model} · ${formatDuration(live.elapsedMs)} elapsed`);
		} else {
			lines.push('live      idle');
		}
		if (last) {
			const rate = last.rate === undefined ? 'no reported usage' : `${formatRate(last.rate)} tok/s end-to-end`;
			const tokens = last.outputTokens === undefined ? 'tokens —' : `${formatSampleCount(last.outputTokens)} output tokens`;
			lines.push(
				`last      ${rate} · ttft ${formatDuration(last.ttftMs)} · ${formatDuration(last.durationMs)} · ${tokens} · ${last.model}`,
			);
		} else {
			lines.push('last      none yet');
		}
		lines.push(
			`session   ${valueNode(sessionAverages.throughput)} tok/s avg · ttft avg ${formatDuration(sessionAverages.ttftMs)} · ${formatSampleCount(session.requests)} request(s) · ${formatSampleCount(session.throughputSamples)} measured`,
		);
		lines.push(
			`lifetime  ${valueNode(lifeAverages.throughput)} tok/s avg · ttft avg ${formatDuration(lifeAverages.ttftMs)} · ${formatSampleCount(lifetime.overall.requests)} request(s) since ${sinceLabel(lifetime.since)}`,
		);
		const sessionModels = Object.entries(session.models).sort((a, b) => b[1].requests - a[1].requests);
		if (sessionModels.length > 0) {
			lines.push('session models');
			for (const [name, model] of sessionModels) {
				const averages = aggregateAverages({...model, models: {}});
				lines.push(
					`  ${name}  ${valueNode(averages.throughput)} tok/s · ttft ${formatDuration(averages.ttftMs)} · ${formatSampleCount(model.requests)} req`,
				);
			}
		}
		const lifetimeModels = Object.entries(lifetime.overall.models).sort((a, b) => b[1].requests - a[1].requests);
		if (lifetimeModels.length > 0) {
			lines.push('lifetime models');
			for (const [name, model] of lifetimeModels) {
				const averages = aggregateAverages({...model, models: {}});
				lines.push(
					`  ${name}  ${valueNode(averages.throughput)} tok/s · ttft ${formatDuration(averages.ttftMs)} · ${formatSampleCount(model.requests)} req`,
				);
			}
		}
		lines.push('rate is provider-reported output tokens over request wall time, including TTFT; live ~ is a char-based estimate.');
		return lines.join('\n');
	}

	async function handleReset(
		targets: string[],
		args: string,
		ui: {confirm: (options: {title: string; message?: string}) => Promise<boolean>},
	): Promise<string> {
		if (tracker.isActive()) return 'Cannot reset token metrics while a request is streaming.';
		const target = targets[1];
		if (targets.length === 2 && target === 'session') {
			resetSessionView();
			return 'Session token metrics reset. Lifetime averages were kept.';
		}
		if (targets.length === 2 && target === 'all') {
			const approved = await ui.confirm({
				title: 'Reset all token metrics?',
				message: 'This clears session and lifetime averages. This cannot be undone.',
			});
			if (!approved) return 'Reset cancelled.';
			try {
				await flushPending();
				lifetime = await store.reset();
				pending = emptyAggregate();
				resetSessionView();
				return 'All token metrics reset.';
			} catch (error) {
				return `Could not reset lifetime stats: ${describe(error)}`;
			}
		}
		return `Unknown reset target "${args.trim()}". Use /token-stats reset session or /token-stats reset all.`;
	}

	cmd.addCommand({
		name: 'token-stats',
		description: 'Show live tok/s, TTFT, and session/lifetime averages; reset metrics.',
		argumentHint: '[reset session|reset all]',
		handler: async ({args, ui}) => {
			const text = typeof args === 'string' ? args.trim() : '';
			if (text.length === 0) return {message: buildReport()};
			const targets = text.split(/\s+/);
			if (targets[0] === 'reset') return {message: await handleReset(targets, text, ui)};
			return {
				message: `Unknown arguments "${text}".\n${buildReport()}`,
			};
		},
	});
}

export default function (cmd: ModApi): Promise<void> {
	return createTokenMetricsMod(cmd);
}
