import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createTokenMetricsMod} from './index.ts';

interface FakeHost {
	readonly cmd: any;
	readonly commands: Map<string, any>;
	readonly notifications: {message: string; level?: string}[];
	readonly widgets: any[];
	readonly state: Map<string, unknown>;
	readonly timers: {fn: () => void; disposed: boolean}[];
	readonly ui: any;
	emit(type: string, event?: Record<string, unknown>): void;
	setConfirm(value: boolean): void;
}

function createFakeHost(confirm = true): FakeHost {
	const handlers = new Map<string, ((event: Record<string, unknown>) => void)[]>();
	const state = new Map<string, unknown>();
	const commands = new Map<string, any>();
	const notifications: {message: string; level?: string}[] = [];
	const widgets: any[] = [];
	const timers: {fn: () => void; disposed: boolean}[] = [];
	let confirmResult = confirm;
	const ui = {
		widget: (config: any) => {
			widgets.push(config);
			return {dispose() {}};
		},
		capabilities: {surface: true, status: true},
		notify: (message: string, level?: string) => notifications.push({message, level}),
		refreshWidgets: () => {},
		confirm: async () => confirmResult,
	};
	const cmd = {
		name: 'token-metrics',
		ui,
		state: {
			get: (key: string) => state.get(key),
			set: (key: string, value: unknown) => {
				state.set(key, value);
			},
		},
		clock: {
			after: (_ms: number, fn: () => void) => {
				const timer = {fn, disposed: false};
				timers.push(timer);
				return {
					dispose() {
						timer.disposed = true;
					},
				};
			},
			every: () => ({dispose() {}}),
		},
		on: (type: string, handler: (event: Record<string, unknown>) => void) => {
			const list = handlers.get(type) ?? [];
			list.push(handler);
			handlers.set(type, list);
			return {dispose() {}};
		},
		addCommand: (command: any) => {
			commands.set(command.name, command);
			return {dispose() {}};
		},
	};
	return {
		cmd,
		commands,
		notifications,
		widgets,
		state,
		timers,
		ui,
		emit: (type, event = {}) => {
			for (const handler of handlers.get(type) ?? []) handler(event);
		},
		setConfirm: value => {
			confirmResult = value;
		},
	};
}

function widgetText(host: FakeHost, width: number): string {
	const widget = host.widgets[0];
	const nodes = widget.render({width});
	return nodes
		.flatMap((node: any) => (node.type === 'row' ? node.children.map((child: any) => child.text) : [node.text]))
		.join('');
}

async function flushTimers(host: FakeHost): Promise<void> {
	for (const timer of host.timers) {
		if (!timer.disposed) {
			timer.fn();
			timer.disposed = true;
		}
	}
	await new Promise(resolve => setTimeout(resolve, 30));
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error('condition not met in time');
}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), 'token-metrics-index-'));
	try {
		await run(directory);
	} finally {
		await rm(directory, {recursive: true, force: true});
	}
}

test('events drive the live widget, report, persistence, and resets', async () => {
	await withDirectory(async directory => {
		const file = join(directory, 'lifetime.json');
		const host = createFakeHost();
		let now = 0;
		await createTokenMetricsMod(host.cmd, {storeFile: file, now: () => now});

		now = 0;
		host.emit('model_request_start', {model: 'model-a'});
		now = 50;
		assert.match(widgetText(host, 100), /waiting for first token/);
		now = 200;
		host.emit('text_delta', {delta: 'abcd'});
		now = 600;
		host.emit('thinking_delta', {delta: 'efgh'});
		const live = widgetText(host, 140);
		assert.match(live, /live ~4\.0 tok\/s/);
		assert.match(live, /ttft 200ms/);
		assert.doesNotMatch(live, /lifetime/);

		now = 1200;
		host.emit('model_request_end', {model: 'model-a', usage: {outputTokens: 10}});
		const idle = widgetText(host, 140);
		assert.match(idle, /last 8\.3 tok\/s/);
		assert.match(idle, /avg 8\.3 tok\/s/);
		assert.match(idle, /lifetime 8\.3 tok\/s/);
		const narrow = widgetText(host, 30);
		assert.match(narrow, /last 8\.3 tok\/s/);
		assert.doesNotMatch(narrow, /avg/);
		assert.equal((host.state.get('session') as {requests: number}).requests, 1);

		await flushTimers(host);
		await waitFor(async () => {
			try {
				const data = JSON.parse(await readFile(file, 'utf8'));
				return data.overall.requests === 1;
			} catch {
				return false;
			}
		});
		const persisted = JSON.parse(await readFile(file, 'utf8'));
		assert.equal(persisted.overall.models['model-a'].requests, 1);
		assert.equal(persisted.overall.models['model-a'].outputTokens, 10);

		const command = host.commands.get('token-stats');
		const report = await command.handler({args: '', ui: host.ui});
		assert.match(report.message, /last {6}8\.3 tok\/s end-to-end/);
		assert.match(report.message, /session models/);
		assert.match(report.message, /lifetime models/);
		assert.match(report.message, /model-a {2}8\.3 tok\/s/);

		const sessionReset = await command.handler({args: 'reset session', ui: host.ui});
		assert.match(sessionReset.message, /Session token metrics reset/);
		const afterSessionReset = await command.handler({args: '', ui: host.ui});
		assert.match(afterSessionReset.message, /session {3}— tok\/s avg/);
		assert.match(afterSessionReset.message, /lifetime {2}8\.3 tok\/s avg/);

		host.setConfirm(false);
		const cancelled = await command.handler({args: 'reset all', ui: host.ui});
		assert.match(cancelled.message, /cancelled/i);
		assert.match((await command.handler({args: '', ui: host.ui})).message, /lifetime {2}8\.3 tok\/s avg/);

		host.setConfirm(true);
		const cleared = await command.handler({args: 'reset all', ui: host.ui});
		assert.match(cleared.message, /All token metrics reset/);
		const afterAll = await command.handler({args: '', ui: host.ui});
		assert.match(afterAll.message, /lifetime {2}— tok\/s avg/);
		await waitFor(async () => JSON.parse(await readFile(file, 'utf8')).overall.requests === 0);
	});
});

