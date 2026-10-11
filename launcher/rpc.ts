// A small client of pi's RPC mode (`pi --mode rpc`): JSON records, one per
// line, on pi's stdin and stdout. pi's own RpcClient cannot answer extension
// dialogs, and the launcher must (a guard asking "Allow?" would hang pi).
//
// Framing: split on LF only. Node's readline also splits on U+2028 and
// U+2029, which are valid inside JSON strings (pi docs, rpc.md).
import { type ChildProcess, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export type Json = Record<string, unknown>;

/** Splits `text` into whole records; `rest` is the part after the last LF. */
export function splitRecords(text: string): { records: string[]; rest: string } {
	const parts = text.split('\n');
	const rest = parts.pop() ?? '';
	return { records: parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p)).filter((p) => p !== ''), rest };
}

export interface Response {
	id?: string;
	type: 'response';
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export class RpcError extends Error {}

export interface Exit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

export class RpcPi {
	readonly child: ChildProcess;
	/** Resolves when pi exits, for any reason. */
	readonly exited: Promise<Exit>;
	/** Every record that is not a response: session events and extension_ui_request. */
	onRecord: (record: Json) => void = () => {};
	private readonly pending = new Map<string, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
	private next = 0;
	private rest = '';
	private gone = false;

	constructor(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; stderr: number | 'ignore' | 'inherit' }) {
		this.child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', options.stderr] });
		const decoder = new StringDecoder('utf8');
		this.child.stdout!.on('data', (chunk: Buffer) => this.read(decoder.write(chunk)));
		// Writing to a pi that already exited: the exit is reported, not this.
		this.child.stdin!.on('error', () => {});
		this.exited = new Promise((resolve) => {
			this.child.on('error', (error) => {
				this.end(new RpcError(`could not start ${command}: ${error.message}`));
				resolve({ code: 127, signal: null });
			});
			this.child.on('exit', (code, signal) => {
				this.end(new RpcError(`pi exited (${signal ?? `code ${code}`})`));
				resolve({ code, signal });
			});
		});
	}

	/** Sends a command and waits for its response. Rejects when pi says no or exits. */
	request(command: Json, timeoutMs = 0): Promise<Response> {
		const id = `s${++this.next}`;
		return new Promise((resolve, reject) => {
			if (this.gone) {
				reject(new RpcError('pi is not running'));
				return;
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new RpcError(`pi did not answer ${String(command.type)} in ${timeoutMs / 1000} s`));
				}, timeoutMs);
			}
			this.pending.set(id, {
				resolve: (r) => {
					clearTimeout(timer);
					if (r.success) resolve(r);
					else reject(new RpcError(r.error ?? `${r.command} failed`));
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.send({ ...command, id });
		});
	}

	/** Sends a record with no response (an extension_ui_response). */
	send(record: Json): void {
		if (this.gone) return;
		this.child.stdin!.write(`${JSON.stringify(record)}\n`);
	}

	/**
	 * Closes pi's stdin: pi saves the session and exits. After `graceMs` it
	 * gets SIGTERM, and after as long again SIGKILL.
	 */
	async close(graceMs = 5000): Promise<Exit> {
		this.child.stdin!.end();
		const kill = (signal: NodeJS.Signals) => {
			if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
		};
		const term = setTimeout(() => kill('SIGTERM'), graceMs);
		const hard = setTimeout(() => kill('SIGKILL'), graceMs * 2);
		const exit = await this.exited;
		clearTimeout(term);
		clearTimeout(hard);
		return exit;
	}

	private read(text: string): void {
		const { records, rest } = splitRecords(this.rest + text);
		this.rest = rest;
		for (const line of records) {
			let record: Json;
			try {
				record = JSON.parse(line) as Json;
			} catch {
				continue; // stdout is protocol only; a broken line is pi's fault, not ours to stop on.
			}
			if (record.type === 'response' && typeof record.id === 'string' && this.pending.has(record.id)) {
				const waiting = this.pending.get(record.id)!;
				this.pending.delete(record.id);
				waiting.resolve(record as unknown as Response);
			} else {
				this.onRecord(record);
			}
		}
	}

	private end(error: Error): void {
		this.gone = true;
		for (const waiting of this.pending.values()) waiting.reject(error);
		this.pending.clear();
	}
}
