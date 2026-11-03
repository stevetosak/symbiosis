// Facts about the process an agent session runs in, for its session record.
import type { Session } from './protocol.ts';

/** The pane pi runs in, from the multiplexer's environment. */
export function paneOf(env: NodeJS.ProcessEnv): Pick<Session, 'pane' | 'host'> {
	if (env.HERDR_PANE_ID) return { pane: env.HERDR_PANE_ID, host: 'herdr' };
	if (env.TMUX && env.TMUX_PANE) return { pane: env.TMUX_PANE, host: 'tmux' };
	return { pane: null, host: null };
}

const PANE = /^[A-Za-z0-9%][\w%:.@-]{0,63}$/;

export function escKeys({ pane, host }: Pick<Session, 'pane' | 'host'>): string[] | undefined {
	if (!pane || !PANE.test(pane)) return undefined;
	if (host === 'herdr') return ['herdr', 'pane', 'send-keys', pane, 'esc'];
	if (host === 'tmux') return ['tmux', 'send-keys', '-t', pane, 'Escape'];
	return undefined;
}
