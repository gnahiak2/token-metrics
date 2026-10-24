import assert from 'node:assert/strict';
import test from 'node:test';
import {
	addSample,
	aggregateAverages,
	aggregateFromSample,
	contentCharCount,
	emptyAggregate,
	endToEndRate,
	formatDuration,
	formatRate,
	isEmptyAggregate,
	liveRate,
	mergeAggregate,
	sanitizeAggregate,
} from './src/metrics.ts';

test('addSample keeps weighted token totals and separate TTFT samples', () => {
	const aggregate = emptyAggregate();
	addSample(aggregate, {model: 'a', outputTokens: 10, durationMs: 1000, ttftMs: 100});
	addSample(aggregate, {model: 'a', outputTokens: 100, durationMs: 10000, ttftMs: 200});
	const averages = aggregateAverages(aggregate);
	assert.equal(aggregate.requests, 2);
	assert.equal(aggregate.throughputSamples, 2);
	assert.equal(aggregate.ttftSamples, 2);
	assert.equal(aggregate.outputTokens, 110);
	assert.equal(aggregate.durationMs, 11000);
	assert.equal(averages.throughput, 10);
	assert.equal(averages.ttftMs, 150);
	assert.equal(aggregate.models.a.requests, 2);
});

test('weighted throughput is not the arithmetic mean of per-request rates', () => {
	const aggregate = emptyAggregate();
	addSample(aggregate, {model: 'a', outputTokens: 10, durationMs: 1000});
	addSample(aggregate, {model: 'a', outputTokens: 10, durationMs: 10000});
	assert.equal(aggregateAverages(aggregate).throughput, 20 / 11);
});

test('missing or unusable usage never becomes a zero sample', () => {
	const aggregate = emptyAggregate();
	addSample(aggregate, {model: 'a', durationMs: 1000, ttftMs: 50});
	addSample(aggregate, {model: 'a', outputTokens: 0, durationMs: 1000});
	addSample(aggregate, {model: 'a', outputTokens: 5, durationMs: 0});
	addSample(aggregate, {model: 'a', outputTokens: -5, durationMs: 1000});
	addSample(aggregate, {model: 'a', outputTokens: Number.NaN, durationMs: 1000});
	assert.equal(aggregate.requests, 5);
	assert.equal(aggregate.throughputSamples, 0);
	assert.equal(aggregate.outputTokens, 0);
	assert.equal(aggregateAverages(aggregate).throughput, undefined);
	assert.equal(aggregate.ttftSamples, 1);
});

test('per-model aggregates stay separate', () => {
	const aggregate = emptyAggregate();
	addSample(aggregate, {model: 'fast', outputTokens: 100, durationMs: 1000});
	addSample(aggregate, {model: 'slow', outputTokens: 10, durationMs: 1000});
	assert.equal(aggregateAverages(aggregate).throughput, 55);
	assert.equal(aggregateAverages(aggregate.models.fast).throughput, 100);
	assert.equal(aggregateAverages(aggregate.models.slow).throughput, 10);
	assert.equal(aggregateAverages(aggregate.models.slow).ttftMs, undefined);
});

test('mergeAggregate adds overall and per-model values', () => {
	const left = aggregateFromSample({model: 'a', outputTokens: 10, durationMs: 1000, ttftMs: 100});
	const right = aggregateFromSample({model: 'a', outputTokens: 20, durationMs: 2000, ttftMs: 300});
	mergeAggregate(right, aggregateFromSample({model: 'b', outputTokens: 30, durationMs: 3000}));
	mergeAggregate(left, right);
	assert.equal(left.requests, 3);
	assert.equal(left.outputTokens, 60);
	assert.equal(left.durationMs, 6000);
	assert.equal(left.ttftSamples, 2);
	assert.deepEqual(Object.keys(left.models).sort(), ['a', 'b']);
	assert.equal(left.models.a.requests, 2);
	assert.equal(left.models.b.requests, 1);
});

test('sanitizeAggregate rejects invalid values and model entries', () => {
	const sanitized = sanitizeAggregate({
		requests: 3,
		outputTokens: Number.POSITIVE_INFINITY,
		durationMs: -1,
		ttftMs: 40,
		ttftSamples: 1,
		models: {ok: {requests: 2, outputTokens: 10, durationMs: 2000}, bad: 'nope', '': {requests: 1}},
	});
	assert.equal(sanitized.requests, 3);
	assert.equal(sanitized.outputTokens, 0);
	assert.equal(sanitized.durationMs, 0);
	assert.equal(sanitized.ttftMs, 40);
	assert.deepEqual(Object.keys(sanitized.models), ['ok']);
	assert.equal(sanitized.models.ok.requests, 2);
	assert.equal(sanitizeAggregate(null).requests, 0);
});

test('liveRate uses the visible window and floors the early denominator', () => {
	const samples = [
		{t: 0, chars: 40},
		{t: 1000, chars: 40},
	];
	assert.equal(liveRate(samples, 1000, 0), 20);
	const stalled = liveRate(samples, 5000, 0);
	assert.equal(stalled, 0);
	const rolling = liveRate(
		[
			{t: 0, chars: 400},
			{t: 4500, chars: 40},
		],
		5000,
		0,
	);
	assert.equal(rolling, 5);
});

test('contentCharCount counts text and thinking but not tool input', () => {
	const content = [
		{type: 'thinking', thinking: 'abc'},
		{type: 'text', text: 'hello'},
		{type: 'tool_use', name: 'x', input: {a: 1}},
		{type: 'text', text: 42},
	];
	assert.equal(contentCharCount(content), 8);
	assert.equal(contentCharCount(undefined), 0);
});

test('endToEndRate guards missing and zero values', () => {
	assert.equal(endToEndRate(10, 1000), 10);
	assert.equal(endToEndRate(0, 1000), undefined);
	assert.equal(endToEndRate(10, 0), undefined);
	assert.equal(endToEndRate(undefined, 1000), undefined);
});

test('formatting is compact and stable', () => {
	assert.equal(formatRate(12.345), '12.3');
	assert.equal(formatRate(123.4), '123');
	assert.equal(formatRate(undefined), '—');
	assert.equal(formatDuration(480), '480ms');
	assert.equal(formatDuration(1240), '1.24s');
	assert.equal(formatDuration(12340), '12.3s');
	assert.equal(formatDuration(undefined), '—');
});

test('isEmptyAggregate tracks requests', () => {
	assert.equal(isEmptyAggregate(emptyAggregate()), true);
	const aggregate = emptyAggregate();
	addSample(aggregate, {model: 'a', ttftMs: 1});
	assert.equal(isEmptyAggregate(aggregate), false);
});
