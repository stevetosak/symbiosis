export type TranscriptEvent = { kind: 'result'; call: string; rejected: boolean } | { kind: 'interrupted' };

const INTERRUPTED = '[Request interrupted by user';
const REJECTED = "The user doesn't want to proceed";

function textOf(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content.map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : '')).join('');
}

export function transcriptEvents(line: string): TranscriptEvent[] {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return [];
	}
	if (!entry || typeof entry !== 'object') return [];
	const e = entry as { type?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
	if (e.type !== 'user' || e.isSidechain === true) return [];
	const content = e.message?.content;
	if (typeof content === 'string') return content.startsWith(INTERRUPTED) ? [{ kind: 'interrupted' }] : [];
	if (!Array.isArray(content)) return [];
	const events: TranscriptEvent[] = [];
	for (const block of content) {
		if (!block || typeof block !== 'object') continue;
		if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
			events.push({ kind: 'result', call: block.tool_use_id, rejected: block.is_error === true && textOf(block.content).startsWith(REJECTED) });
		} else if (block.type === 'text' && typeof block.text === 'string' && block.text.startsWith(INTERRUPTED)) {
			events.push({ kind: 'interrupted' });
		}
	}
	return events;
}

export class TranscriptReader {
	readonly path: string;
	private offset: number;
	private rest = Buffer.alloc(0);

	constructor(path: string, offset: number) {
		this.path = path;
		this.offset = offset;
	}

	take(read: (path: string, offset: number) => Buffer | undefined): TranscriptEvent[] {
		const chunk = read(this.path, this.offset);
		if (!chunk || chunk.length === 0) return [];
		this.offset += chunk.length;
		const all = Buffer.concat([this.rest, chunk]);
		const end = all.lastIndexOf(0x0a);
		if (end < 0) {
			this.rest = all;
			return [];
		}
		this.rest = all.subarray(end + 1);
		return all
			.subarray(0, end)
			.toString('utf-8')
			.split('\n')
			.flatMap((line) => transcriptEvents(line));
	}
}
