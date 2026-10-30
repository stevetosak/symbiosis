// A Debug Adapter Protocol client: the wire format (a Content-Length header,
// then a JSON message), requests with their responses, events, and the
// requests an adapter sends back (runInTerminal, startDebugging).
//
// Why not a library: @vscode/debugadapter-testsupport is built for mocha
// (its helpers assert) and answers no reverse request; node-debugprotocol-client
// has not changed since 2022. The protocol's own types are
// @vscode/debugprotocol's, the official ones (types only, nothing at run time).
import type { Readable, Writable } from 'node:stream';
import type { DebugProtocol as P } from '@vscode/debugprotocol';

export type { P as DebugProtocol };

const HEADER_END = Buffer.from('\r\n\r\n');

/** Splits a byte stream into DAP messages. Feed it chunks; it calls `message` for each. */
export class Framer {
	private buf = Buffer.alloc(0);
	private length = -1;
	private readonly message: (text: string) => void;

	constructor(message: (text: string) => void) {
		this.message = message;
	}

	push(chunk: Buffer): void {
		this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
		for (;;) {
			if (this.length < 0) {
				const end = this.buf.indexOf(HEADER_END);
				if (end < 0) return;
				const header = this.buf.subarray(0, end).toString('ascii');
				const m = /Content-Length:\s*(\d+)/i.exec(header);
				this.buf = this.buf.subarray(end + HEADER_END.length);
				// A header with no length: skip it, as VS Code does.
				if (!m) continue;
				this.length = Number(m[1]);
			}
			if (this.buf.length < this.length) return;
			const body = this.buf.subarray(0, this.length).toString('utf8');
			this.buf = this.buf.subarray(this.length);
			this.length = -1;
			this.message(body);
		}
	}
}

export function frame(message: object): string {
	const json = JSON.stringify(message);
	return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

export class DapError extends Error {
	readonly command: string;

	constructor(message: string, command: string) {
		super(message);
		this.command = command;
	}
}

type Pending = { command: string; done: (r: P.Response) => void; timer?: NodeJS.Timeout };
type EventHandler = (body: any, event: P.Event) => void;
type RequestHandler = (args: any) => Promise<unknown> | unknown;

export class DapClient {
	private seq = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly handlers = new Map<string, EventHandler[]>();
	private readonly reverse = new Map<string, RequestHandler>();
	private closed: string | undefined;
	private readonly closers: ((why: string) => void)[] = [];
	private readonly out: Writable;
	private readonly log?: (dir: '>' | '<', text: string) => void;

	/** `log`: each message in and out, for the run's debug log. */
	constructor(out: Writable, input: Readable, log?: (dir: '>' | '<', text: string) => void) {
		this.out = out;
		this.log = log;
		const framer = new Framer((text) => this.receive(text));
		input.on('data', (chunk: Buffer) => framer.push(chunk));
		input.on('close', () => this.close('the debug adapter closed the connection'));
		input.on('error', (e) => this.close(`the debug adapter's connection failed: ${e.message}`));
		out.on('error', (e) => this.close(`the debug adapter's connection failed: ${e.message}`));
	}

	/** Sends a request; resolves with the response's body, rejects with its message. */
	request<T = any>(command: string, args?: unknown, timeoutMs = 0): Promise<T> {
		if (this.closed) return Promise.reject(new DapError(this.closed, command));
		const seq = this.seq++;
		return new Promise<T>((resolve, reject) => {
			const p: Pending = {
				command,
				done: (r) => (r.success ? resolve(r.body as T) : reject(new DapError(r.message || `${command} failed`, command))),
			};
			if (timeoutMs > 0) {
				p.timer = setTimeout(() => {
					this.pending.delete(seq);
					reject(new DapError(`${command}: no answer in ${timeoutMs / 1000} s`, command));
				}, timeoutMs);
			}
			this.pending.set(seq, p);
			this.send({ seq, type: 'request', command, ...(args === undefined ? {} : { arguments: args }) });
		});
	}

	/** An event's handler; returns a function that removes it. */
	on(event: string, handler: EventHandler): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => {
			const at = list.indexOf(handler);
			if (at >= 0) list.splice(at, 1);
		};
	}

	/** The next `event` for which `test` holds; rejects after `timeoutMs` or when the connection closes. */
	once(event: string, timeoutMs: number, test: (body: any) => boolean = () => true): Promise<any> {
		return new Promise((resolve, reject) => {
			const off = this.on(event, (body) => {
				if (!test(body)) return;
				finish();
				resolve(body);
			});
			const closer = (why: string) => {
				finish();
				reject(new DapError(why, event));
			};
			const timer = setTimeout(() => {
				finish();
				reject(new DapError(`no ${event} event in ${timeoutMs / 1000} s`, event));
			}, timeoutMs);
			const finish = () => {
				off();
				clearTimeout(timer);
				const at = this.closers.indexOf(closer);
				if (at >= 0) this.closers.splice(at, 1);
			};
			if (this.closed) return closer(this.closed);
			this.closers.push(closer);
		});
	}

	/** Answers the adapter's own requests of `command` (runInTerminal, startDebugging). */
	handle(command: string, handler: RequestHandler): void {
		this.reverse.set(command, handler);
	}

	onClose(fn: (why: string) => void): void {
		if (this.closed) fn(this.closed);
		else this.closers.push(fn);
	}

	get isClosed(): boolean {
		return this.closed !== undefined;
	}

	close(why = 'closed'): void {
		if (this.closed) return;
		this.closed = why;
		for (const [, p] of this.pending) {
			if (p.timer) clearTimeout(p.timer);
			p.done({ seq: 0, type: 'response', request_seq: 0, command: p.command, success: false, message: why });
		}
		this.pending.clear();
		for (const fn of this.closers.splice(0)) fn(why);
	}

	private send(message: object): void {
		const text = frame(message);
		this.log?.('>', JSON.stringify(message));
		try {
			this.out.write(text);
		} catch (e) {
			this.close(`the debug adapter's connection failed: ${(e as Error).message}`);
		}
	}

	private receive(text: string): void {
		this.log?.('<', text);
		let message: P.ProtocolMessage;
		try {
			message = JSON.parse(text);
		} catch {
			return;
		}
		if (message.type === 'response') {
			const r = message as P.Response;
			const p = this.pending.get(r.request_seq);
			if (!p) return;
			this.pending.delete(r.request_seq);
			if (p.timer) clearTimeout(p.timer);
			p.done(r);
		} else if (message.type === 'event') {
			const e = message as P.Event;
			for (const h of [...(this.handlers.get(e.event) ?? [])]) {
				try {
					h(e.body ?? {}, e);
				} catch {
					// one handler's failure is not the connection's
				}
			}
		} else if (message.type === 'request') {
			void this.answer(message as P.Request);
		}
	}

	private async answer(req: P.Request): Promise<void> {
		const handler = this.reverse.get(req.command);
		const base = { seq: this.seq++, type: 'response', request_seq: req.seq, command: req.command };
		if (!handler) {
			this.send({ ...base, success: false, message: `symbiosis does not support ${req.command}` });
			return;
		}
		try {
			const body = await handler(req.arguments ?? {});
			this.send({ ...base, success: true, ...(body === undefined ? {} : { body }) });
		} catch (e) {
			this.send({ ...base, success: false, message: (e as Error).message });
		}
	}
}
