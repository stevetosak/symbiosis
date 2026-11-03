import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VARIABLE = 'CLAUDE_CODE_PLUGIN_DIRS';

export function settingsPath(env = process.env, home = homedir()) {
	return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json');
}

export function isSymbiosisCopy(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf-8')).name === 'symbiosis';
	} catch {
		return false;
	}
}

export function withCopy(current, copy, isCopy = isSymbiosisCopy) {
	const same = (dir) => resolve(dir) === resolve(copy);
	const dirs = current
		.split(delimiter)
		.map((dir) => dir.trim())
		.filter(Boolean)
		.filter((dir) => same(dir) || !isCopy(dir));
	return (dirs.some(same) ? dirs : [...dirs, copy]).join(delimiter);
}

function isObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function planPluginDir(file, copy, isCopy = isSymbiosisCopy) {
	const what = `Claude Code plugin folder in ${file}`;
	const byHand = `add ${copy} to env.${VARIABLE} by hand`;
	if (!isAbsolute(copy) || copy.includes(delimiter)) return { what, state: 'skip', why: `${copy} cannot be a folder in ${VARIABLE}` };
	let text;
	try {
		text = readFileSync(file, 'utf-8');
	} catch (error) {
		if (error?.code !== 'ENOENT') return { what, state: 'skip', why: `cannot read it; ${byHand}` };
	}
	let settings = {};
	if (text !== undefined) {
		try {
			settings = JSON.parse(text);
		} catch {
			return { what, state: 'skip', why: `not valid JSON; ${byHand}` };
		}
	}
	if (!isObject(settings) || (settings.env !== undefined && !isObject(settings.env))) return { what, state: 'skip', why: `not a settings object; ${byHand}` };
	const current = settings.env?.[VARIABLE];
	if (current !== undefined && typeof current !== 'string') return { what, state: 'skip', why: `env.${VARIABLE} is not a string; ${byHand}` };
	const next = withCopy(current ?? '', copy, isCopy);
	if (next === current) return { what, state: 'ok' };
	return {
		what,
		state: text === undefined ? 'create' : 'update',
		why: `${VARIABLE}=${next}`,
		run: () => {
			const target = existsSync(file) ? realpathSync(file) : file;
			mkdirSync(dirname(target), { recursive: true });
			const temporary = `${target}.${process.pid}.tmp`;
			writeFileSync(temporary, `${JSON.stringify({ ...settings, env: { ...settings.env, [VARIABLE]: next } }, null, 2)}\n`);
			renameSync(temporary, target);
		},
	};
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === here) {
	const copy = resolve(process.argv[2] ?? join(dirname(here), '..'));
	const file = settingsPath();
	const step = planPluginDir(file, copy);
	try {
		step.run?.();
	} catch (error) {
		step.state = 'skip';
		step.why = `could not write it: ${error.message}`;
	}
	if (step.state === 'skip') console.log(`  Claude Code: ${file}: ${step.why}`);
	else console.log(`✓ Claude Code loads symbiosis from ${copy} (${VARIABLE} in ${file})`);
}