test('interruptions never become samples and reset is blocked while streaming', async () => {
	await withDirectory(async directory => {
		const host = createFakeHost();
		let now = 0;
		await createTokenMetricsMod(host.cmd, {storeFile: join(directory, 'lifetime.json'), now: () => now});
		now = 100;
		host.emit('model_request_start', {model: 'model-a'});
		host.emit('text_delta', {delta: 'abcd'});
		now = 200;
		host.emit('interrupted');
		host.emit('model_request_end', {model: 'model-a', usage: {outputTokens: 5}});
		const report = await host.commands.get('token-stats').handler({args: '', ui: host.ui});
		assert.match(report.message, /session {3}— tok\/s avg/);
		assert.match(report.message, /0 request\(s\)/);

		now = 300;
		host.emit('model_request_start', {model: 'model-b'});
		const blocked = await host.commands.get('token-stats').handler({args: 'reset session', ui: host.ui});
		assert.match(blocked.message, /Cannot reset/);
		host.emit('run_end');
	});

	await withDirectory(async directory => {
		const host = createFakeHost();
		let now = 0;
		await createTokenMetricsMod(host.cmd, {storeFile: join(directory, 'lifetime.json'), now: () => now});
		now = 0;
		host.emit('model_request_start', {model: 'before'});
		host.emit('text_delta', {delta: 'abcd'});
		now = 1000;
		host.emit('model_request_end', {model: 'before', usage: {outputTokens: 10}});
		host.emit('run_start', {sessionId: 'session-one'});
		now = 2000;
		host.emit('run_start', {sessionId: 'session-two'});
		const report = await host.commands.get('token-stats').handler({args: '', ui: host.ui});
		assert.match(report.message, /session {3}— tok\/s avg/);
		assert.match(report.message, /lifetime {2}10\.0 tok\/s avg/);
	});
});

test('a model request end without a start is ignored', async () => {
	await withDirectory(async directory => {
		const host = createFakeHost();
		await createTokenMetricsMod(host.cmd, {
			storeFile: join(directory, 'lifetime.json'),
			now: () => 0,
		});
		host.emit('model_request_end', {model: 'm', usage: {outputTokens: 100}});
		const report = await host.commands.get('token-stats').handler({args: '', ui: host.ui});
		assert.match(report.message, /0 request\(s\)/);
	});
});

test('a save failure warns once and keeps live statistics available', async () => {
	await withDirectory(async directory => {
		const host = createFakeHost();
		const brokenPath = directory;
		let now = 0;
		await createTokenMetricsMod(host.cmd, {storeFile: brokenPath, now: () => now});
		host.emit('model_request_start', {model: 'm'});
		host.emit('text_delta', {delta: 'abcd'});
		now = 1000;
		host.emit('model_request_end', {model: 'm', usage: {outputTokens: 10}});
		await flushTimers(host);
		assert.equal(host.notifications.filter(item => item.level === 'warning').length >= 1, true);
		const report = await host.commands.get('token-stats').handler({args: '', ui: host.ui});
		assert.match(report.message, /10\.0 tok\/s/);
	});
});
