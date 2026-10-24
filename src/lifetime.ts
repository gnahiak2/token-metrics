import {mkdir, open, readFile, rename, stat, unlink, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {
	emptyAggregate,
	mergeAggregate,
	sanitizeAggregate,
	type Aggregate,
} from './metrics.ts';

export interface LifetimeData {
	readonly version: 1;
	readonly since: string;
	readonly updatedAt: string;
	readonly overall: Aggregate;
}

export function emptyLifetime(now: Date = new Date()): LifetimeData {
	return {
		version: 1,
		since: now.toISOString(),
		updatedAt: now.toISOString(),
		overall: emptyAggregate(),
	};
}

function parseLifetime(raw: string): LifetimeData | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.version !== 1) return undefined;
	const since =
		typeof record.since === 'string' && Number.isFinite(Date.parse(record.since))
			? record.since
			: new Date().toISOString();
	const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : since;
	return {
		version: 1,
		since,
		updatedAt,
		overall: sanitizeAggregate(record.overall),
	};
}

export class LifetimeStore {
	private readonly file: string;
	private readonly notify: (message: string) => void;

	constructor(file: string, notify: (message: string) => void = () => {}) {
		this.file = file;
		this.notify = notify;
	}

	async load(): Promise<LifetimeData> {
		let raw: string;
		try {
			raw = await readFile(this.file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyLifetime();
			this.notify(`Token metrics could not read lifetime stats: ${describe(error)}`);
			return emptyLifetime();
		}
		const parsed = parseLifetime(raw);
		if (parsed) return parsed;
		const backup = `${this.file}.corrupt-${Date.now()}`;
		try {
			await rename(this.file, backup);
			this.notify(`Token metrics found invalid lifetime stats and moved them to ${backup}.`);
		} catch (error) {
			this.notify(`Token metrics found invalid lifetime stats and could not back them up: ${describe(error)}`);
		}
		return emptyLifetime();
	}

	async merge(delta: Aggregate): Promise<LifetimeData> {
		return this.withLock(async () => {
			const current = await this.load();
			mergeAggregate(current.overall, delta);
			const next: LifetimeData = {...current, updatedAt: new Date().toISOString()};
			await this.write(next);
			return next;
		});
	}

	async reset(): Promise<LifetimeData> {
		return this.withLock(async () => {
			const next = emptyLifetime();
			await this.write(next);
			return next;
		});
	}

	private async withLock<T>(run: () => Promise<T>): Promise<T> {
		await mkdir(dirname(this.file), {recursive: true});
		const lock = `${this.file}.lock`;
		const deadline = Date.now() + 4000;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		while (!handle) {
			try {
				handle = await open(lock, 'wx');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
				const age = await stat(lock)
					.then(info => Date.now() - info.mtimeMs)
					.catch(() => 0);
				if (age > 10000) {
					await unlink(lock).catch(() => {});
					continue;
				}
				if (Date.now() > deadline) throw new Error('timed out waiting for the lifetime stats lock');
				await new Promise(resolve => setTimeout(resolve, 25));
			}
		}
		try {
			return await run();
		} finally {
			await handle.close().catch(() => {});
			await unlink(lock).catch(() => {});
		}
	}

	private async write(data: LifetimeData): Promise<void> {
		await mkdir(dirname(this.file), {recursive: true});
		const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
		await rename(temporary, this.file);
	}
}

export function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
