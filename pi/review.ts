// Review per stub, the pi side: keeps the list of bodies the agent filled
// that the developer has not acked. A body lands when a fill ends (pi/fill.ts
// settle); the editor shows it (drawer, gutter mark) from the session record
// and acks it with review.json. The list lives in the session only: a
// restart of pi forgets it (docs/design.md, "Review per stub").
import type { Channel } from '../core/channel/channel.ts';
import { addLanded, type Landed, type Landing } from '../core/review.ts';

export interface ReviewHost {
	channel: Channel;
	/** This session's id. */
	id: string;
	/** The list changed: write the session record at once. */
	publish(list: Landed[]): void;
}

export class Reviewing {
	private readonly host: ReviewHost;
	private list: Landed[] = [];
	private seen: string | undefined;
	private count = 0;

	constructor(host: ReviewHost) {
		this.host = host;
	}

	/** An ack from before this session is old. */
	skipOld(): void {
		this.seen = this.host.channel.enabled() ? this.host.channel.review()?.id : undefined;
	}

	/** The un-acked bodies, the newest last. */
	landed(): Landed[] {
		return this.list;
	}

	/** A body landed: the developer reviews it with the agent's reasons for the file. */
	land(landing: Landing, whys: string[], now = Date.now()): Landed {
		const landed: Landed = { ...landing, id: `${this.host.id}-${(++this.count).toString(36)}`, whys, time: Math.floor(now / 1000) };
		this.list = addLanded(this.list, landed);
		this.host.publish(this.list);
		return landed;
	}

	/** Reads review.json: the developer acked a body. */
	poll(): void {
		const { channel, id } = this.host;
		if (!channel.enabled()) return;
		const request = channel.review();
		if (!request || request.to !== id || request.id === this.seen) return;
		this.seen = request.id;
		const rest = this.list.filter((l) => l.id !== request.ack);
		if (rest.length === this.list.length) return;
		this.list = rest;
		this.host.publish(this.list);
	}
}
