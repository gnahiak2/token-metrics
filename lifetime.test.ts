import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {aggregateFromSample, mergeAggregate, emptyAggregate} from './metrics.ts';
import {LifetimeStore} from './lifetime.ts';

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), 'token-metrics-'));
	try {
		await run(directory);
	} finally {
		await rm(directory, {recursive: true, force: true});
	}
}

test('lifetime stats merge across separate store instances', async () => {
	await withDirectory(async directory => {
		const file = join(directory, 'nested', 'lifetime.json');
		const first = new LifetimeStore(file);
		await first.merge(aggregateFromSample({model: 'a', outputTokens: 10, durationMs: 1000, ttftMs: 100}));
		const second = new LifetimeStore(file);
		const loaded = await second.merge(
			aggregateFromSample({model: 'a', outputTokens: 20, durationMs: 2000, ttftMs: 300}),
		);
		assert.equal(loaded.overall.requests, 2);
		assert.equal(loaded.overall.outputTokens, 30);
		assert.equal(loaded.overall.durationMs, 3000);
		assert.equal(loaded.overall.ttftSamples, 2);
		assert.equal(loaded.overall.models.a.requests, 2);
		const raw = JSON.parse(await readFile(file, 'utf8'));
		assert.equal(raw.version, 1);
		assert.equal(raw.overall.requests, 2);
	});
});

test('two writers merge deltas instead of replacing the file', async () => {
	await withDirectory(async directory => {
		const file = join(directory, 'lifetime.json');
		const left = new LifetimeStore(file);
		const right = new LifetimeStore(file);
		await Promise.all([
			left.merge(aggregateFromSample({model: 'left', outputTokens: 10, durationMs: 1000})),
			right.merge(aggregateFromSample({model: 'right', outputTokens: 20, durationMs: 1000})),
		]);
		const final = await new LifetimeStore(file).load();
		assert.equal(final.overall.requests, 2);
		assert.deepEqual(Object.keys(final.overall.models).sort(), ['left', 'right']);
	});
});

test('missing files start empty and reset clears statistics', async () => {
	await withDirectory(async directory => {
		const file = join(directory, 'lifetime.json');
		const store = new LifetimeStore(file);
		const empty = await store.load();
		assert.equal(empty.overall.requests, 0);
		await store.merge(aggregateFromSample({model: 'a', outputTokens: 5, durationMs: 500}));
		const cleared = await store.reset();
		assert.equal(cleared.overall.requests, 0);
		assert.equal((await store.load()).overall.requests, 0);
	});
});

test('invalid files are backed up before statistics restart', async () => {
	await withDirectory(async directory => {
		const file = join(directory, 'lifetime.json');
		const messages: string[] = [];
		await writeFile(file, '{not json', 'utf8');
		const store = new LifetimeStore(file, message => messages.push(message));
		const loaded = await store.load();
		assert.equal(loaded.overall.requests, 0);
		assert.equal(messages.length, 1);
		const entries = await readdir(directory);
		assert.ok(entries.some(name => name.includes('.corrupt-')));
		await store.merge(aggregateFromSample({model: 'a', outputTokens: 5, durationMs: 500}));
		assert.equal((await store.load()).overall.requests, 1);
	});
});

test('unsupported versions are treated as invalid', async () => {
	await withDirectory(async directory => {
		const file = join(directory, 'lifetime.json');
		const messages: string[] = [];
		await writeFile(file, JSON.stringify({version: 99, overall: emptyAggregate()}), 'utf8');
		const store = new LifetimeStore(file, message => messages.push(message));
		assert.equal((await store.load()).overall.requests, 0);
		assert.equal(messages.length, 1);
	});
});

test('mergeAggregate does not mutate the delta it receives', async () => {
	const delta = aggregateFromSample({model: 'a', outputTokens: 10, durationMs: 1000});
	const target = emptyAggregate();
	mergeAggregate(target, delta);
	assert.equal(delta.requests, 1);
	assert.equal(target.requests, 1);
});
