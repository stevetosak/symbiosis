import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { commandLine, inputRefs, type ListedConfig, parseDotenv, parseInputs, parseJsonc, parseRunJson, type RunConfig, RunConfigError, shQuote, toRunJson } from '../core/run/config.ts';
import { detect, walk } from '../core/run/detect.ts';
import { currentFileConfig, fileCommand } from '../core/run/file.ts';
import { decide, InputMemory, listOptions, pickedLabels, pickInputs } from '../core/run/inputs.ts';
import { type Launch, listConfigs, listed, resolveConfig, workspaceFolder } from '../core/run/list.ts';
import { cargoBins, isDotnetProgram, isGoMain, launchProfiles } from '../core/run/providers/native.ts';
import { tomlTable } from '../core/run/providers/python.ts';
import { justRecipes, makeTargets, procfile, yamlKeys } from '../core/run/providers/tasks.ts';
import { alive, groupAlive, isLive, LINE_MAX, MAX_AGE_MS, type RunState, Runs, STARTING_MS, stripAnsi, Tail } from '../core/run/runs.ts';
import { expand, expandShell } from '../core/run/variables.ts';
import { importLaunch, importTasks } from '../core/run/vscode.ts';
import { askStopRuns, inputMemory, orphans, parseRunArgs, runCommand, type RunArgs, stopRun } from '../launcher/run.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A temp folder, its real path (macOS: /var is /private/var). */
function temp(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), 'symbiosis-run-')));
}

/** Writes files under `dir`: { "a/b.txt": "text" }. */
function files(dir: string, tree: Record<string, string>): void {
	for (const [name, text] of Object.entries(tree)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), text);
	}
}

function byId(configs: readonly RunConfig[]): Map<string, RunConfig> {
	return new Map(configs.map((c) => [c.id, c]));
}

// run.json ------------------------------------------------------------------------

test('run.json: JSONC with comments and trailing commas; command+args vs a shell line', () => {
	const text = [
		'{',
		'  // the configs',
		'  "configurations": [',
		'    /* a program */ { "name": "api", "command": "npm", "args": ["run", "dev",], "cwd": "${workspaceFolder}/api",',
		'      "env": { "PORT": 3000, "DEBUG": true, "URL": "http://x//y" }, "envFile": ".env", },',
		'    { "name": "worker", "command": "python worker.py --verbose" },',
		'  ],',
		'}',
	].join('\n');
	assert.deepEqual(parseRunJson(text).configs, [
		{
			id: 'saved:api', name: 'api', group: 'Saved', command: 'npm', args: ['run', 'dev'], cwd: '${workspaceFolder}/api',
			env: { PORT: '3000', DEBUG: 'true', URL: 'http://x//y' }, envFile: '.env', source: '.symbiosis/run.json',
		},
		{ id: 'saved:worker', name: 'worker', group: 'Saved', command: 'python worker.py --verbose', source: '.symbiosis/run.json' },
	]);
	assert.deepEqual(parseRunJson('{"configurations": []}', 'x.json'), { configs: [], compounds: [] });
	// "//" and "/*" inside strings are not comments; escaped quotes are kept.
	assert.deepEqual(parseJsonc('{"a": "// no", "b": "/* no */", "c": "q\\"//"} // yes', 'w'), { a: '// no', b: '/* no */', c: 'q"//' });
	assert.deepEqual(parseJsonc('{"a": "x,}", "b": [1, 2, ], /* c */ }', 'w'), { a: 'x,}', b: [1, 2] }, 'a ",}" in a string stays');
});

