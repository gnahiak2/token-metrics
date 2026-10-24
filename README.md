# Token metrics

A Command Code mod that shows throughput and latency while the agent works:

- **live tokens/second** — an estimate (`~`) from streamed characters, refreshed while a request runs
- **time to first token (TTFT)** — request start to the first observable generated content (text, reasoning, or a tool call)
- **last request** — provider-reported output tokens over request wall time, including TTFT
- **session and lifetime averages** — token-weighted throughput and mean TTFT

The widget sits above the prompt. `/token-stats` prints the full report, including per-model breakdowns.

## Install

```bash
cmd mods add gnahiak2/token-metrics
```

Or copy this folder to `~/.commandcode/mods/token-metrics/` and let the user-mod scan pick it up. Send `/reload` after changing the source.

## Usage

```text
/token-stats                    full report
/token-stats reset session      clear this session, keep lifetime
/token-stats reset all          clear both (asks for confirmation)
```

Send `/reload` after editing the mod.

## Definitions

- **TTFT**: `model_request_start` to the first non-empty text delta, thinking delta, thinking end, tool call, or non-empty `message_update` content. It measures the delivered response; if a dropped stream is retried, the abandoned attempt's content is discarded and TTFT includes the retry wait.
- **End-to-end rate**: `usage.outputTokens / (request end - request start)`. This includes TTFT and any provider retry delay. It is not decode-only speed.
- **Averages**: weighted, `sum(outputTokens) / sum(duration)`, not the mean of per-request rates. TTFT averages use only requests where a first token was observed. Requests without reported usage still count as requests but are excluded from rate averages.
- **Live estimate**: visible characters / 4, over a rolling 2-second window, with a 500ms floor at the start. Tool-call JSON counts once per call. Reasoning text counts when it streams. This is approximate and will not match billed output tokens, especially when providers include hidden reasoning.
- **Scope**: top-level model requests of the main event stream. Nested sub-agent runs and provider-internal retries are not separately timed.

## Persistence

Session statistics live in Command Code's per-session mod state and survive a hot reload. Lifetime statistics are stored at `~/.commandcode/mods/.store/token-metrics/lifetime.json` with only model names, token counts, durations, and TTFT sums — no prompts or output. Writes use a lock plus atomic rename so concurrent sessions merge rather than overwrite. Invalid files are renamed to `*.corrupt-<timestamp>` before starting fresh.

A hard crash can leave a stale `.lock`; it is removed automatically after 10 seconds.

## Development

```bash
npm test
cmd --mod ~/.commandcode/mods/token-metrics/index.ts
cmd mods list
```

The metrics and tracker modules have no Command Code dependency, so they are testable with Node's built-in test runner.
