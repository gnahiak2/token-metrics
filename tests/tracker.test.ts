import assert from 'node:assert/strict';
import test from 'node:test';
import {aggregateAverages, safeJsonLength, type Sample} from './src/metrics.ts';
import {TokenTracker} from './src/tracker.ts';

function clockedTracker() {
	let now = 0;
	const samples: Sample[] = [];
	const tracker = new TokenTracker({
		now: () => now,
		onSample: sample => samples.push(sample),
	});
	return {
		tracker,
		samples,
		advance: (ms: number) => {
			now += ms;
			return now;
		},
		set: (value: number) => {
			now = value;
			return now;
		},
	};
}

test('TTFT is measured to the first generated content and the request sample is finalized once', () => {
	const {tracker, samples, set, advance} = clockedTracker();
	set(1000);
	tracker.modelStart('model-a');
	assert.equal(tracker.live()?.ttftMs, undefined);
	advance(300);
	tracker.recordDelta('aaaa');
	advance(1000);
	const live = tracker.live();
	assert.equal(live?.ttftMs, 300);
	assert.equal(live?.rate, 1);
	assert.equal(tracker.isActive(), true);
	tracker.finish('model-a', {outputTokens: 10, inputTokens: 5});
	assert.equal(tracker.isActive(), false);
	assert.equal(samples.length, 1);
	assert.equal(samples[0].durationMs, 1300);
	assert.equal(samples[0].ttftMs, 300);
	assert.equal(samples[0].outputTokens, 10);
	assert.equal(tracker.session.requests, 1);
	assert.equal(tracker.last()?.rate, 10 / 1.3);
	tracker.finish('model-a', {outputTokens: 10});
	assert.equal(samples.length, 1);
	assert.equal(tracker.session.requests, 1);
});

test('text deltas are never counted as token counts', () => {
	const {tracker, set, advance} = clockedTracker();
	set(0);
	tracker.modelStart('m');
	advance(100);
	tracker.recordDelta('这是一个很长的文本块');
	advance(900);
	const live = tracker.live();
	assert.equal(live?.chars, '这是一个很长的文本块'.length);
	assert.equal(live?.rate, '这是一个很长的文本块'.length / 4 / 0.9);
});

test('thinking deltas count once and an empty thinking end does not start the clock', () => {
	const {tracker, set, advance} = clockedTracker();
	set(0);
	tracker.modelStart('m');
	advance(200);
	tracker.markFirstContent();
	tracker.markFirstContent();
	assert.equal(tracker.live()?.ttftMs, 200);
	advance(200);
	tracker.recordDelta('thinking text');
	assert.equal(tracker.live()?.chars, 'thinking text'.length);
});

test('message_update is a fallback when no stream deltas arrive', () => {
	const {tracker, set, advance} = clockedTracker();
	set(0);
	tracker.modelStart('m');
	advance(100);
	tracker.noteContent([{type: 'text', text: 'x'.repeat(40)}]);
	assert.equal(tracker.live()?.ttftMs, 100);
	advance(100);
	tracker.noteContent([{type: 'text', text: 'x'.repeat(80)}]);
	assert.equal(tracker.live()?.chars, 80);
	assert.equal(tracker.live()?.rate, 80 / 4 / 0.5);
	tracker.recordDelta('x');
	assert.equal(tracker.live()?.chars, 81);
	tracker.noteContent([{type: 'text', text: 'x'.repeat(200)}]);
	assert.equal(tracker.live()?.chars, 81);
});

test('a discarded stream restart resets estimates but keeps request latency', () => {
	const {tracker, set, advance} = clockedTracker();
	set(0);
	tracker.modelStart('m');
	advance(100);
	tracker.recordDelta('a'.repeat(100));
	assert.equal(tracker.live()?.ttftMs, 100);
	advance(100);
	tracker.streamRestart(true);
	assert.equal(tracker.live()?.chars, 0);
	assert.equal(tracker.live()?.ttftMs, undefined);
	advance(200);
	tracker.recordDelta('b'.repeat(20));
	assert.equal(tracker.live()?.ttftMs, 400);
	advance(100);
	tracker.finish('m', {outputTokens: 5});
	assert.equal(tracker.last()?.durationMs, 500);
	assert.equal(tracker.last()?.ttftMs, 400);
});

test('a restart without discarded content keeps live data', () => {
	const {tracker, set, advance} = clockedTracker();
	set(0);
	tracker.modelStart('m');
	advance(100);
	tracker.recordDelta('abcd');
	advance(100);
	tracker.streamRestart(false);
	assert.equal(tracker.live()?.chars, 4);
	assert.equal(tracker.live()?.ttftMs, 100);
});

test('tool queued content is counted once per tool call', () => {
	const {tracker, set, advance} = clockedTracker();
	set(0);
	tracker.modelStart('m');
	advance(50);
	const input = {command: 'ls'};
	tracker.toolQueued('call-1', input);
	tracker.toolQueued('call-1', input);
	assert.equal(tracker.live()?.chars, safeJsonLength(input));
	assert.equal(tracker.live()?.ttftMs, 50);
	tracker.toolQueued('call-2', input);
	assert.equal(tracker.live()?.chars, safeJsonLength(input) * 2);
});

test('aborted and superseded requests never reach session averages', () => {
	const {tracker, samples, set} = clockedTracker();
	set(0);
	tracker.modelStart('first');
	set(100);
	tracker.modelStart('second');
	set(200);
	tracker.abort();
	assert.equal(tracker.session.requests, 0);
	assert.equal(samples.length, 0);
	assert.equal(tracker.live(), undefined);
	assert.equal(tracker.last(), undefined);
});

test('requests without reported output still count TTFT but not throughput', () => {
	const {tracker, set, advance} = clockedTracker();
	set(0);
	tracker.modelStart('m');
	advance(100);
	tracker.recordDelta('abcd');
	advance(900);
	tracker.finish('m', undefined);
	assert.equal(tracker.session.requests, 1);
	assert.equal(tracker.session.throughputSamples, 0);
	assert.equal(tracker.session.ttftSamples, 1);
	assert.equal(tracker.last()?.rate, undefined);
	assert.equal(tracker.last()?.outputTokens, undefined);
});

test('per-model session aggregates accumulate independently', () => {
	const {tracker, set, advance} = clockedTracker();
	for (const [model, tokens] of [
		['fast', 100],
		['fast', 100],
		['slow', 10],
	] as const) {
		tracker.modelStart(model);
		advance(100);
		tracker.recordDelta('abcd');
		advance(900);
		tracker.finish(model, {outputTokens: tokens});
	}
	set(3000);
	const fast = aggregateAverages(tracker.session.models.fast);
	const slow = aggregateAverages(tracker.session.models.slow);
	assert.equal(fast.throughput, 100);
	assert.equal(slow.throughput, 10);
	assert.equal(tracker.session.models.fast.requests, 2);
});

test('session hydration, restore, and reset sanitize their inputs', () => {
	const {tracker} = clockedTracker();
	tracker.hydrateSession({requests: 4, outputTokens: 40, durationMs: 4000, models: {m: {requests: 4}}});
	assert.equal(tracker.session.requests, 4);
	assert.equal(tracker.session.models.m.requests, 4);
	tracker.restoreLast({model: 'm', durationMs: 1000, outputTokens: 10, rate: 10, ttftMs: 100});
	assert.equal(tracker.last()?.rate, 10);
	tracker.restoreLast({model: 'm', durationMs: Number.NaN});
	tracker.resetSession();
	assert.equal(tracker.session.requests, 0);
	assert.deepEqual(tracker.session.models, {});
	assert.equal(tracker.last(), undefined);
});