test('run.json: bad entries throw RunConfigError with where and what', () => {
	const bad = (text: string, re: RegExp) => assert.throws(() => parseRunJson(text, 'r.json'), (e: Error) => e instanceof RunConfigError && re.test(e.message));
	bad('{ "configurations": [ }', /^r\.json: not valid JSON/);
	bad('{}', /needs "configurations": \[/);
	bad('{"configurations": {}}', /needs "configurations"/);
	bad('{"configurations": [1]}', /configurations\[0\] must be an object/);
	bad('{"configurations": [{"command": "x"}]}', /configurations\[0\] needs a "name"/);
	bad('{"configurations": [{"name": " ", "command": "x"}]}', /needs a "name"/);
	bad('{"configurations": [{"name": "a"}]}', /\("a"\) needs a "command"/);
	bad('{"configurations": [{"name": "a", "command": "x"}, {"name": "a", "command": "y"}]}', /configurations\[1\]: the name "a" is used twice/);
	bad('{"configurations": [{"name": "a", "command": "x", "args": "y"}]}', /\.args must be a list of strings/);
	bad('{"configurations": [{"name": "a", "command": "x", "args": [1]}]}', /\.args must be a list of strings/);
	bad('{"configurations": [{"name": "a", "command": "x", "cwd": 1}]}', /\.cwd must be a string/);
	bad('{"configurations": [{"name": "a", "command": "x", "envFile": []}]}', /\.envFile must be a string/);
	bad('{"configurations": [{"name": "a", "command": "x", "env": []}]}', /\.env must be an object of strings/);
	bad('{"configurations": [{"name": "a", "command": "x", "env": {"K": {}}}]}', /\.env\.K must be a string/);
});

test('run.json compounds: steps name configs of the file; a step input replaces the compound one', () => {
	const text = JSON.stringify({
		inputs: [{ id: 'profile', type: 'pick', options: ['nilan-local', 'ies-local'] }],
		configurations: [
			{ name: 'infra', command: 'bash up.sh' },
			{ name: 'api', command: 'dotnet run --launch-profile ${input:profile}' },
			{ name: 'web', command: 'dotnet run --launch-profile ${input:profile}' },
		],
		compounds: [{
			name: 'Local Nilan',
			inputs: { profile: 'nilan-local' },
			steps: [
				{ run: 'infra' },
				{ run: 'api', after: 'finished' },
				{ run: 'web', after: 'started', inputs: { profile: 'ies-local' } },
			],
		}],
	});
	assert.deepEqual(parseRunJson(text).compounds, [{
		id: 'compound:Local Nilan', name: 'Local Nilan', group: 'Compound Launches', source: '.symbiosis/run.json',
		steps: [
			{ configId: 'saved:infra' },
			{ configId: 'saved:api', after: 'finished', inputs: { profile: 'nilan-local' } },
			{ configId: 'saved:web', after: 'started', inputs: { profile: 'ies-local' } },
		],
	}]);
});

test('run.json compounds: "configurations", as VS Code writes it, starts each one now', () => {
	const text = JSON.stringify({
		configurations: [{ name: 'api', command: 'npm run api' }, { name: 'web', command: 'npm run web' }],
		compounds: [{ name: 'Dev', configurations: ['api', 'web'] }],
	});
	assert.deepEqual(parseRunJson(text).compounds.map((c) => c.steps), [[{ configId: 'saved:api' }, { configId: 'saved:web' }]]);
});

/** Throws for compounds over the configs a, b and c. */
function badCompounds(compounds: unknown, re: RegExp): void {
	const configurations = ['a', 'b', 'c'].map((name) => ({ name, command: `echo ${name}` }));
	assert.throws(() => parseRunJson(JSON.stringify({ configurations, compounds }), 'r.json'), (e: Error) => e instanceof RunConfigError && re.test(e.message), re.source);
}

test('run.json compounds: a bad shape throws with where and what', () => {
	badCompounds({}, /^r\.json: "compounds" must be a list/);
	badCompounds([1], /^r\.json: compounds\[0\] must be an object/);
	badCompounds([{ steps: [{ run: 'a' }] }], /compounds\[0\] needs a "name"/);
	badCompounds([{ name: ' ', steps: [{ run: 'a' }] }], /compounds\[0\] needs a "name"/);
	badCompounds([{ name: 'X', steps: [{ run: 'a' }] }, { name: 'X', steps: [{ run: 'b' }] }], /compounds\[1\]: the name "X" is used twice/);
	badCompounds([{ name: 'X' }], /compounds\[0\] \("X"\) needs "steps" or "configurations", one of them/);
	badCompounds([{ name: 'X', steps: [{ run: 'a' }], configurations: ['b'] }], /one of them/);
	badCompounds([{ name: 'X', steps: [] }], /compounds\[0\] \("X"\): "steps" must be a list with a step in it/);
	badCompounds([{ name: 'X', steps: {} }], /"steps" must be a list with a step in it/);
	badCompounds([{ name: 'X', configurations: [] }], /compounds\[0\] \("X"\): "configurations" must be a list of names, not empty/);
	badCompounds([{ name: 'X', configurations: [1] }], /"configurations" must be a list of names/);
	badCompounds([{ name: 'X', steps: [1] }], /compounds\[0\]\.steps\[0\] must be an object/);
});

test('run.json compounds: a step names a config of the file once; "after" is "started" or "finished", not on the first', () => {
	badCompounds([{ name: 'X', steps: [{}] }], /compounds\[0\]\.steps\[0\] needs a "run": the name of a configuration/);
	badCompounds([{ name: 'X', steps: [{ run: 'npm::dev' }] }], /compounds\[0\]\.steps\[0\]: no configuration "npm::dev" in r\.json/);
	badCompounds([{ name: 'X', configurations: ['a', 'zz'] }], /compounds\[0\]\.configurations\[1\]: no configuration "zz" in r\.json/);
	badCompounds([{ name: 'X', configurations: ['a', 'b', 'a'] }], /compounds\[0\]\.configurations\[2\]: "a" is a step already/);
	badCompounds([{ name: 'X', steps: [{ run: 'a' }, { run: 'b', after: 'ready' }] }], /compounds\[0\]\.steps\[1\]\.after must be "started" or "finished"/);
	badCompounds([{ name: 'X', steps: [{ run: 'a', after: 'finished' }] }], /compounds\[0\]\.steps\[0\]: the first step has nothing to wait for/);
});

test('run.json compounds: input values are for inputs a step uses, and one of the options of a list', () => {
	const file = (compounds: unknown) => JSON.stringify({
		inputs: [
			{ id: 'profile', type: 'pick', options: ['nilan-local', 'ies-local'] },
			{ id: 'device', type: 'pick', command: 'list-devices' },
		],
		configurations: [
			{ name: 'api', command: 'run ${input:profile}' },
			{ name: 'app', command: 'run-on ${input:device}' },
			{ name: 'infra', command: 'up' },
		],
		compounds,
	});
	const bad = (compounds: unknown, re: RegExp) =>
		assert.throws(() => parseRunJson(file(compounds), 'r.json'), (e: Error) => e instanceof RunConfigError && re.test(e.message), re.source);
	bad([{ name: 'X', inputs: [], configurations: ['api'] }], /compounds\[0\]\.inputs must be an object of strings/);
	bad([{ name: 'X', steps: [{ run: 'api', inputs: { profile: {} } }] }], /compounds\[0\]\.steps\[0\]\.inputs\.profile must be a string/);
	bad([{ name: 'X', inputs: { mode: 'x' }, configurations: ['api', 'infra'] }], /compounds\[0\]\.inputs: no step uses the input "mode"/);
	bad([{ name: 'X', steps: [{ run: 'infra', inputs: { profile: 'ies-local' } }] }], /compounds\[0\]\.steps\[0\]\.inputs: "infra" does not use the input "profile"/);
	bad([{ name: 'X', inputs: { profile: 'prod' }, configurations: ['api'] }], /compounds\[0\]\.inputs\.profile: "prod" is not one of its options/);
	bad([{ name: 'X', steps: [{ run: 'api', inputs: { profile: 'prod' } }] }], /compounds\[0\]\.steps\[0\]\.inputs\.profile: "prod" is not one of its options/);
	const [ok] = parseRunJson(file([{ name: 'X', inputs: { device: 'any-serial' }, configurations: ['app', 'infra'] }])).compounds;
	assert.deepEqual(ok.steps, [{ configId: 'saved:app', inputs: { device: 'any-serial' } }, { configId: 'saved:infra' }], 'a command\'s options are known only when it runs');
});

test('run.json compounds: listed with the configs; a bad one is a problem of the file, as a bad config is', () => {
	const dir = temp();
	try {
		const configurations = [{ name: 'a', command: 'echo a' }];
		files(dir, { '.symbiosis/run.json': JSON.stringify({ configurations, compounds: [{ name: 'All', configurations: ['a'] }] }) });
		assert.deepEqual(listConfigs(dir).compounds.map((c) => c.id), ['compound:All']);
		files(dir, {
			'.symbiosis/run.json': JSON.stringify({ configurations, compounds: [{ name: 'All', configurations: ['zz'] }] }),
			'package.json': '{"scripts": {"dev": "node app.js"}}',
		});
		const listing = listConfigs(dir);
		assert.deepEqual(listing.problems, ['.symbiosis/run.json: compounds[0].configurations[0]: no configuration "zz" in .symbiosis/run.json']);
		assert.deepEqual(listing.compounds, []);
		assert.deepEqual(listing.configs.map((c) => c.id), ['npm::dev']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('symbiosis run list: the compounds first, a line of their step names', async () => {
	const dir = temp();
	try {
		files(dir, {
			'.symbiosis/run.json': JSON.stringify({
				configurations: [{ name: 'a', command: 'echo a' }, { name: 'b', command: 'echo b' }],
				compounds: [{ name: 'All', steps: [{ run: 'a' }, { run: 'b', after: 'finished' }] }],
			}),
		});
		const runs = new Runs(join(dir, 'runs'));
		const { out } = await runCommand({ command: 'list', ids: [], all: false, adopt: false, folder: dir }, runs);
		const configs = out.configs as ListedConfig[];
		assert.deepEqual(configs.map((c) => c.id), ['compound:All', 'saved:a', 'saved:b']);
		assert.deepEqual(configs[0], {
			id: 'compound:All', name: 'All', group: 'Compound Launches', kind: 'compound', steps: ['a', 'b'], line: 'a → b', cwd: '.', source: '.symbiosis/run.json',
		});
		assert.equal(configs[1].kind, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('run.json: a broken file is a problem in the listing, not a throw; the rest still lists', () => {
	const dir = temp();
	try {
		files(dir, {
			'.symbiosis/run.json': '{"configurations": [{"name": "a"}]}',
			'package.json': '{"scripts": {"dev": "node app.js"}}',
		});
		const listing = listConfigs(dir);
		assert.deepEqual(listing.problems, ['.symbiosis/run.json: configurations[0] ("a") needs a "command"']);
		assert.deepEqual(listing.configs.map((c) => c.id), ['npm::dev']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('config helpers: toRunJson, shQuote, commandLine, parseDotenv', () => {
	assert.deepEqual(toRunJson({ id: 'npm:web:dev', name: 'web: dev', group: 'npm', command: 'npm', args: ['run', 'dev'], cwd: 'web', source: 'web/package.json' }), {
		name: 'web: dev', command: 'npm', args: ['run', 'dev'], cwd: 'web',
	});
	assert.deepEqual(toRunJson({ id: 'x', name: 'x', group: 'g', command: 'ls -l', env: { A: '1' }, envFile: '.env' }), { name: 'x', command: 'ls -l', env: { A: '1' }, envFile: '.env' });
	assert.equal(shQuote('a/b-c.d:e=f'), 'a/b-c.d:e=f');
	assert.equal(shQuote('two words'), "'two words'");
	assert.equal(shQuote("it's"), `'it'\\''s'`);
	assert.equal(shQuote(''), "''");
	assert.equal(commandLine({ command: 'echo $HOME | wc' }), 'echo $HOME | wc');
	assert.equal(commandLine({ command: 'node', args: ['-e', 'console.log(1)'] }), "node -e 'console.log(1)'");
	assert.deepEqual(
		parseDotenv('# comment\nA=1\nexport B = two \nC="x\\ny \\"q\\""\nD=\'single # not\'\nE=val # comment\n\nnot a line\nF.G=h\r\nH=\n'),
		{ A: '1', B: 'two', C: 'x\ny "q"', D: 'single # not', E: 'val', 'F.G': 'h', H: '' },
	);
});

// Variables -----------------------------------------------------------------------

test('variables: VSCode variables expand; unknown ones and missing files are errors', () => {
	const ctx = { folder: '/w/proj', file: '/w/proj/src/app.test.ts', line: 7, env: { X: 'ex' } };
	const cases: [string, string][] = [
		['${workspaceFolder}', '/w/proj'],
		['${workspaceRoot}', '/w/proj'],
		['${workspaceFolderBasename}', 'proj'],
		['${cwd}', '/w/proj'],
		['${file}', '/w/proj/src/app.test.ts'],
		['${relativeFile}', join('src', 'app.test.ts')],
		['${relativeFileDirname}', 'src'],
		['${fileBasename}', 'app.test.ts'],
		['${fileBasenameNoExtension}', 'app.test'],
		['${fileDirname}', '/w/proj/src'],
		['${fileDirnameBasename}', 'src'],
		['${fileExtname}', '.ts'],
		['${lineNumber}', '7'],
		['${env:X}', 'ex'],
		['${env:NOT_SET}', ''],
		['${pathSeparator}', sep],
		['${/}', sep],
		['$HOME and $X stay', '$HOME and $X stay'],
		['${workspaceFolder}/api:${lineNumber}', '/w/proj/api:7'],
	];
	for (const [text, want] of cases) assert.equal(expand(text, ctx), want, text);
	const err = (text: string, c: Parameters<typeof expand>[1], re: RegExp) =>
		assert.throws(() => expand(text, c), (e: Error) => e instanceof RunConfigError && re.test(e.message), text);
	err('${nope}', ctx, /\$\{nope\} is not a variable symbiosis knows/);
	err('${fileNope}', ctx, /\$\{fileNope\} is not a variable/);
	const noFile = { folder: '/w/proj', env: {} };
	err('${file}', noFile, /\$\{file\}: no file is open/);
	err('${relativeFile}', noFile, /no file is open/);
	err('${fileBasename}', noFile, /no file is open/);
	err('${lineNumber}', noFile, /\$\{lineNumber\}: no file is open/);
	assert.equal(expand('${workspaceFolder}', noFile), '/w/proj');
});

// VSCode ---------------------------------------------------------------------------

test('vscode: launch.json launch configs become programs; the rest are problems', () => {
	const text = [
		'{ "version": "0.2.0", // comment',
		'  "configurations": [',
		'    { "type": "node", "request": "launch", "name": "server", "program": "${workspaceFolder}/server.js", "args": ["--port", "3000"],',
		'      "cwd": "${workspaceFolder}/web", "env": { "DEBUG": "1", "N": 2, "X": null }, "envFile": "${workspaceFolder}/.env" },',
		'    { "type": "pwa-node", "request": "launch", "name": "tsx", "runtimeExecutable": "npx", "runtimeArgs": ["tsx", "src/main.ts"] },',
		'    { "type": "node-terminal", "request": "launch", "name": "dev", "command": "npm run dev" },',
		'    { "type": "debugpy", "request": "launch", "name": "mod", "module": "app", "args": ["x"] },',
		'    { "type": "python", "request": "launch", "name": "script", "program": "main.py", "python": "/venv/bin/python" },',
		'    { "type": "go", "request": "launch", "name": "gosvc", "program": "./cmd/api" },',
		'    { "type": "coreclr", "request": "launch", "name": "net", "program": "bin/app.dll" },',
		'    { "type": "lldb", "request": "launch", "name": "native", "program": "./target/debug/app", "args": ["a"] },',
		'    { "type": "node", "request": "attach", "name": "attach" },',
		'    { "type": "chrome", "request": "launch", "name": "browser" },',
		'    { "type": "node", "request": "launch", "name": "empty" },',
		'    { "type": "python", "request": "launch", "name": "nopy" },',
		'    { "type": "node", "request": "launch", "program": "nameless.js" },',
		'  ],',
		'}',
	].join('\n');
	const { configs, problems } = importLaunch(text);
	const src = { group: 'VS Code', source: '.vscode/launch.json' };
	assert.deepEqual(configs, [
		{
			id: 'vscode:server', name: 'server', ...src, command: 'node', args: ['${workspaceFolder}/server.js', '--port', '3000'],
			cwd: '${workspaceFolder}/web', env: { DEBUG: '1', N: '2' }, envFile: '${workspaceFolder}/.env',
		},
		{ id: 'vscode:tsx', name: 'tsx', ...src, command: 'npx', args: ['tsx', 'src/main.ts'] },
		{ id: 'vscode:dev', name: 'dev', ...src, command: 'sh', args: ['-c', 'npm run dev'] },
		{ id: 'vscode:mod', name: 'mod', ...src, command: 'python3', args: ['-m', 'app', 'x'] },
		{ id: 'vscode:script', name: 'script', ...src, command: '/venv/bin/python', args: ['main.py'] },
		{ id: 'vscode:gosvc', name: 'gosvc', ...src, command: 'go', args: ['run', './cmd/api'] },
		{ id: 'vscode:net', name: 'net', ...src, command: 'dotnet', args: ['bin/app.dll'] },
		{ id: 'vscode:native', name: 'native', ...src, command: './target/debug/app', args: ['a'] },
	]);
	assert.deepEqual(problems, [
		'.vscode/launch.json: "attach" attaches to a program; symbiosis starts programs',
		'.vscode/launch.json: "browser" type "chrome" is not one symbiosis can run',
		'.vscode/launch.json: "empty" needs a "program" or "runtimeArgs"',
		'.vscode/launch.json: "nopy" needs a "program" or "module"',
	]);
	assert.deepEqual(importLaunch('{}'), { configs: [], compounds: [], problems: [] });
	assert.throws(() => importLaunch('{ nope'), /\.vscode\/launch\.json: not valid JSON/);
});

const LAUNCH_CONFIGS = [
	'{ "type": "node", "request": "launch", "name": "server", "program": "server.js" }',
	'{ "type": "node", "request": "launch", "name": "tsx", "runtimeExecutable": "npx", "runtimeArgs": ["tsx", "a.ts"] }',
];

test('vscode: launch.json compounds become compounds; stopAll has no effect', () => {
	const text = `{ "configurations": [${LAUNCH_CONFIGS.join(',')}], "compounds": [
		{ "name": "Both", "configurations": ["server", { "name": "tsx" }], "stopAll": true },
	] }`;
	const { compounds, problems } = importLaunch(text);
	assert.deepEqual(problems, []);
	assert.deepEqual(compounds, [{
		id: 'compound:vscode:Both', name: 'Both', group: 'Compound Launches',
		steps: [{ configId: 'vscode:server' }, { configId: 'vscode:tsx' }], source: '.vscode/launch.json',
	}]);
});

test('vscode: a launch.json compound that symbiosis cannot run as written is a problem, not a compound', () => {
	const text = `{ "configurations": [${LAUNCH_CONFIGS.join(',')}, { "type": "node", "request": "attach", "name": "attach" }],
	"compounds": [
		{ "name": "Pre", "configurations": ["server"], "preLaunchTask": "build" },
		{ "name": "Attach", "configurations": ["server", "attach"] },
		{ "name": "Nope", "configurations": ["nope"] },
		{ "name": "Other", "configurations": [{ "name": "server", "folder": "api" }] },
		{ "name": "Twice", "configurations": ["server", "server"] },
		{ "name": "Empty", "configurations": [] },
		{ "name": "Blank", "configurations": [{}] },
		{ "configurations": ["server"] },
	] }`;
	const { compounds, problems } = importLaunch(text);
	assert.deepEqual(compounds, []);
	assert.deepEqual(problems.filter((p) => p.includes('compound')), [
		'.vscode/launch.json: compound "Pre" has a preLaunchTask; symbiosis does not run tasks',
		'.vscode/launch.json: compound "Attach": "attach" is not a configuration symbiosis can run',
		'.vscode/launch.json: compound "Nope": no configuration "nope" in .vscode/launch.json',
		'.vscode/launch.json: compound "Other": "server" is in another folder ("api")',
		'.vscode/launch.json: compound "Twice": "server" is a step already',
		'.vscode/launch.json: compound "Empty" has no configurations',
		'.vscode/launch.json: compound "Blank": a step has no name',
	]);
});

test('vscode: launch.json compounds are listed after run.json\'s; the same name in both is two compounds', () => {
	const dir = temp();
	try {
		files(dir, {
			'.symbiosis/run.json': JSON.stringify({ configurations: [{ name: 'a', command: 'echo a' }], compounds: [{ name: 'Both', configurations: ['a'] }] }),
			'.vscode/launch.json': `{ "configurations": [${LAUNCH_CONFIGS.join(',')}], "compounds": [{ "name": "Both", "configurations": ["server", "tsx"] }] }`,
		});
		assert.deepEqual(listConfigs(dir).compounds.map((c) => c.id), ['compound:Both', 'compound:vscode:Both']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('vscode: tasks.json shell, process and npm tasks become configs', () => {
	const text = JSON.stringify({
		version: '2.0.0',
		tasks: [
			{ label: 'build', type: 'shell', command: 'make', args: ['all', "it's"], options: { cwd: '${workspaceFolder}/sub', env: { A: '1' } } },
			{ label: 'serve', type: 'process', command: 'python3', args: ['-m', 'http.server'] },
			{ label: 'echo', command: 'echo', args: [{ value: 'hi', quoting: 'strong' }] },
			{ type: 'npm', script: 'test' },
			{ type: 'npm', script: 'lint', label: 'Lint it', path: 'web' },
			{ type: 'npm' },
			{ label: 'nocmd', type: 'shell' },
			{ label: 'gulp', type: 'gulp', command: 'x' },
			{ type: 'shell', command: 'nameless' },
		],
	});
	const { configs, problems } = importTasks(text);
	const src = { group: 'VS Code tasks', source: '.vscode/tasks.json' };
	assert.deepEqual(configs, [
		{ id: 'vscode-task:build', name: 'build', ...src, cwd: '${workspaceFolder}/sub', env: { A: '1' }, command: `make all 'it'\\''s'` },
		{ id: 'vscode-task:serve', name: 'serve', ...src, command: 'python3', args: ['-m', 'http.server'] },
		{ id: 'vscode-task:echo', name: 'echo', ...src, command: 'echo', args: ['hi'] },
		{ id: 'vscode-task:npm: test', name: 'npm: test', ...src, command: 'npm', args: ['run', 'test'] },
		{ id: 'vscode-task:Lint it', name: 'Lint it', ...src, command: 'npm', args: ['run', 'lint'], cwd: 'web' },
	]);
	assert.deepEqual(problems, [
		'.vscode/tasks.json: task "nocmd" has no command',
		'.vscode/tasks.json: task "gulp" has type "gulp"; symbiosis runs shell, process and npm tasks',
	]);
});

test('vscode: listConfigs reads .vscode/ and reports its problems', () => {
	const dir = temp();
	try {
		files(dir, {
			'.vscode/launch.json': '{"configurations": [{"type": "node", "request": "launch", "name": "app", "program": "app.js"}, {"type": "x", "request": "launch", "name": "bad"}]}',
			'.vscode/tasks.json': '{ "tasks": [ { "label": "t", "type": "shell", "command": "echo hi" } ] ',
		});
		const listing = listConfigs(dir);
		assert.deepEqual(listing.configs.map((c) => c.id), ['vscode:app']);
		assert.equal(listing.problems.length, 2);
		assert.match(listing.problems[0], /"bad" type "x"/);
		assert.match(listing.problems[1], /^\.vscode\/tasks\.json: not valid JSON/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Detection ------------------------------------------------------------------------

test('detection: a monorepo with npm, Make, Cargo, Go, .NET, Python, Gradle, Maven, Procfile, compose', () => {
	const dir = temp();
	try {
		files(dir, {
			'package.json': JSON.stringify({ scripts: { dev: 'node app.js', test: 'node --test', pretest: 'x', postinstall: 'x', prepare: 'x', num: 5 } }),
			'deno.json': '{ "tasks": { "start": "deno run main.ts" } }',
			'web/package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
			'web/yarn.lock': '',
			'Makefile': '.PHONY: build test\nCC := gcc\nbuild: deps\n\t$(CC) x\ntest:\n\techo\n%.o: %.c\nfoo.o: foo.c\n',
			'Procfile': 'web: node server.js\nworker:  node worker.js  \n',
			'compose.yaml': 'services:\n  db:\n    image: postgres\n  api:\n    build: .\nvolumes:\n  data:\n',
			'crates/tool/Cargo.toml': '[package]\nname = "tool"\n\n[[bin]]\nname = "extra"\npath = "src/extra.rs"\n\n[dependencies]\nname = "nope"\n',
			'crates/tool/src/main.rs': 'fn main() {}',
			'svc/go.mod': 'module example.com/svc\n',
			'svc/main.go': 'package main\n\nfunc main() {}\n',
			'svc/main_test.go': 'package main\n',
			'svc/cmd/cli/main.go': 'package main\nfunc main() {\n}\n',
			'svc/lib/lib.go': 'package lib\nfunc main() {}\n',
			'api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
			'api/Properties/launchSettings.json': JSON.stringify({ profiles: { Api: { commandName: 'Project' }, https: { commandName: 'Project' }, 'IIS Express': { commandName: 'IISExpress' } } }),
			'lib/Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Library</OutputType></PropertyGroup></Project>',
			'py/manage.py': '',
			'py/main.py': '',
			'tool/pyproject.toml': '[project]\nname = "t"\n\n[project.scripts]\nmytool = "t:main"\n\n[tool.pytest.ini_options]\n',
			'tool/uv.lock': '',
			'tool/main.py': '',
			'venvapp/app.py': '',
			'venvapp/.venv/pyvenv.cfg': '',
			'java/build.gradle.kts': 'plugins { id("org.springframework.boot"); application }\n',
			'java/gradlew': '',
			'java/sub/build.gradle': 'apply plugin: "java"\n',
			'mvn/pom.xml': '<project><plugin>spring-boot-maven-plugin</plugin><plugin>exec-maven-plugin</plugin></project>',
			// Skipped: dependencies, builds, hidden folders.
			'node_modules/dep/package.json': JSON.stringify({ scripts: { hidden: 'x' } }),
			'dist/Makefile': 'distonly:\n',
			'bin/Makefile': 'binonly:\n',
			'.hidden/package.json': JSON.stringify({ scripts: { hidden: 'x' } }),
			'crates/tool/target/Makefile': 'targetonly:\n',
		});
		const { configs, problems } = detect(dir);
		assert.deepEqual(problems, []);
		const got = byId(configs);
		const want: RunConfig[] = [
			{ id: 'npm::dev', name: 'dev', group: 'npm', command: 'npm', args: ['run', 'dev'], source: 'package.json' },
			{ id: 'npm::test', name: 'test', group: 'npm', command: 'npm', args: ['run', 'test'], source: 'package.json' },
			{ id: 'deno::start', name: 'start', group: 'deno', command: 'deno', args: ['task', 'start'], source: 'deno.json' },
			{ id: 'yarn:web:dev', name: 'web: dev', group: 'yarn', command: 'yarn', args: ['dev'], cwd: 'web', source: join('web', 'package.json') },
			{ id: 'make::build', name: 'build', group: 'make', command: 'make', args: ['build'], source: 'Makefile' },
			{ id: 'make::test', name: 'test', group: 'make', command: 'make', args: ['test'], source: 'Makefile' },
			{ id: 'procfile::web', name: 'web', group: 'Procfile', command: 'node server.js', source: 'Procfile' },
			{ id: 'procfile::worker', name: 'worker', group: 'Procfile', command: 'node worker.js', source: 'Procfile' },
			{ id: 'compose::up', name: 'up', group: 'Docker Compose', command: 'docker', args: ['compose', '-f', 'compose.yaml', 'up'], source: 'compose.yaml' },
			{ id: 'compose::up db', name: 'up db', group: 'Docker Compose', command: 'docker', args: ['compose', '-f', 'compose.yaml', 'up', 'db'], source: 'compose.yaml' },
			{ id: 'compose::up api', name: 'up api', group: 'Docker Compose', command: 'docker', args: ['compose', '-f', 'compose.yaml', 'up', 'api'], source: 'compose.yaml' },
			{ id: 'cargo:crates/tool:run tool', name: 'crates/tool: run tool', group: 'Cargo', command: 'cargo', args: ['run', '--bin', 'tool'], cwd: 'crates/tool', source: join('crates/tool', 'Cargo.toml') },
			{ id: 'cargo:crates/tool:run extra', name: 'crates/tool: run extra', group: 'Cargo', command: 'cargo', args: ['run', '--bin', 'extra'], cwd: 'crates/tool', source: join('crates/tool', 'Cargo.toml') },
			{ id: 'cargo:crates/tool:test', name: 'crates/tool: test', group: 'Cargo', command: 'cargo', args: ['test'], cwd: 'crates/tool', source: join('crates/tool', 'Cargo.toml') },
			{ id: 'go:svc:run .', name: 'svc: run .', group: 'Go', command: 'go', args: ['run', '.'], cwd: 'svc', source: join('svc', 'main.go') },
			{ id: 'go:svc:test ./...', name: 'svc: test ./...', group: 'Go', command: 'go', args: ['test', './...'], cwd: 'svc', source: join('svc', 'go.mod') },
			{ id: 'go:svc:run ./cmd/cli', name: 'svc: run ./cmd/cli', group: 'Go', command: 'go', args: ['run', './cmd/cli'], cwd: 'svc', source: join('svc/cmd/cli', 'main.go') },
			{ id: 'dotnet:api:run Api', name: 'api: run Api', group: '.NET', command: 'dotnet', args: ['run', '--project', 'Api.csproj'], cwd: 'api', source: join('api', 'Api.csproj') },
			{
				id: 'dotnet:api:run Api (https)', name: 'api: run Api (https)', group: '.NET', command: 'dotnet',
				args: ['run', '--project', 'Api.csproj', '--launch-profile', 'https'], cwd: 'api', source: join('api', 'Api.csproj'),
			},
			{ id: 'python:py:runserver', name: 'py: runserver', group: 'Python', command: 'python3', args: ['manage.py', 'runserver'], cwd: 'py', source: join('py', 'manage.py') },
			{ id: 'python:py:manage.py test', name: 'py: manage.py test', group: 'Python', command: 'python3', args: ['manage.py', 'test'], cwd: 'py', source: join('py', 'manage.py') },
			{ id: 'python:tool:mytool', name: 'tool: mytool', group: 'Python', command: 'uv', args: ['run', 'mytool'], cwd: 'tool', source: join('tool', 'pyproject.toml') },
			{ id: 'python:tool:pytest', name: 'tool: pytest', group: 'Python', command: 'uv', args: ['run', 'python', '-m', 'pytest'], cwd: 'tool', source: join('tool', 'pyproject.toml') },
			{ id: 'python:tool:main.py', name: 'tool: main.py', group: 'Python', command: 'uv', args: ['run', 'python', 'main.py'], cwd: 'tool', source: join('tool', 'main.py') },
			{ id: 'python:venvapp:app.py', name: 'venvapp: app.py', group: 'Python', command: '.venv/bin/python', args: ['app.py'], cwd: 'venvapp', source: join('venvapp', 'app.py') },
			{ id: 'gradle:java:bootRun', name: 'java: bootRun', group: 'Gradle', command: './gradlew', args: ['bootRun'], cwd: 'java', source: join('java', 'build.gradle.kts') },
			{ id: 'gradle:java:run', name: 'java: run', group: 'Gradle', command: './gradlew', args: ['run'], cwd: 'java', source: join('java', 'build.gradle.kts') },
			{ id: 'gradle:java:test', name: 'java: test', group: 'Gradle', command: './gradlew', args: ['test'], cwd: 'java', source: join('java', 'build.gradle.kts') },
			{ id: 'gradle:java/sub:test', name: 'java/sub: test', group: 'Gradle', command: '../gradlew', args: ['test'], cwd: 'java/sub', source: join('java/sub', 'build.gradle') },
			{ id: 'maven:mvn:spring-boot:run', name: 'mvn: spring-boot:run', group: 'Maven', command: 'mvn', args: ['spring-boot:run'], cwd: 'mvn', source: join('mvn', 'pom.xml') },
			{ id: 'maven:mvn:exec:java', name: 'mvn: exec:java', group: 'Maven', command: 'mvn', args: ['exec:java'], cwd: 'mvn', source: join('mvn', 'pom.xml') },
			{ id: 'maven:mvn:test', name: 'mvn: test', group: 'Maven', command: 'mvn', args: ['test'], cwd: 'mvn', source: join('mvn', 'pom.xml') },
		];
		for (const w of want) assert.deepEqual(got.get(w.id), w, w.id);
		// Exactly these: hooks, non-string scripts, deps, builds, hidden folders, libraries and IIS profiles are not there.
		assert.deepEqual([...got.keys()].sort(), want.map((w) => w.id).sort());
		// The root's configs come first (breadth first).
		assert.equal(configs[0].id, 'npm::dev');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('detection: the package manager from "packageManager", else the nearest lockfile, else npm', () => {
	const dir = temp();
	try {
		const pkg = JSON.stringify({ scripts: { dev: 'x' } });
		files(dir, {
			'pnpm-lock.yaml': '',
			'package.json': pkg,
			'a/package.json': pkg,
			'b/package.json': pkg,
			'b/bun.lockb': '',
			'c/package.json': JSON.stringify({ packageManager: 'yarn@4.1.0', scripts: { dev: 'x' } }),
			'd/package.json': '{ broken',
		});
		const got = byId(detect(dir).configs);
		assert.deepEqual(got.get('pnpm::dev')?.args, ['dev']);
		assert.deepEqual(got.get('pnpm:a:dev')?.args, ['dev']);
		assert.deepEqual(got.get('bun:b:dev')?.args, ['run', 'dev']);
		assert.deepEqual(got.get('yarn:c:dev')?.args, ['dev']);
		assert.equal([...got.keys()].filter((id) => id.includes(':d:')).length, 0);
		assert.equal(got.size, 4);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('detection: walk depth, and a provider that throws is a problem for that folder', () => {
	const dir = temp();
	try {
		files(dir, { 'a/b/c/Makefile': 'deep:\n', 'a/Makefile': 'shallow:\n' });
		assert.deepEqual(walk(dir).map((f) => f.rel), ['', 'a', 'a/b', 'a/b/c']);
		assert.deepEqual(walk(dir, { depth: 1 }).map((f) => f.rel), ['', 'a']);
		assert.deepEqual(walk(dir, { maxFolders: 2 }).map((f) => f.rel), ['', 'a']);
		assert.deepEqual(detect(dir, { depth: 1 }).configs.map((c) => c.id), ['make:a:shallow']);
		const boom = { name: 'boom', detect: (f: { rel: string }) => { if (f.rel === 'a') throw new Error('bad file'); return []; } };
		assert.deepEqual(detect(dir, {}, [boom]), { configs: [], problems: ['boom in a: bad file'] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('detection parsers: Makefile, justfile, YAML keys, Procfile, Cargo, Go, .NET, TOML', () => {
	assert.deepEqual(makeTargets('.PHONY: a\nX := 1\nY ?= 2\na b: c\n\techo\n%.o: %.c\nsrc/x: y\nfoo.o: foo.c\na:\n'), ['a', 'b']);
	assert.deepEqual(justRecipes('set shell := ["bash"]\nalias b := build\nbuild:\n  cargo b\n_hidden:\n  x\ntest arg:\n  x\n@quiet:\n  x\nx := "1"\nserve port="8080":\n  x\n'), ['build', 'test', 'quiet', 'serve']);
	assert.deepEqual(yamlKeys('version: 3\ntasks:\n  # c\n  build:\n    cmds:\n      - x\n  "lint":\n    deps: []\nother:\n  no:\n', 'tasks'), ['build', 'lint']);
	assert.deepEqual(procfile('web: a b\n# no\nbad line\n'), [['web', 'a b']]);
	assert.deepEqual(cargoBins('[package]\nname = "p"\n', true), ['p']);
	assert.deepEqual(cargoBins('[package]\nname = "p"\n', false), []);
	assert.deepEqual(cargoBins('[workspace]\n[[bin]]\nname = "x"\n[[bin]]\nname = "x"\n', false), ['x']);
	assert.equal(isGoMain('package main\nfunc main() {}'), true);
	assert.equal(isGoMain('package main\nfunc other() {}'), false);
	assert.equal(isGoMain('package lib\nfunc main() {}'), false);
	assert.equal(isDotnetProgram('<OutputType>Exe</OutputType>'), true);
	assert.equal(isDotnetProgram('<Project Sdk="Microsoft.NET.Sdk.Worker">'), true);
	assert.equal(isDotnetProgram('<Project Sdk="Microsoft.NET.Sdk">'), false);
	assert.deepEqual(launchProfiles('{ "profiles": { "a": { "commandName": "Project" }, "b": { "commandName": "IISExpress" } } }'), ['a']);
	assert.deepEqual(launchProfiles('nope'), []);
	assert.deepEqual(tomlTable('[project.scripts]\na = "m:f"\n"b-c" = "m:g"\n[other]\nd = 1\n', 'project.scripts'), ['a', 'b-c']);
});

// Current file ---------------------------------------------------------------------

test('current file: the program by extension; listed only for files it can run', () => {
	const dir = temp();
	try {
		assert.deepEqual(fileCommand('/x/a.ts'), { command: 'node', args: ['/x/a.ts'] });
		assert.deepEqual(fileCommand('/x/a.MJS'), { command: 'node', args: ['/x/a.MJS'] });
		assert.deepEqual(fileCommand('/x/main.go'), { command: 'go', args: ['run', '/x/main.go'] });
		assert.deepEqual(fileCommand('/x/s.sh'), { command: 'bash', args: ['/x/s.sh'] });
		assert.deepEqual(fileCommand('/x/s.ps1'), { command: 'pwsh', args: ['-File', '/x/s.ps1'] });
		assert.equal(fileCommand('/x/a.xyz'), undefined);
		assert.equal(fileCommand('/x/Makefile'), undefined);
		// Python: the .venv above the file.
		files(dir, { 'proj/.venv/bin/python': '', 'proj/src/app.py': '', 'other/app.py': '', 'app.js': '', 'notes.xyz': '' });
		assert.deepEqual(fileCommand(join(dir, 'proj/src/app.py')), { command: join(dir, 'proj/.venv/bin/python'), args: [join(dir, 'proj/src/app.py')] });
		assert.equal(fileCommand(join(dir, 'other/app.py'))?.command, 'python3');

		assert.deepEqual(currentFileConfig('/x/a.js'), { id: 'file', name: 'Current file', group: 'Current file', command: 'node', args: ['/x/a.js'], cwd: '${fileDirname}' });
		assert.deepEqual(currentFileConfig(undefined), { id: 'file', name: 'Current file', group: 'Current file', command: '', args: [], cwd: '${fileDirname}' });

		const js = join(dir, 'app.js');
		assert.equal(listConfigs(dir, { file: js }).configs.find((c) => c.id === 'file')?.name, 'Current file');
		assert.equal(listConfigs(dir, { file: join(dir, 'notes.xyz') }).configs.some((c) => c.id === 'file'), false);
		assert.equal(listConfigs(dir).configs.some((c) => c.id === 'file'), false);

		// The listed line is made from the file given, not the one listed with.
		const cfg = listConfigs(dir, { file: js }).configs.find((c) => c.id === 'file')!;
		assert.deepEqual(listed(dir, cfg, join(dir, 'other/app.py')), {
			id: 'file', name: 'Current file', group: 'Current file', line: `python3 ${join(dir, 'other/app.py')}`, cwd: '${fileDirname}',
		});

		const launch = resolveConfig(cfg, { folder: dir, file: js, env: {} });
		assert.deepEqual(launch, { name: 'Current file', configId: 'file', folder: dir, command: 'node', args: [js], cwd: dir, env: {}, line: `node ${js}` });
		assert.throws(() => resolveConfig(cfg, { folder: dir, env: {} }), /no file is open/);
		assert.throws(() => resolveConfig(cfg, { folder: dir, file: join(dir, 'notes.xyz'), env: {} }), /symbiosis does not know how to run .*notes\.xyz/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('listing order: Saved, VS Code, Current file, detected; the first of an id wins', () => {
	const dir = temp();
	try {
		files(dir, {
			'.symbiosis/run.json': '{"configurations": [{"name": "s", "command": "echo s"}]}',
			'.vscode/launch.json': '{"configurations": [{"type": "node", "request": "launch", "name": "l", "program": "a.js"}]}',
			'.vscode/tasks.json': '{"tasks": [{"label": "t", "type": "shell", "command": "echo t"}]}',
			'a.js': '',
			'Makefile': 'm:\n',
		});
		assert.deepEqual(listConfigs(dir, { file: join(dir, 'a.js') }).configs.map((c) => c.id), ['saved:s', 'vscode:l', 'vscode-task:t', 'file', 'make::m']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('resolveConfig: variables, cwd, envFile and env; missing folders and files are errors', () => {
	const dir = temp();
	try {
		files(dir, { 'api/.env': 'A=from-file\nB=file\n', 'api/x': '' });
		const config: RunConfig = {
			id: 'saved:api', name: 'api', group: 'Saved', command: 'node', args: ['${workspaceFolder}/srv.js', '--line=${lineNumber}', 'two words'],
			cwd: '${workspaceFolder}/api', env: { B: 'env', C: '${env:HOME_X}' }, envFile: '.env',
		};
		const launch = resolveConfig(config, { folder: dir, file: join(dir, 'a.js'), line: 4, env: { HOME_X: 'h' } });
		assert.deepEqual(launch, {
			name: 'api', configId: 'saved:api', folder: dir, command: 'node', args: [`${dir}/srv.js`, '--line=4', 'two words'],
			cwd: join(dir, 'api'), env: { A: 'from-file', B: 'env', C: 'h' }, line: `node ${dir}/srv.js --line=4 'two words'`,
		});
		// A shell line: no args; a relative cwd is from the workspace folder.
		const shell = resolveConfig({ id: 'saved:w', name: 'w', group: 'Saved', command: 'echo ${workspaceFolderBasename}', cwd: 'api' }, { folder: dir, env: {} });
		assert.equal(shell.command, `echo ${dir.split(sep).pop()}`);
		assert.equal(shell.args, undefined);
		assert.equal(shell.cwd, join(dir, 'api'));
		assert.equal(shell.line, shell.command);
		assert.throws(() => resolveConfig({ ...config, cwd: 'nope' }, { folder: dir, line: 1, env: {} }), /"api": the folder .*nope is not there/);
		assert.throws(() => resolveConfig({ ...config, cwd: 'api/x' }, { folder: dir, line: 1, env: {} }), /is not there/);
		assert.throws(() => resolveConfig({ ...config, envFile: 'missing.env' }, { folder: dir, line: 1, env: {} }), /"api": the envFile .*missing\.env is not there/);
		assert.throws(() => resolveConfig({ ...config, command: '${bogus}' }, { folder: dir, line: 1, env: {} }), RunConfigError);
		// listed: an absolute cwd shows relative to the folder.
		assert.deepEqual(listed(dir, { ...config, cwd: join(dir, 'api') }), {
			id: 'saved:api', name: 'api', group: 'Saved', line: "node '${workspaceFolder}/srv.js' '--line=${lineNumber}' 'two words'", cwd: 'api',
		});
		assert.equal(listed(dir, { ...config, cwd: dir }).cwd, '.');
		assert.equal(listed(dir, { id: 'x', name: 'x', group: 'g', command: 'ls', source: 'Makefile' }).cwd, '.');
		assert.equal(listed(dir, { id: 'x', name: 'x', group: 'g', command: 'ls', source: 'Makefile' }).source, 'Makefile');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Workspace folder -----------------------------------------------------------------

test('workspace folder: nearest run.json up to the git root, else the git root, else cwd or the file folder', () => {
	const dir = temp();
	try {
		mkdirSync(join(dir, 'repo/.git'), { recursive: true });
		files(dir, {
			'repo/a/b/f.ts': '',
			'repo/sub/.symbiosis/run.json': '{}',
			'repo/sub/deep/x/f.ts': '',
			'.symbiosis/run.json': '{}', // above the git root: not looked at from inside the repo
			'plain/c/f.ts': '',
			'plain2/f.ts': '',
		});
		const repo = join(dir, 'repo');
		assert.equal(workspaceFolder(join(repo, 'a/b/f.ts'), '/'), repo);
		assert.equal(workspaceFolder('a/b/f.ts', repo), repo);
		assert.equal(workspaceFolder(join(repo, 'sub/deep/x/f.ts'), '/'), join(repo, 'sub'));
		assert.equal(workspaceFolder(undefined, join(repo, 'sub/deep')), join(repo, 'sub'));
		assert.equal(workspaceFolder(undefined, join(repo, 'a/b')), repo);
		// A .git file (a worktree or submodule) counts too.
		files(dir, { 'repo/a/.git': 'gitdir: ../.git/worktrees/a\n' });
		assert.equal(workspaceFolder(join(repo, 'a/b/f.ts'), '/'), join(repo, 'a'));

		// No git: the nearest run.json above (here the temp folder's).
		assert.equal(workspaceFolder(join(dir, 'plain/c/f.ts'), '/'), dir);
		rmSync(join(dir, '.symbiosis'), { recursive: true });
		// No git, no run.json: cwd when the file is in it, else the file's folder.
		assert.equal(workspaceFolder(join(dir, 'plain/c/f.ts'), join(dir, 'plain')), join(dir, 'plain'));
		assert.equal(workspaceFolder(join(dir, 'plain/c/f.ts'), join(dir, 'plain2')), join(dir, 'plain/c'));
		assert.equal(workspaceFolder(undefined, join(dir, 'plain')), join(dir, 'plain'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Runs store -----------------------------------------------------------------------

function launchOf(folder: string, name = 'x'): Launch {
	return { name, configId: `saved:${name}`, folder, command: 'echo hi', cwd: folder, env: {}, line: 'echo hi' };
}

/** A pid that was alive and is not any more. */
function deadPid(): number {
	const pid = spawnSync('true').pid;
	assert.ok(pid);
	return pid;
}

test('runs: create, write, read; lost when the supervisor is gone', () => {
	const dir = temp();
	try {
		const runs = new Runs(join(dir, 'runs'));
		const launch = launchOf('/w');
		const state = runs.create(launch, 'r1');
		assert.equal(state.status, 'starting');
		assert.equal(state.seq, 0);
		assert.deepEqual(runs.launch('r1'), launch);
		assert.equal(readFileSync(runs.path('r1', 'tail.txt'), 'utf8'), '');
		assert.equal(runs.size('r1'), 0);
		// Created, its supervisor not up yet: starting for STARTING_MS, then lost.
		assert.equal(runs.read('r1')?.status, 'starting');
		runs.write({ ...state, started: Date.now() - STARTING_MS - 1 });
		assert.equal(runs.read('r1')?.status, 'lost');
		runs.write({ ...state, supervisor: deadPid() });
		assert.equal(runs.read('r1')?.status, 'lost');

		const gone = deadPid();
		runs.write({ ...state, status: 'running', supervisor: process.pid, pid: gone });
		assert.deepEqual(runs.read('r1'), { ...state, status: 'running', supervisor: process.pid, pid: gone, kept: false });
		// A pid that answers proves nothing (pids come back): the supervisor counts.
		runs.write({ ...state, status: 'running', supervisor: deadPid(), pid: process.pid });
		assert.equal(runs.read('r1')?.status, 'lost');
		runs.own('r1', 's1');
		assert.equal(runs.read('r1')?.session, 's1');
		runs.write({ ...state, status: 'running', supervisor: deadPid(), pid: deadPid() });
		assert.equal(runs.read('r1')?.status, 'lost');
		// Ended runs are never lost.
		runs.write({ ...state, status: 'exited', code: 0, ended: Date.now() });
		assert.equal(runs.read('r1')?.status, 'exited');

		writeFileSync(runs.path('r1', 'output.log'), 'abc');
		assert.equal(runs.size('r1'), 3);
		assert.equal(runs.read('nope'), undefined);
		assert.throws(() => runs.path('../x'), /not a run id/);
		assert.throws(() => runs.path('a/b'), /not a run id/);
		assert.deepEqual(new Runs(join(dir, 'none')).list(), []);

		assert.equal(isLive('starting'), true);
		assert.equal(isLive('running'), true);
		for (const s of ['exited', 'stopped', 'failed', 'lost'] as const) assert.equal(isLive(s), false);
		assert.equal(alive(process.pid), true);
		assert.equal(alive(undefined), false);
		assert.equal(alive(deadPid()), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('runs: keep and stop markers, the kept flag, list by folder', () => {
	const dir = temp();
	try {
		const runs = new Runs(dir);
		const a = runs.create(launchOf('/w', 'a'), 'a1');
		runs.write({ ...a, status: 'running', supervisor: process.pid, started: 2 });
		const b = runs.create(launchOf('/w', 'b'), 'b1');
		runs.write({ ...b, status: 'exited', started: 1 });
		const c = runs.create(launchOf('/other', 'c'), 'c1');
		runs.write({ ...c, status: 'exited', started: 0 });
		writeFileSync(join(dir, 'not.a.run'), '');
		mkdirSync(join(dir, 'empty'));

		assert.deepEqual(runs.list().map((r) => r.id), ['c1', 'b1', 'a1']);
		assert.deepEqual(runs.list('/w').map((r) => r.id), ['b1', 'a1']);

		assert.equal(runs.read('a1')?.kept, false);
		runs.mark('a1', 'keep');
		assert.equal(runs.marked('a1', 'keep'), true);
		assert.equal(runs.read('a1')?.kept, true);
		runs.mark('a1', 'keep', false);
		runs.mark('a1', 'keep', false); // twice: no throw
		assert.equal(runs.read('a1')?.kept, false);

		assert.equal(runs.marked('a1', 'stop'), false);
		runs.mark('a1', 'stop');
		assert.equal(runs.marked('a1', 'stop'), true);

		// Orphans: live, not kept, in the folder.
		assert.deepEqual(orphans(runs, '/w').map((r) => r.id), ['a1']);
		assert.deepEqual(orphans(runs, '/').map((r) => r.id), ['a1']);
		assert.deepEqual(orphans(runs, '/other').map((r) => r.id), []);
		runs.mark('a1', 'keep');
		assert.deepEqual(orphans(runs, '/w'), []);

		runs.remove('b1');
		assert.equal(existsSync(join(dir, 'b1')), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('runs: prune keeps the newest N ended runs of the folder, and every live one', () => {
	const dir = temp();
	try {
		const runs = new Runs(dir);
		for (let i = 0; i < 5; i++) {
			const s = runs.create(launchOf('/w'), `e${i}`);
			runs.write({ ...s, status: i % 2 ? 'stopped' : 'exited', started: 100 + i, ended: 200 + i });
		}
		const live = runs.create(launchOf('/w'), 'live');
		runs.write({ ...live, status: 'running', supervisor: process.pid, started: 1 });
		const other = runs.create(launchOf('/other'), 'other');
		runs.write({ ...other, status: 'exited', started: 0 });

		assert.deepEqual(runs.prune('/w', 2), ['e0', 'e1', 'e2']);
		assert.deepEqual(runs.list().map((r) => r.id), ['other', 'live', 'e3', 'e4']);
		assert.deepEqual(runs.prune('/w', 2), []);
		assert.deepEqual(runs.prune('/w', 0), ['e3', 'e4']);
		assert.deepEqual(runs.list().map((r) => r.id), ['other', 'live']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('tail: lines across chunks, \\r starts the line over, colours out, a cap', () => {
	const t = new Tail();
	assert.equal(t.text(), '');
	t.push('a\nb');
	assert.equal(t.text(), 'a\nb\n');
	assert.equal(t.count(), 1);
	t.push('c\r\nd\n');
	assert.equal(t.text(), 'a\nbc\nd\n');
	assert.equal(t.count(), 3);

	const bar = new Tail();
	bar.push('progress 10%\rprogress 50%');
	assert.equal(bar.text(), 'progress 50%\n');
	bar.push('\rdone\n');
	assert.equal(bar.text(), 'done\n');

	const split = new Tail();
	split.push('a\r');
	split.push('\nb\n');
	assert.equal(split.text(), 'a\nb\n', 'a \\r\\n cut between two chunks');

	const colour = new Tail();
	colour.push('\x1b[31mred\x1b[0m \x1b]0;title\x07plain\x1b[2K\n');
	assert.equal(colour.text(), 'red plain\n');
	// An escape cut between chunks waits for the rest.
	colour.push('x\x1b[3');
	assert.equal(colour.text(), 'red plain\nx\n');
	colour.push('2mgreen\x1b[0m\n');
	assert.equal(colour.text(), 'red plain\nxgreen\n');

	const ctl = new Tail();
	ctl.push('a\tb\x07\x00c\x7f\tz\n');
	assert.equal(ctl.text(), 'a   bc  z\n');
	ctl.push('héllo ✓\n');
	assert.equal(ctl.text(), 'a   bc  z\nhéllo ✓\n');

	const capped = new Tail(3);
	capped.push('1\n2\n3\n4\n5\n');
	assert.equal(capped.text(), '3\n4\n5\n');
	assert.equal(capped.count(), 5);
	capped.push('6');
	assert.equal(capped.text(), '4\n5\n6\n');
	assert.equal(capped.count(), 5);

	assert.equal(stripAnsi('\x1b[1;32mok\x1b[0m \x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\'), 'ok link');
});

// CLI --------------------------------------------------------------------------------

test('run args: commands, options, ids', () => {
	assert.deepEqual(parseRunArgs([]), { command: 'help', ids: [], all: false, adopt: false });
	assert.deepEqual(parseRunArgs(['start', '--folder', '/w/../w', '--config', 'saved:x', '--file', 'a.ts', '--line', '12']), {
		command: 'start', ids: [], folder: '/w', config: 'saved:x', file: 'a.ts', line: 12, all: false, adopt: false,
	});
	assert.deepEqual(parseRunArgs(['stop', 'a', 'b', '--all']), { command: 'stop', ids: ['a', 'b'], all: true, adopt: false });
	assert.equal(parseRunArgs(['ps', '--adopt']).adopt, true);
	assert.equal(parseRunArgs(['list', '--file', '']).file, undefined);
	assert.equal(parseRunArgs(['list', '--line', 'x']).line, undefined);
	assert.throws(() => parseRunArgs(['list', '--folder']), (e: Error) => e instanceof RunConfigError && /--folder needs a value/.test(e.message));
	assert.throws(() => parseRunArgs(['list', '--nope']), /unknown option --nope/);
});

test('run commands in-process: save, list, ps, keep, remove, errors', async () => {
	const dir = temp();
	try {
		const ws = join(dir, 'ws');
		files(ws, { 'package.json': JSON.stringify({ scripts: { dev: 'node app.js' } }), 'web/package.json': JSON.stringify({ scripts: { dev: 'vite' } }) });
		const runs = new Runs(join(dir, 'runs'));
		const args = (a: Partial<RunArgs> & { command: string }): RunArgs => ({ ids: [], all: false, adopt: false, ...a });

		assert.deepEqual((await runCommand(args({ command: 'save', folder: ws, config: 'npm::dev' }), runs)).out, { ok: true, saved: 'dev', file: join(ws, '.symbiosis/run.json') });
		assert.equal((await runCommand(args({ command: 'save', folder: ws, config: 'npm::dev' }), runs)).out.saved, 'dev (2)');
		assert.equal((await runCommand(args({ command: 'save', folder: ws, config: 'npm:web:dev' }), runs)).out.saved, 'web: dev');
		assert.deepEqual(parseRunJson(readFileSync(join(ws, '.symbiosis/run.json'), 'utf8')).configs.map((c) => [c.id, commandLine(c), c.cwd]), [
			['saved:dev', 'npm run dev', undefined],
			['saved:dev (2)', 'npm run dev', undefined],
			['saved:web: dev', 'npm run dev', 'web'],
		]);
		await assert.rejects(runCommand(args({ command: 'save', folder: ws, config: 'nope' }), runs), /no configuration "nope"/);

		const list = (await runCommand(args({ command: 'list', folder: ws }), runs)).out as { configs: { id: string }[]; runs: RunState[]; folder: string };
		assert.equal(list.folder, ws);
		assert.deepEqual(list.configs.map((c) => c.id).slice(0, 3), ['saved:dev', 'saved:dev (2)', 'saved:web: dev']);
		assert.deepEqual(list.runs, []);

		const s = runs.create(launchOf(ws), 'k1');
		runs.write({ ...s, status: 'running', supervisor: process.pid });
		const ended = runs.create(launchOf(ws), 'k2');
		runs.write({ ...ended, status: 'exited', code: 0 });
		assert.deepEqual((await runCommand(args({ command: 'keep', ids: ['k1', 'ghost'] }), runs)).out, { ok: true, kept: ['k1', 'ghost'] });
		assert.equal(runs.marked('k1', 'keep'), true);
		assert.equal(existsSync(join(runs.dir, 'ghost')), false);
		const ps = (await runCommand(args({ command: 'ps', folder: ws, adopt: true }), runs)).out.runs as RunState[];
		assert.deepEqual(ps.map((r) => r.kept), [false, false]);
		assert.equal(runs.marked('k1', 'keep'), false);

		assert.deepEqual((await runCommand(args({ command: 'remove', ids: ['k1', 'k2', 'ghost'] }), runs)).out, { ok: true, removed: ['k2'] });
		assert.equal(existsSync(runs.path('k1')), true);
		assert.equal(existsSync(runs.path('k2')), false);

		// askStopRuns: with no terminal to ask, the runs go on.
		await askStopRuns(ws, undefined, runs);
		assert.equal(runs.read('k1')?.status, 'running');

		await assert.rejects(runCommand(args({ command: 'stop', all: true }), runs), /stop --all needs --folder/);
		await assert.rejects(runCommand(args({ command: 'start', folder: ws }), runs), /start needs --config/);
		await assert.rejects(runCommand(args({ command: 'again', ids: ['nope'] }), runs), /no run nope/);
		await assert.rejects(runCommand(args({ command: 'bogus' }), runs), /unknown command "bogus"/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// End to end: bin/symbiosis run ...

type Out = { ok: boolean; error?: string; [k: string]: unknown };

test('symbiosis run: list, start, ps, stop, again, keep, adopt, remove', async () => {
	const dir = temp();
	const ws = join(dir, 'ws');
	const runsDir = join(dir, 'runs');
	const cli = (...argv: string[]): { out: Out; code: number | null } => {
		const r = spawnSync(join(root, 'bin/symbiosis'), ['run', ...argv], { env: { ...process.env, SYMBIOSIS_RUNS: runsDir }, encoding: 'utf8', timeout: 15000 });
		assert.equal(r.stderr, '', r.stderr);
		return { out: JSON.parse(r.stdout) as Out, code: r.status };
	};
	const ps = (): RunState[] => cli('ps', '--folder', ws).out.runs as RunState[];
	const until = async (id: string, done: (s: RunState) => boolean): Promise<RunState> => {
		const end = Date.now() + 10000;
		for (;;) {
			const s = ps().find((r) => r.id === id);
			if (s && done(s)) return s;
			if (Date.now() > end) assert.fail(`run ${id}: ${JSON.stringify(s)}`);
			await delay(100);
		}
	};
	try {
		files(ws, {
			'.symbiosis/run.json': JSON.stringify({
				configurations: [
					{ name: 'fails', command: process.execPath, args: ['-e', "console.log('hello out'); console.error('to err'); process.exit(3)"] },
					{ name: 'sleeper', command: 'sleep 30' },
					{ name: 'where', command: 'echo "$(pwd -P) $FOO"', cwd: '${workspaceFolder}/sub', env: { FOO: 'bar' } },
				],
			}),
			'sub/x': '',
			'app.js': '',
		});

		const list = cli('list', '--file', join(ws, 'app.js'), '--folder', ws);
		assert.equal(list.code, 0);
		assert.equal(list.out.ok, true);
		assert.equal(list.out.folder, ws);
		assert.deepEqual(list.out.problems, []);
		assert.deepEqual(list.out.runs, []);
		const configs = list.out.configs as { id: string; line: string; cwd: string }[];
		assert.deepEqual(configs.map((c) => c.id), ['saved:fails', 'saved:sleeper', 'saved:where', 'file']);
		assert.equal(configs[1].line, 'sleep 30');
		assert.equal(configs[3].line, `node ${join(ws, 'app.js')}`);
		assert.equal(configs[2].cwd, '${workspaceFolder}/sub');

		// Errors: { ok: false }, exit 2.
		const bad = cli('start', '--folder', ws, '--config', 'saved:nope');
		assert.deepEqual(bad, { out: { ok: false, error: `no configuration "saved:nope" in ${ws}` }, code: 2 });
		assert.equal(cli('ps', '--bogus').code, 2);

		// A program that prints and exits 3.
		const started = cli('start', '--folder', ws, '--config', 'saved:fails');
		assert.equal(started.code, 0);
		const fid = (started.out.run as RunState).id;
		assert.equal((started.out.run as RunState).status, 'starting');
		const failed = await until(fid, (s) => !isLive(s.status));
		assert.equal(failed.status, 'exited');
		assert.equal(failed.code, 3);
		assert.equal(failed.configId, 'saved:fails');
		assert.equal(failed.cwd, ws);
		const tail = readFileSync(join(runsDir, fid, 'tail.txt'), 'utf8');
		assert.match(tail, /hello out/);
		assert.match(tail, /to err/);
		assert.match(readFileSync(join(runsDir, fid, 'output.log'), 'utf8'), /hello out/);

		// cwd and env.
		const where = (cli('start', '--folder', ws, '--config', 'saved:where').out.run as RunState).id;
		assert.equal((await until(where, (s) => !isLive(s.status))).code, 0);
		assert.equal(readFileSync(join(runsDir, where, 'tail.txt'), 'utf8'), `${join(ws, 'sub')} bar\n`);

		// again: a new run of the same launch; the old one is gone.
		const again = cli('again', fid);
		const aid = (again.out.run as RunState).id;
		assert.notEqual(aid, fid);
		assert.equal(existsSync(join(runsDir, fid)), false);
		assert.equal((await until(aid, (s) => !isLive(s.status))).code, 3);

		// A long-running one, stopped.
		const sid = (cli('start', '--folder', ws, '--config', 'saved:sleeper').out.run as RunState).id;
		const running = await until(sid, (s) => s.status === 'running' && s.pid !== undefined);
		assert.equal(alive(running.pid), true);
		const stop = cli('stop', sid);
		assert.equal(stop.code, 0);
		const stopped = (stop.out.runs as RunState[])[0];
		assert.equal(stopped.status, 'stopped');
		assert.equal(stopped.signal, 'SIGTERM');
		assert.equal(alive(running.pid), false);
		assert.equal((await until(sid, (s) => !isLive(s.status))).status, 'stopped');

		// keep, then ps --adopt forgets it; remove refuses a live run.
		const kid = (cli('start', '--folder', ws, '--config', 'saved:sleeper').out.run as RunState).id;
		await until(kid, (s) => s.status === 'running');
		assert.deepEqual(cli('keep', kid).out, { ok: true, kept: [kid] });
		assert.equal(ps().find((r) => r.id === kid)?.kept, true);
		const adopted = cli('ps', '--folder', ws, '--adopt').out.runs as RunState[];
		assert.equal(adopted.find((r) => r.id === kid)?.kept, false);
		assert.equal(existsSync(join(runsDir, kid, 'keep')), false);
		assert.equal(ps().find((r) => r.id === kid)?.kept, false);
		assert.deepEqual(cli('remove', kid, aid).out, { ok: true, removed: [aid] });
		assert.equal(existsSync(join(runsDir, kid)), true);
		assert.equal(existsSync(join(runsDir, aid)), false);

		// Starting a config again stops its run first: one run per config.
		const k2 = (cli('start', '--folder', ws, '--config', 'saved:sleeper').out.run as RunState).id;
		assert.equal(ps().find((r) => r.id === kid)?.status, 'stopped');
		await until(k2, (s) => s.status === 'running');

		const all = cli('stop', '--folder', ws, '--all');
		assert.deepEqual((all.out.runs as RunState[]).map((r) => [r.id, r.status]), [[k2, 'stopped']]);
		assert.deepEqual(ps().filter((r) => isLive(r.status)), []);
	} finally {
		spawnSync(join(root, 'bin/symbiosis'), ['run', 'stop', '--folder', ws, '--all'], { env: { ...process.env, SYMBIOSIS_RUNS: runsDir } });
		rmSync(dir, { recursive: true, force: true });
	}
});

// Review fixes ------------------------------------------------------------------------

test('shell lines: values quoted for where they land; unknown ${...} stay for the shell', () => {
	const ctx = { folder: '/w s', file: "/w s/it's; touch PWNED #.txt", line: 3, env: { A: 'x"y', E: '' } };
	assert.equal(expandShell("cat '${file}'", ctx), "cat '/w s/it'\\''s; touch PWNED #.txt'");
	assert.equal(expandShell('cat "${file}"', ctx), 'cat "/w s/it\'s; touch PWNED #.txt"');
	assert.equal(expandShell('cat ${file}', ctx), "cat '/w s/it'\\''s; touch PWNED #.txt'");
	assert.equal(expandShell('echo "${env:A}" ${lineNumber}${env:E} \\${file}', ctx), 'echo "x\\"y" 3 \\${file}');
	assert.equal(expandShell('puma -p ${PORT:-5000} -C ${workspaceFolder}/c', ctx), "puma -p ${PORT:-5000} -C '/w s'/c");
	assert.equal(expandShell('echo ${filename}', { folder: '/w', env: {} }), 'echo ${filename}');
	assert.throws(() => expandShell('cat ${file}', { folder: '/w', env: {} }), /no file is open/);
	// $(...) and `...` start bare again, inside "..." too.
	const sub = { folder: '/w', env: { V: 'x; touch PWNED' } };
	assert.equal(expandShell('echo "$(echo ${env:V})"', sub), `echo "$(echo 'x; touch PWNED')"`);
	assert.equal(expandShell('echo "`echo ${env:V}`"', sub), `echo "\`echo 'x; touch PWNED'\`"`);
	assert.equal(expandShell('echo $(f "${env:V}") $(( (1) )) ${env:V}', sub), `echo $(f "x; touch PWNED") $(( (1) )) 'x; touch PWNED'`);
	assert.equal(expandShell(`echo '$(' \${env:V}`, sub), `echo '$(' 'x; touch PWNED'`, "'$(' is no substitution");
	// What sh makes of it: the value as it is, in every place, and nothing run.
	const dir = temp();
	const hostile = { folder: dir, env: { V: 'x; touch PWNED $(touch P2) `touch P3` "q \\ b\'' } };
	const V = hostile.env.V;
	const words = `${V.split(' ').join('|')}|`;
	// An unquoted $(...) is split into words: sh's, not an injection.
	const places: [string, string][] = [
		['${env:V}', `${V}|`], ['"${env:V}"', `${V}|`], ["'${env:V}'", `${V}|`],
		['"$(echo ${env:V})"', `${V}|`], ['"`echo ${env:V}`"', `${V}|`],
		['`echo "${env:V}"`', words], ["$(echo '${env:V}')", words],
	];
	for (const [place, out] of places) {
		const r = spawnSync('/bin/sh', ['-c', `printf '%s|' ${expandShell(place, hostile)}`], { cwd: dir, encoding: 'utf8' });
		assert.equal(r.stdout, out, place);
	}
	assert.deepEqual(readdirSync(dir), [], 'nothing ran');
	// Not a shell line: an unknown variable is still an error.
	assert.throws(() => expand('${PORT:-1}', ctx), /not a variable/);
});

test('resolveConfig: a shell line with ${VAR:-x}; the current file is taken as it is', () => {
	const dir = temp();
	try {
		files(dir, { 'a${HOME}.js': '' });
		const ctx = { folder: dir, env: {} };
		const shell: RunConfig = { id: 'saved:x', name: 'x', group: 'Saved', command: 'echo ${PORT:-5} ${workspaceFolderBasename}' };
		assert.equal(resolveConfig(shell, ctx).command, `echo \${PORT:-5} ${dir.split(sep).pop()}`);
		const file = join(dir, 'a${HOME}.js');
		const launch = resolveConfig(currentFileConfig(file), { ...ctx, file });
		assert.deepEqual(launch.args, [file]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('makeTargets: define...endef is no target; a dotted one only when .PHONY', () => {
	const text = '.PHONY: test.unit all\nall: app.o\napp.o: app.c\ndefine foo\nfoo: bar\nendef\ntest.unit:\n\tgo test\nbuild/x: y\nclean:\nX := 1\n%.o: %.c\n';
	assert.deepEqual(makeTargets(text), ['all', 'test.unit', 'clean']);
});

test('parseJsonc: trailing commas before comments, commas in strings stay', () => {
	assert.deepEqual(parseJsonc('{"a": ["x,", "y" , /* c */ ], "b": "],", // d\n}', 't'), { a: ['x,', 'y'], b: '],' });
});

test('runs: orphans by session, else by folder either way; pruneOld; a long line is cut', () => {
	const dir = temp();
	try {
		const runs = new Runs(join(dir, 'runs'));
		const live = (id: string, folder: string, session?: string) => {
			const s = runs.create(launchOf(folder), id, session);
			runs.write({ ...s, status: 'running', supervisor: process.pid });
		};
		live('a1', '/w', 's1');
		live('b1', '/w/sub', 's2');
		live('c1', '/x');
		assert.deepEqual(orphans(runs, '/w', 's1').map((r) => r.id), ['a1']);
		assert.deepEqual(orphans(runs, '/w/sub').map((r) => r.id).sort(), ['a1', 'b1']);
		assert.deepEqual(orphans(runs, '/w/sub/deeper').map((r) => r.id).sort(), ['a1', 'b1']);

		const old = runs.create(launchOf('/y'), 'old1');
		runs.write({ ...old, status: 'exited', ended: Date.now() - MAX_AGE_MS - 1 });
		const fresh = runs.create(launchOf('/y'), 'new1');
		runs.write({ ...fresh, status: 'exited', ended: Date.now() });
		assert.deepEqual(runs.pruneOld(), ['old1']);
		assert.equal(existsSync(runs.path('new1')), true);

		const tail = new Tail(3);
		tail.push('x'.repeat(LINE_MAX + 100));
		tail.push('\nok\n');
		assert.equal(tail.text(), `${'x'.repeat(LINE_MAX)}\nok\n`);
		for (let i = 0; i < 10; i++) tail.push(`${i}\n`);
		assert.equal(tail.text(), '7\n8\n9\n');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('symbiosis run: --runs, a stop while starting, SIGKILL for a group that ignores SIGTERM, sessions', async () => {
	const dir = temp();
	const ws = join(dir, 'ws');
	const runsDir = join(dir, 'runs');
	const runs = new Runs(runsDir);
	const cli = (env: Record<string, string>, ...argv: string[]) => {
		const r = spawnSync(join(root, 'bin/symbiosis'), ['run', ...argv, '--runs', runsDir], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000 });
		assert.equal(r.stderr, '', r.stderr);
		return JSON.parse(r.stdout) as Record<string, unknown>;
	};
	const until = async (id: string, done: (s: RunState) => boolean): Promise<RunState> => {
		const end = Date.now() + 10000;
		for (;;) {
			const s = runs.read(id);
			if (s && done(s)) return s;
			if (Date.now() > end) assert.fail(`run ${id}: ${JSON.stringify(s)}`);
			await delay(50);
		}
	};
	try {
		files(dir, { 'ws/.git/HEAD': '' });
		files(ws, {
			'.symbiosis/run.json': JSON.stringify({
				configurations: [
					{ name: 'port', command: 'echo port=${PORT:-5000}' },
					{ name: 'stubborn', command: "trap '' TERM; sleep 30 & sleep 30 & wait" },
				],
			}),
		});
		// SYMBIOSIS_RUNS points elsewhere: --runs wins.
		const env = { SYMBIOSIS_RUNS: join(dir, 'elsewhere'), SYMBIOSIS_SESSION: 'sess-1' };
		const port = (cli(env, 'start', '--folder', ws, '--config', 'saved:port').run as RunState).id;
		assert.equal((await until(port, (s) => !isLive(s.status))).code, 0);
		assert.equal(readFileSync(runs.path(port, 'tail.txt'), 'utf8'), 'port=5000\n');
		assert.equal(runs.read(port)?.session, 'sess-1');
		assert.equal(existsSync(join(dir, 'elsewhere')), false);

		// Stopped right after start, before the supervisor knew the pid.
		const quick = (cli(env, 'start', '--folder', ws, '--config', 'saved:stubborn').run as RunState).id;
		const stopped = cli(env, 'stop', quick).runs as RunState[];
		assert.equal(stopped[0].status, 'stopped');
		const q = runs.read(quick)!;
		assert.equal(groupAlive(q.pid), false);

		// A group that ignores SIGTERM: SIGKILL after the grace.
		const stub = (cli(env, 'start', '--folder', ws, '--config', 'saved:stubborn').run as RunState).id;
		const running = await until(stub, (s) => s.status === 'running');
		await delay(200);
		const done = await stopRun(runs, stub, 400);
		assert.equal(done?.status, 'stopped');
		assert.equal(groupAlive(running.pid), false);

		// ps --adopt: the runs that still go are the new session's.
		const again = (cli({ ...env, SYMBIOSIS_SESSION: 'old' }, 'start', '--folder', ws, '--config', 'saved:stubborn').run as RunState).id;
		await until(again, (s) => s.status === 'running');
		cli({ SYMBIOSIS_SESSION: 'old' }, 'keep', again);
		assert.deepEqual(orphans(runs, ws, 'old'), []);
		cli({ SYMBIOSIS_SESSION: 'new' }, 'ps', '--folder', ws, '--adopt');
		assert.deepEqual(orphans(runs, ws, 'new').map((r) => r.id), [again]);
	} finally {
		spawnSync(join(root, 'bin/symbiosis'), ['run', 'stop', '--folder', ws, '--all', '--runs', runsDir], { encoding: 'utf8' });
		rmSync(dir, { recursive: true, force: true });
	}
});

// Inputs ------------------------------------------------------------------------------

test('inputs: run.json "inputs", ${input:id} anywhere in a config; bad ones throw with where and what', () => {
	const text = `{
		"inputs": [
			{ "id": "device", "type": "pick", "description": "Android device", "command": "list-devices", },
			{ "id": "mode", "type": "pickString", "options": ["Debug", { "value": "R", "label": "Release", "detail": "slow", "ready": true }] },
		],
		"configurations": [
			{ "name": "app", "command": "run", "args": ["\${input:device}", "-c", "\${input:mode}"], "env": { "D": "\${input:device}" } },
			{ "name": "plain", "command": "ls" },
		],
	}`;
	const [app, plain] = parseRunJson(text).configs;
	assert.deepEqual(app.inputs, [
		{ id: 'device', description: 'Android device', command: 'list-devices' },
		{ id: 'mode', description: 'mode', options: [{ value: 'Debug', label: 'Debug' }, { value: 'R', label: 'Release', detail: 'slow', ready: true }] },
	]);
	assert.equal(plain.inputs, undefined);
	assert.deepEqual(inputRefs(['a \${input:x} \${input:y}', undefined, '\${input:x}']), ['x', 'y']);
	assert.equal(parseInputs(undefined, 'w').size, 0);
	const bad = (inputs: unknown, re: RegExp, configs: unknown[] = []) =>
		assert.throws(() => parseRunJson(JSON.stringify({ inputs, configurations: configs })), (e: Error) => e instanceof RunConfigError && re.test(e.message), re.source);
	bad({}, /"inputs" must be a list/);
	bad([{ type: 'pick', options: [] }], /inputs\[0\] needs an "id"/);
	bad([{ id: 'a b', type: 'pick', options: [] }], /needs an "id"/);
	bad([{ id: 'a', type: 'promptString', options: [] }], /\("a"\): "type" must be "pick" or "pickString"/);
	bad([{ id: 'a', type: 'pick' }], /needs "options" or a "command", one of them/);
	bad([{ id: 'a', type: 'pick', options: [], command: 'x' }], /one of them/);
	bad([{ id: 'a', type: 'pick', options: [], args: ['x'] }], /"args" go with a "command"/);
	bad([{ id: 'a', type: 'pick', command: 'x', args: [1] }], /inputs\[0\]\.args must be a list of strings/);
	bad([{ id: 'a', type: 'pick', options: [{ label: 'no value' }] }], /options\[0\] needs a "value"/);
	bad([{ id: 'a', type: 'pick', options: ['x', 'x'] }], /the value "x" is there twice/);
	bad([{ id: 'a', type: 'pick', options: ['', 'x'] }], /options\[0\] needs a "value"/);
	bad([{ id: 'a', type: 'pick', command: 'list \${input:b}' }], /\("a"\): its command names an input/);
	bad([{ id: 'a', type: 'pick', command: 'list', args: ['\${input:b}'] }], /\("a"\): its command names an input/);
	bad([{ id: 'a', type: 'pick', options: [] }, { id: 'a', type: 'pick', options: [] }], /the id "a" is used twice/);
	bad([], /configurations\[0\] \("c"\): no input "nope" in "inputs"/, [{ name: 'c', command: 'x', cwd: '\${input:nope}' }]);
});

test('inputs: ${input:id} expands to its value, quoted in a shell line; one with no value is an error', () => {
	const ctx = { folder: '/w', env: {}, inputs: { d: "Todor's iPhone" } };
	assert.equal(expand('-p:Device=\${input:d}', ctx), "-p:Device=Todor's iPhone");
	assert.equal(expandShell('run \${input:d}', ctx), "run 'Todor'\\''s iPhone'");
	assert.throws(() => expand('\${input:x}', ctx), /\$\{input:x\}: no value for this input/);
	assert.throws(() => expandShell('\${input:d}', { folder: '/w', env: {} }), /no value for this input \(inputs come from \.symbiosis\/run\.json\)/);
});

test('inputs: decide takes the remembered one, else the only one, else the only ready one; again asks', () => {
	const a = { value: 'a', label: 'A' };
	const b = { value: 'b', label: 'B', ready: true };
	const c = { value: 'c', label: 'C' };
	assert.equal(decide([a, b, c], 'c'), c);
	assert.equal(decide([a], undefined), a);
	assert.equal(decide([a], 'gone'), a);
	assert.equal(decide([a, b, c], 'gone'), b);
	assert.equal(decide([a, c], undefined), undefined);
	assert.equal(decide([a, b, { ...c, ready: true }], undefined), undefined);
	assert.equal(decide([a, b, c], 'c', true), undefined);
	assert.equal(decide([a], undefined, true), undefined);
});

test('inputs: a command\'s options, in the workspace folder; its failures are RunConfigErrors', async () => {
	const dir = temp();
	try {
		const ctx = { folder: dir, env: { ...process.env, WHO: 'me' } };
		const def = (command: string, args?: string[]) => ({ id: 'd', description: 'device', command, ...(args ? { args } : {}) });
		assert.deepEqual(await listOptions(def(`echo '["x", {"value": "y", "label": "Y", "ready": true}]'`), ctx), [
			{ value: 'x', label: 'x' }, { value: 'y', label: 'Y', ready: true },
		]);
		// args: no shell; variables expand. The folder is the cwd.
		const node = process.execPath;
		assert.deepEqual(await listOptions(def(node, ['-e', 'console.log(JSON.stringify([process.cwd(), process.argv[1]]))', '\${env:WHO}']), ctx), [
			{ value: dir, label: dir }, { value: 'me', label: 'me' },
		]);
		assert.deepEqual(await listOptions({ id: 'm', description: 'm', options: [{ value: 'k', label: 'K' }] }, ctx), [{ value: 'k', label: 'K' }]);
		await assert.rejects(listOptions(def('echo no adb >&2; exit 4'), ctx), /input "d": no adb/);
		await assert.rejects(listOptions(def('exit 4'), ctx), /input "d": exited 4/);
		await assert.rejects(listOptions(def('echo nope'), ctx), /input "d": its command printed no JSON list: nope/);
		await assert.rejects(listOptions(def(`echo '{"value": 1}'`), ctx), /input "d" must be a list/);
		await assert.rejects(listOptions(def('/no/such/program', []), ctx), /\/no\/such\/program: command not found/);
		await assert.rejects(listOptions(def('sleep 5'), ctx, 200), /no answer in 200 ms/);
		await assert.rejects(listOptions(def('kill -9 $$'), ctx), /input "d": killed by SIGKILL/);
		await assert.rejects(listOptions(def('head -c 2000000 /dev/zero | tr "\\0" a'), ctx), /printed more than 1 MB/);
		// No stdin: a command that reads it ends at once.
		const t0 = Date.now();
		await assert.rejects(listOptions(def('cat'), ctx, 5000), /printed no JSON list: \(nothing\)/);
		// What it leaves behind holds its output open: it is done all the same, and that is killed.
		assert.deepEqual(await listOptions(def(`(sleep 7.31 &); echo '["a"]'`), ctx, 5000), [{ value: 'a', label: 'a' }]);
		assert.ok(Date.now() - t0 < 2000, 'neither waited for its timeout');
		// A timeout kills the whole pipeline, not only sh.
		await assert.rejects(listOptions(def('sleep 7.32 | cat'), ctx, 300), /no answer/);
		await delay(100);
		for (const marker of ['sleep 7.31', 'sleep 7.32']) {
			assert.equal(spawnSync('pgrep', ['-f', marker]).status, 1, `${marker} was left running`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('inputs: pickInputs gives, remembers, decides or asks, one input after the other', async () => {
	const dir = temp();
	try {
		const memory = new InputMemory(join(dir, 'inputs.json'));
		const [config] = parseRunJson(JSON.stringify({
			inputs: [
				{ id: 'device', type: 'pick', description: 'device', options: [{ value: 'p1', label: 'Pixel' }, { value: 'p2', label: 'Pixel 2' }] },
				{ id: 'mode', type: 'pick', options: ['Debug'] },
			],
			configurations: [{ name: 'app', command: 'run \${input:device} \${input:mode}' }],
		})).configs;
		const ctx = { folder: dir, env: {} };
		assert.deepEqual(await pickInputs(config, ctx, memory), {
			ask: {
				config: 'saved:app', name: 'app', input: { id: 'device', description: 'device' },
				options: [{ value: 'p1', label: 'Pixel' }, { value: 'p2', label: 'Pixel 2' }], given: {}, labels: {},
			},
		});
		const given = await pickInputs(config, ctx, memory, { device: 'p2' }, { device: 'Pixel 2' });
		assert.deepEqual(given, { values: { device: 'p2', mode: 'Debug' }, picks: { device: { value: 'p2', label: 'Pixel 2' }, mode: { value: 'Debug', label: 'Debug' } } });
		assert.equal(pickedLabels(config, dir, memory), undefined);
		if ('values' in given) memory.set(dir, given.picks);
		assert.equal(pickedLabels(config, dir, memory), 'Pixel 2, Debug');
		assert.equal(pickedLabels(config, join(dir, 'other'), memory), undefined);
		// Remembered; asked again: the user picks, the remembered one marked.
		assert.deepEqual(await pickInputs(config, ctx, memory), { values: { device: 'p2', mode: 'Debug' }, picks: given.picks });
		const again = await pickInputs(config, ctx, memory, {}, {}, true);
		assert.ok('ask' in again);
		assert.equal(again.ask.current, 'p2');
		// Given with no label: the remembered label when the value is the same.
		const noLabel = await pickInputs(config, ctx, memory, { device: 'p2', mode: 'X' });
		assert.ok('picks' in noLabel);
		assert.deepEqual(noLabel.picks, { device: { value: 'p2', label: 'Pixel 2' }, mode: { value: 'X', label: 'X' } });
		// The second input asks once the first is given.
		const second = await pickInputs(config, ctx, memory, { device: 'p1' }, {}, true);
		assert.ok('ask' in second);
		assert.equal(second.ask.input.id, 'mode');
		assert.deepEqual([second.ask.given, second.ask.labels], [{ device: 'p1' }, { device: 'p1' }], 'what to give next time');
		// set keeps the other inputs and folders.
		memory.set(join(dir, 'other'), { device: { value: 'o', label: 'O' } });
		memory.set(dir, { mode: { value: 'Release', label: 'Release' } });
		assert.deepEqual([memory.get(dir, 'device')?.value, memory.get(dir, 'mode')?.value, memory.get(join(dir, 'other'), 'device')?.value], ['p2', 'Release', 'o']);
		// An input decided before the one that asks comes with the ask: given back, its command does not run again.
		const count = join(dir, 'count');
		const [two] = parseRunJson(JSON.stringify({
			inputs: [
				{ id: 'a', type: 'pick', command: `echo x >> '${count}'; echo '["only"]'` },
				{ id: 'b', type: 'pick', options: ['b1', 'b2'] },
			],
			configurations: [{ name: 'two', command: 'run \${input:a} \${input:b}' }],
		})).configs;
		const asked = await pickInputs(two, ctx, memory);
		assert.ok('ask' in asked);
		assert.deepEqual([asked.ask.input.id, asked.ask.given, asked.ask.labels], ['b', { a: 'only' }, { a: 'only' }]);
		const done = await pickInputs(two, ctx, memory, { ...asked.ask.given, b: 'b2' }, { ...asked.ask.labels, b: 'b2' });
		assert.deepEqual('values' in done && done.values, { a: 'only', b: 'b2' });
		assert.equal(readFileSync(count, 'utf8'), 'x\n', "a's command ran once");
		// A value given for no input of the configuration is no matter.
		assert.ok('values' in await pickInputs(two, ctx, memory, { a: 'only', b: 'b1', nope: 'z' }));
		// A memory file that is not JSON is no memory.
		writeFileSync(memory.path, 'nope');
		assert.equal(memory.get(dir, 'device'), undefined);
		const [empty] = parseRunJson(JSON.stringify({ inputs: [{ id: 'd', type: 'pick', description: 'Android device', options: [] }], configurations: [{ name: 'e', command: 'x \${input:d}' }] })).configs;
		await assert.rejects(pickInputs(empty, ctx, memory), /"e": no Android device to pick from/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('symbiosis run: start asks for an input, starts with --input, lists what was picked; --ask asks again', async () => {
	const dir = temp();
	const ws = join(dir, 'ws');
	const runsDir = join(dir, 'runs');
	const cli = (...argv: string[]): Out => {
		const r = spawnSync(join(root, 'bin/symbiosis'), ['run', ...argv], { env: { ...process.env, SYMBIOSIS_RUNS: runsDir }, encoding: 'utf8', timeout: 15000 });
		assert.equal(r.stderr, '', r.stderr);
		return JSON.parse(r.stdout) as Out;
	};
	try {
		files(ws, {
			'.symbiosis/run.json': JSON.stringify({
				inputs: [{ id: 'device', type: 'pick', description: 'device', command: `echo '[{"value":"d1","label":"One"},{"value":"d2","label":"Two"}]'` }],
				configurations: [{ name: 'on', command: 'echo "on ${input:device}"; exec sleep 30' }],
			}),
		});
		const ask = cli('start', '--folder', ws, '--config', 'saved:on');
		assert.deepEqual(ask, {
			ok: true,
			ask: {
				config: 'saved:on', name: 'on', input: { id: 'device', description: 'device' },
				options: [{ value: 'd1', label: 'One' }, { value: 'd2', label: 'Two' }], given: {}, labels: {},
			},
		});
		assert.deepEqual(cli('ps', '--folder', ws).runs, []);
		const started = cli('start', '--folder', ws, '--config', 'saved:on', '--input', 'device=d2', '--input-label', 'device=Two');
		const run = started.run as RunState;
		assert.equal(run.line, 'echo "on d2"; exec sleep 30');
		assert.equal(started.picked, 'Two', 'what it picked, for the picker');
		const listed = (cli('list', '--folder', ws).configs as { id: string; picked?: string }[]).find((c) => c.id === 'saved:on');
		assert.equal(listed?.picked, 'Two');
		assert.deepEqual(JSON.parse(readFileSync(join(dir, 'run-inputs.json'), 'utf8')), { [ws]: { device: { value: 'd2', label: 'Two' } } });
		// Remembered: F5 starts it at once; --ask asks, with the one picked last.
		const again = cli('start', '--folder', ws, '--config', 'saved:on').run as RunState;
		assert.equal(again.line, 'echo "on d2"; exec sleep 30');
		assert.equal((cli('start', '--folder', ws, '--config', 'saved:on', '--ask').ask as { current?: string }).current, 'd2');
		// Asking starts nothing and stops nothing: the run of the configuration goes on.
		const runs = cli('ps', '--folder', ws).runs as RunState[];
		assert.ok(isLive(runs.find((r) => r.id === again.id)!.status), 'the run asking left alone');
		assert.equal(runs.filter((r) => isLive(r.status)).length, 1);
		assert.equal(inputMemory(new Runs(runsDir)).path, join(dir, 'run-inputs.json'));
	} finally {
		spawnSync(join(root, 'bin/symbiosis'), ['run', 'stop', '--folder', ws, '--all'], { env: { ...process.env, SYMBIOSIS_RUNS: runsDir } });
		rmSync(dir, { recursive: true, force: true });
	}
});

test('run args: --input and --input-label are ID=VALUE, repeatable; --ask', () => {
	const a = parseRunArgs(['start', '--input', 'd=x=y', '--input', 'm=Debug', '--input-label', "d=Todor's iPhone", '--ask']);
	assert.deepEqual(a.inputs, { d: 'x=y', m: 'Debug' });
	assert.deepEqual(a.labels, { d: "Todor's iPhone" });
	assert.equal(a.ask, true);
	assert.throws(() => parseRunArgs(['start', '--input', 'novalue']), /--input needs ID=VALUE, not "novalue"/);
	assert.throws(() => parseRunArgs(['start', '--input', '=x']), /needs ID=VALUE/);
	assert.equal(parseRunArgs(['start']).ask, undefined);
});
