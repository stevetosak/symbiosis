// Facts about the process an agent session runs in, for its session record.
import type { Session } from './protocol.ts';

/** The pane pi runs in, from the multiplexer's environment. */
export function paneOf(env: NodeJS.ProcessEnv): Pick<Session, 'pane' | 'host'> {
	if (env.HERDR_PANE_ID) return { pane: env.HERDR_PANE_ID, host: 'herdr' };
	if (env.TMUX && env.TMUX_PANE) return { pane: env.TMUX_PANE, host: 'tmux' };
	return { pane: null, host: null };
}
