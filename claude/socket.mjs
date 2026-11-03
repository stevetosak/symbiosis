import { mkdirSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function pluginDir(env = process.env, home = homedir()) {
	return join(env.TTT_CONFIG_DIR || join(home, '.config', 'ttt'), 'plugins', 'symbiosis');
}

export function socketDir(env = process.env, uid = process.getuid()) {
	if (env.SYMBIOSIS_RUN_DIR) return env.SYMBIOSIS_RUN_DIR;
	if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, 'symbiosis');
	return join('/tmp', `symbiosis-${uid}`);
}

export function ownDir(dir, uid = process.getuid()) {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const s = statSync(dir);
		return s.isDirectory() && s.uid === uid && (s.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

export function socketPath(id, env = process.env) {
	return join(socketDir(env), `${id}.sock`);
}

export function send(path, message, timeoutMs = 3000) {
	return new Promise((resolve) => {
		let settled = false;
		const socket = connect(path);
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => finish('timeout'), timeoutMs);
		socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
		socket.on('data', (data) => {
			if (data.includes(0x0a)) finish('ok');
		});
		socket.on('error', (error) => finish(error.code === 'ENOENT' || error.code === 'ECONNREFUSED' ? 'absent' : 'failed'));
		socket.on('close', () => finish('failed'));
	});
}
