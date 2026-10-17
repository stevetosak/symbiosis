// The channel between the agent side and the editor side, as an interface.
// The agent side writes events and its session record, and reads what the
// editor asks for. Today the only implementation is files in the plugin
// folder (./file.ts), because a ttt plugin cannot open a socket. A socket or
// pipe implementation goes behind this same interface.
import type { ReviewRequest } from '../review.ts';
import type { AskRequest, ChannelEvent, FillRequest, HelpRequest, PluginState, ProposalAnswer, Session, StopRequest } from '../protocol.ts';

export interface Channel {
	/** False when the editor side is not installed: then the agent side sends nothing. */
	enabled(): boolean;

	/** At the start of a turn: the channel may drop what the editor has read. */
	rotate(): void;

	/** Sends events to the editor, in order. */
	emit(...events: ChannelEvent[]): void;

	/** The editor's last known state. */
	plugin(): PluginState;

	/** Publishes this session's record: the heartbeat the editor reads. */
	writeSession(session: Session): void;

	removeSession(id: string): void;

	/** Removes the records of sessions that stopped without saying so (a crash, a kill). */
	pruneSessions(maxAgeSeconds?: number): void;

	/** The calls of `calls` that the editor has not shown yet. */
	unshown(calls: string[]): string[];

	/**
	 * Waits until at most `limit` of `calls` are not shown yet (-1: no limit,
	 * no wait), or until `waiting()` is false. Returns the calls not shown yet.
	 */
	waitBehind(calls: string[], limit: number, waiting: () => boolean): Promise<string[]>;

	/** The editor's last stop request, if any. */
	stop(): StopRequest | undefined;

	/** The editor's last helpi! request, if any. */
	help(): HelpRequest | undefined;

	/** The editor's last ask request, if any. */
	ask(): AskRequest | undefined;

	/** The editor's last fill! request (or release), if any. */
	fill(): FillRequest | undefined;

	/** The editor's last answer to a proposal, if any. */
	answer(): ProposalAnswer | undefined;

	/** The editor's last ack of a filled body, if any. */
	review(): ReviewRequest | undefined;
}
