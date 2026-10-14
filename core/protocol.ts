// The protocol between the agent side and the editor side: every message that
// crosses the channel, as types. No logic and no I/O, so any agent adapter
// and any channel implementation can share it. See docs/design.md.

/** The channel protocol. The plugin flags a session with another one: "/reload". */
export const PROTOCOL = 10;

/** The tools whose calls stream into the editor. */
export type Tool = 'write' | 'edit';

export type ChannelEvent =
	/**
	 * A call starts streaming. `sum` is the Adler-32 of the file on disk, null
	 * when it does not exist. `before` is that text, when it is not too big:
	 * the editor may replay this call after pi has changed the file again, so
	 * it shows the change from this text.
	 */
	| { op: 'start'; call: string; tool: Tool; path: string; sum: number | null; before?: string }
	/** `key` is `content`, `edits.<i>.old` (sent once, complete) or `edits.<i>.new`. `from` counts UTF-8 bytes. */
	| { op: 'text'; call: string; key: string; from: number; text: string }
	/** The tool is about to run: the arguments are complete. The plugin acknowledges once it has shown them. */
	| { op: 'ready'; call: string }
	/** The call will not run (the turn ended without it): undo the preview. */
	| { op: 'abort'; call: string }
	/** The tool ran. `line` is the first changed line; `sum` is the Adler-32 of the file now. */
	| { op: 'done'; call: string; tool: Tool; path: string; line: number; ok: boolean; sum: number | null }
	/** The agent's turn ended; the editor goes to the last edit even when pinned. */
	| { op: 'stop'; path: string; line: number }
	/** helpi!: session `session` got the question `id` and asks its model. */
	| { op: 'help'; id: string; session: string }
	/** The answer starts: its kind, and for code the imports the file needs. */
	| { op: 'help_start'; id: string; kind: HelpKind; imports: string[] }
	/** The answer so far, all of it (not a delta). */
	| { op: 'help_text'; id: string; text: string }
	/** The answer is complete (`text`), stopped (Esc), or failed (`error`). */
	| { op: 'help_done'; id: string; text: string; error?: string; stopped?: boolean };

/** What the editor tells the agent side about itself. */
export interface PluginState {
	alive: boolean;
	pinned: boolean;
	/** The session the editor follows, if any. */
	owner?: string;
	/** How many changes pi may make that the editor has not shown yet; -1 = no limit. */
	lag: number;
}

/** The lag limit before the operator sets one. */
export const DEFAULT_LAG = 3;

export type StepState = 'done' | 'now' | 'next';

/** One step of pi's plan, shown in the editor as a timeline. */
export interface Step {
	text: string;
	state: StepState;
}

/** What a pi session tells the plugin about itself. Times are Unix seconds. */
export interface Session {
	id: string;
	/** The channel protocol of this extension; the plugin flags an older one. */
	version: number;
	/** The pane of this pi, when it runs in herdr or tmux: ctrl+k g goes there. */
	pane: string | null;
	/** Which multiplexer `pane` belongs to. */
	host: 'herdr' | 'tmux' | null;
	/** The model, for the ctrl+k h panel. */
	model: string | null;
	/** The title of the dialog pi waits on (a guard's "Allow?"), else null. */
	waiting: string | null;
	cwd: string;
	name: string;
	pid: number;
	/** Heartbeat. */
	t: number;
	/** When the agent last started work. */
	active: number;
	working: boolean;
	/** pi's plan, shown as the timeline. Empty when pi has not sent one. */
	plan: Step[];
	/** The files this session wrote or edited, the last one last. The editor
	 * follows the session that wrote the open file. */
	files: string[];
	/** pi's session name (`/name`), to tell sessions in one folder apart. */
	title: string | null;
}

/** ctrl+k q in ttt: stop the turn of session `to`. */
export interface StopRequest {
	id: string;
	to: string;
}

export type HelpKind = 'note' | 'code' | 'ask';

/** helpi!: the question and the code around it, as in the buffer (it may not be saved). */
export interface HelpRequest {
	id: string;
	/** The session that answers. */
	to: string;
	path: string;
	/** The line of the question, 1-based. */
	line: number;
	/** The question's whole line, as in the buffer. */
	question: string;
	language: string;
	/** The top of a long file (its imports), or "" when `window` is the whole file. */
	head: string;
	/** The lines around the question, from line `first`. */
	window: { first: number; text: string };
	/** You pressed Esc: stop the answer with this id. */
	cancel: boolean;
}
