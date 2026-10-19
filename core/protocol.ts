// The protocol between the agent side and the editor side: every message that
// crosses the channel, as types. No logic and no I/O, so any agent adapter
// and any channel implementation can share it. See docs/design.md.

import type { Landed } from './review.ts';

/** The channel protocol. The plugin flags a session with another one: "/reload". */
export const PROTOCOL = 16;

/** The tools whose calls the editor lists. */
export type Tool = 'write' | 'edit';

export type ChannelEvent =
	/** A write or edit call is about to run (the guard let it through). */
	| { op: 'start'; call: string; tool: Tool; path: string }
	/** The tool ran. `line` is the first changed line; `why` is the agent's reason for a choice that is not obvious. */
	| { op: 'done'; call: string; tool: Tool; path: string; line: number; ok: boolean; why?: string }
	/** The agent's turn ended; `path` and `line` are its last change. */
	| { op: 'stop'; path: string; line: number }
	/** helpi!: session `session` got the question `id` and asks its model. */
	| { op: 'help'; id: string; session: string }
	/** The answer starts: its kind, and for code the imports the file needs. */
	| { op: 'help_start'; id: string; kind: HelpKind; imports: string[] }
	/** The answer so far, all of it (not a delta). */
	| { op: 'help_text'; id: string; text: string }
	/** The answer is complete (`text`), stopped (Esc), or failed (`error`). */
	| { op: 'help_done'; id: string; text: string; error?: string; stopped?: boolean }
	/** ask (ctrl+k d, why!): session `session` got the question `id` and asks its model. */
	| { op: 'ask'; id: string; session: string }
	/** The answer so far, all of it: the lines to read, without the links and terms. */
	| { op: 'ask_text'; id: string; text: string }
	/** The answer is complete, stopped (Esc), or failed (`error`). */
	| { op: 'ask_done'; id: string; text: string; links: Link[]; terms: string[]; error?: string; stopped?: boolean }
	/** The agent asks for a change the guard blocks; the editor answers in answer.json. */
	| ({ op: 'propose' } & Proposal)
	/** Proposal `id` needs no answer any more (answered, or the turn stopped). */
	| { op: 'propose_end'; id: string }
	/** Something for the developer to read, from the agent side. */
	| { op: 'notice'; text: string; level: 'info' | 'warn' | 'error' };

/** What the editor tells the agent side about itself. */
export interface PluginState {
	alive: boolean;
	/** The session the editor follows, if any. */
	owner?: string;
	/** How far the guard lets a fill reach (core/guard.ts). */
	scope: Scope;
}

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
	/** What this session fills, if any: the guard holds its edits to it. `name`: the function's, or the description's start. */
	fill: { kind: 'stub' | 'place'; path: string; name: string; line: number } | null;
	/** Bodies the agent filled that the developer has not acked (core/review.ts), the newest last. */
	review: Landed[];
}

/** ctrl+k q in ttt: stop the turn of session `to`. */
export interface StopRequest {
	id: string;
	to: string;
}

/** `symbiosis close`: session `to` quits (`ctx.shutdown()`); `id` is new for each request. */
export interface CloseRequest {
	id: string;
	to: string;
}

/** `function`: write a new function under the comment, in the session (a fill, core/place.ts). */
export type HelpKind = 'note' | 'code' | 'ask' | 'function';

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

/** A link in an answer. `file`: `target` is `path:line` in the project; `url`: it comes from the model and is not checked. */
export interface Link {
	title: string;
	target: string;
	kind: 'file' | 'url';
}

/** The code an `ask` is about: the selection, or the line. */
export interface AskTarget {
	/** 1-based lines. */
	startLine: number;
	endLine: number;
	/** The code, as in the buffer. */
	text: string;
}

/** ask: the developer asks about code. The code around it comes as in the buffer (it may not be saved). */
export interface AskRequest {
	id: string;
	/** The session that answers. */
	to: string;
	path: string;
	language: string;
	/** Their own question, or "" (then: explain this code). */
	question: string;
	target: AskTarget;
	/** The symbol under the cursor, when nothing is selected. */
	word: string;
	/** The whole file, or "" when it is too big: then `window` holds the lines around the target. */
	text: string;
	window: { first: number; text: string };
	/**
	 * The folder where the editor will keep this answer as a note, or "". ttt's fs cannot make a folder, so pi
	 * makes it (only a folder under `.symbiosis/notes`).
	 */
	notesDir: string;
	/** A drill-down: the question this one grew from, with its answer. */
	parent?: { question: string; answer: string };
	/** Ask for a deeper answer to the same question (`+`). */
	deeper: boolean;
	/** You pressed Esc: stop the answer with this id. */
	cancel: boolean;
}

/** The stub guard's reach. `stub`: only the body. `file`: also new private declarations in its file. `off`: no guard. */
export type Scope = 'stub' | 'file' | 'off';
export const SCOPES: readonly Scope[] = ['stub', 'file', 'off'];

/** What the agent may `propose`; each is also the kind of a violation. */
export type ProposeKind = 'new_file' | 'new_decl' | 'signature' | 'dependency' | 'outside_edit';
export const PROPOSE_KINDS: readonly ProposeKind[] = ['new_file', 'new_decl', 'signature', 'dependency', 'outside_edit'];

/** What a fill works on: the stub that holds a line, or a new function under the description that ends at it. */
export type FillMode = 'stub' | 'function';
export const FILL_MODES: readonly FillMode[] = ['stub', 'function'];

/** helpi! or the palette: fill at `line` of `path` (saved first), or end the fill. */
export type FillRequest = { id: string; to: string } & ({ release: false; mode: FillMode; path: string; line: number } | { release: true });

/** A change the agent asks for while it fills a stub. */
export interface Proposal {
	id: string;
	session: string;
	kind: ProposeKind;
	/** What the guard names: a path, an import, a declaration's name, the stub's name. */
	target: string;
	what: string;
	why: string;
}

/** The developer's answer to proposal `id`, with an optional one-line note. */
export interface ProposalAnswer {
	id: string;
	accept: boolean;
	note: string;
}
