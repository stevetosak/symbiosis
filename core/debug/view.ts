// What crosses between a debug session's supervisor and the ttt plugin, as
// files in the run's folder (runs/<id>/, core/run/runs.ts):
//
//   debug.json      DebugView: the supervisor writes it (atomically) at each change
//   debug-in.json   { cmds: DebugCommand[] }: the plugin writes it; the
//                   supervisor does each command whose seq it has not done,
//                   in order, and says the last one it did in DebugView.ack
//
// The plugin is the only writer of debug-in.json and keeps a command there
// until `ack` passes it, so a write that overwrites the last one loses
// nothing. Breakpoints are the plugin's too: breakpoints.json in the plugin
// folder, { files: { "<path>": [{ line, condition? }] } }, read when a session
// starts; while it runs, a `breakpoints` command sends a file's anew.

export type DebugStatus = 'starting' | 'running' | 'paused' | 'ended';

export interface FrameView {
	readonly id: number;
	readonly name: string;
	/** Absolute and real (symlinks resolved, as ttt names files); none for code with no file. */
	readonly path?: string;
	readonly line: number;
	readonly column: number;
	/** DAP's presentationHint: "subtle" for library frames, "label" for a separator. */
	readonly hint?: string;
}

export interface VarView {
	readonly name: string;
	readonly value: string;
	readonly type?: string;
	/** > 0: it has children, fetched when its key is expanded. */
	readonly ref: number;
	/** Its place in the tree: the scope's name, then each name down to it, "\t" between. */
	readonly key: string;
}

export interface ScopeView {
	readonly name: string;
	readonly ref: number;
	readonly expensive: boolean;
	readonly key: string;
}

export interface EvalView {
	readonly expr: string;
	readonly value: string;
	readonly type?: string;
	readonly ref: number;
	readonly key: string;
	readonly error?: boolean;
}

export interface BreakpointView {
	readonly line: number;
	readonly verified: boolean;
	readonly message?: string;
}

export interface StopView {
	/** DAP's reason: breakpoint, step, exception, pause, entry, ... */
	readonly reason: string;
	readonly description?: string;
	/** An exception's text. */
	readonly text?: string;
	readonly threadId: number;
}

export interface DebugView {
	/** Goes up with every write. */
	readonly seq: number;
	/** The seq of the last command done. */
	readonly ack: number;
	readonly status: DebugStatus;
	/** The spec's type (python, lldb, ...) and the adapter, for the panel's head. */
	readonly type: string;
	readonly adapter: string;
	readonly stop?: StopView;
	readonly threads: readonly { readonly id: number; readonly name: string }[];
	readonly frames: readonly FrameView[];
	/** The frame chosen (index in frames), whose scopes these are. */
	readonly frame: number;
	readonly scopes: readonly ScopeView[];
	/** The children fetched, by the key of their parent (a scope, a variable, an evaluation). */
	readonly vars: Readonly<Record<string, readonly VarView[]>>;
	readonly expanded: readonly string[];
	readonly breakpoints: Readonly<Record<string, readonly BreakpointView[]>>;
	/** The newest first. */
	readonly evals: readonly EvalView[];
	/** The last command that failed, and why. */
	readonly error?: string;
}

export type DebugCommand =
	| { readonly seq: number; readonly op: 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause' }
	| { readonly seq: number; readonly op: 'frame'; readonly index: number }
	| { readonly seq: number; readonly op: 'expand' | 'collapse'; readonly key: string }
	| { readonly seq: number; readonly op: 'breakpoints'; readonly path: string; readonly lines: readonly BreakpointSpec[] }
	/** evaluate: a watch, evaluated now and at each stop; unwatch drops it. */
	| { readonly seq: number; readonly op: 'evaluate' | 'unwatch'; readonly expr: string };

export interface BreakpointSpec {
	readonly line: number;
	readonly condition?: string;
}

/** breakpoints.json → path → its breakpoints; a bad file is no breakpoints. */
export function parseBreakpoints(raw: unknown): Map<string, BreakpointSpec[]> {
	const out = new Map<string, BreakpointSpec[]>();
	const files = (raw as { files?: unknown })?.files;
	if (typeof files !== 'object' || files === null) return out;
	for (const [path, list] of Object.entries(files)) {
		if (!path.startsWith('/') || !Array.isArray(list)) continue;
		const lines: BreakpointSpec[] = [];
		for (const b of list) {
			const line = (b as { line?: unknown })?.line;
			if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) continue;
			const condition = (b as { condition?: unknown }).condition;
			lines.push({ line, ...(typeof condition === 'string' && condition.trim() ? { condition } : {}) });
		}
		if (lines.length > 0) out.set(path, lines);
	}
	return out;
}

/** debug-in.json → its commands, in seq order; what is not a command is skipped. */
export function parseCommands(raw: unknown): DebugCommand[] {
	const cmds = (raw as { cmds?: unknown })?.cmds;
	if (!Array.isArray(cmds)) return [];
	return cmds
		.filter((c): c is DebugCommand => typeof c === 'object' && c !== null && typeof c.seq === 'number' && typeof c.op === 'string')
		.sort((a, b) => a.seq - b.seq);
}
