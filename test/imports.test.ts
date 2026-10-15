import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolverFor } from '../core/imports/index.ts';
import { fsProject, type Project } from '../core/imports/project.ts';
import { packageName } from '../core/imports/typescript.ts';

/** A project in memory: file path → text. A folder exists when a file is under it. */
function project(files: Record<string, string>, run: Record<string, string> = {}): Project {
	const paths = Object.keys(files);
	return {
		read: (p) => files[p] ?? null,
		exists: (p) => paths.some((f) => f === p || f.startsWith(`${p}/`)),
		list: (dir) => {
			const prefix = dir === '' ? '' : dir.endsWith('/') ? dir : `${dir}/`;
			return [...new Set(paths.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length).split('/')[0]))];
		},
		run: (program) => run[program] ?? null,
	};
}

test('typescript: relative, node builtins, and package.json dependencies', () => {
	const resolves = resolverFor('typescript', project({ 'package.json': JSON.stringify({ dependencies: { '@scope/lib': '1' }, devDependencies: { vitest: '1' } }) }));
	for (const spec of ['./a.ts', '../b', 'node:fs', 'fs/promises', '@scope/lib/sub', 'vitest', '#internal']) assert.ok(resolves(spec, ''), spec);
	for (const spec of ['lodash', '@other/lib', '/etc/passwd']) assert.ok(!resolves(spec, ''), spec);
	assert.equal(packageName('@a/b/c'), '@a/b');
	assert.equal(packageName('a/b'), 'a');
});

test('typescript: a package.json that does not parse declares nothing', () => {
	const resolves = resolverFor('tsx', project({ 'package.json': '{' }));
	assert.ok(!resolves('react', ''));
	assert.ok(resolves('./App', ''));
});

test('kotlin: standard library, own package root, gradle groups', () => {
	const resolves = resolverFor(
		'kotlin',
		project({
			'build.gradle.kts': 'dependencies {\n    implementation("io.ktor:ktor-server-core:2.3.0")\n}\n',
			'gradle/libs.versions.toml': '[libraries]\ngson = { module = "com.google.code.gson:gson", version = "2" }\n',
			'app/build.gradle.kts': 'group = "com.example"\n',
		}),
	);
	const file = 'package org.acme.app\n';
	for (const spec of ['kotlin.math.max', 'java.io.File', 'org.acme.util.Text', 'io.ktor.server.Application', 'com.google.code.gson.Gson', 'com.example.X']) assert.ok(resolves(spec, file), spec);
	for (const spec of ['com.squareup.okhttp3.OkHttp', 'kotlinx.coroutines.launch']) assert.ok(!resolves(spec, file), spec);
});

test('csharp: System, own namespace, PackageReference', () => {
	const resolves = resolverFor('csharp', project({ 'Api/Api.csproj': '<ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13" /></ItemGroup>' }));
	const file = 'namespace Acme.Api\n{\n}\n';
	for (const spec of ['System', 'System.IO', 'Acme.Domain', 'Newtonsoft.Json.Linq']) assert.ok(resolves(spec, file), spec);
	assert.ok(!resolves('Serilog', file));
});

test('go: standard library, own module, go.mod require', () => {
	const mod = 'module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n)\n\nrequire golang.org/x/sync v0.7.0\n\nexclude (\n\tgithub.com/bad/lib v1.0.0\n)\n';
	const resolves = resolverFor('go', project({ 'go.mod': mod }));
	for (const spec of ['fmt', 'net/http', 'example.com/app/internal/db', 'github.com/spf13/cobra', 'golang.org/x/sync/errgroup']) assert.ok(resolves(spec, ''), spec);
	for (const spec of ['github.com/gin-gonic/gin', 'example.com/application', 'github.com/bad/lib']) assert.ok(!resolves(spec, ''), spec);
});

test('python: relative, stdlib from python3, own modules, requirements and pyproject', () => {
	const resolves = resolverFor(
		'python',
		project(
			{
				'requirements.txt': 'requests>=2\n# a comment\nPyYAML==6\n',
				'pyproject.toml':
					'[project]\nclassifiers = [\n  "Typing",\n]\ndependencies = [\n  "Flask-Cors>=4",\n]\n[project.optional-dependencies]\ntest = ["pytest>=8"]\n[tool.poetry.dependencies]\nhttpx = "^0.27"\n[tool.ruff]\nline-length = 100\n',
				'src/app/__init__.py': '',
				'tools.py': '',
				'build/out.txt': '',
			},
			{ python3: 'json\nos\npathlib\n' },
		),
	);
	for (const spec of ['.models', 'os.path', 'json', 'requests', 'flask_cors', 'pytest', 'httpx', 'app.views', 'tools']) assert.ok(resolves(spec, ''), spec);
	// The import name of PyYAML is yaml: it does not resolve (a known limit).
	// `build` is a folder with no Python in it; `typing`'s classifier is not a dependency.
	for (const spec of ['numpy', 'yaml', 'build', 'line_length', 'Typing']) assert.ok(!resolves(spec, ''), spec);
});

test('lua: module files in the project and rockspec dependencies', () => {
	const resolves = resolverFor('lua', project({ 'lua/ui/panel.lua': '', 'core/init.lua': '', 'app-1.0.rockspec': 'dependencies = {\n  "lua >= 5.1",\n  "penlight",\n}\n' }));
	for (const spec of ['ui.panel', 'core', 'penlight']) assert.ok(resolves(spec, ''), spec);
	assert.ok(!resolves('socket', ''));
});

test('a language with no policy resolves nothing', () => {
	assert.ok(!resolverFor('cobol', project({}))('anything', ''));
});

test('fsProject reads the project on disk', () => {
	const root = mkdtempSync(join(tmpdir(), 'symbiosis-imports-'));
	try {
		mkdirSync(join(root, 'pkg'));
		writeFileSync(join(root, 'pkg', 'a.txt'), 'x');
		const p = fsProject(root);
		assert.equal(p.read('pkg/a.txt'), 'x');
		assert.equal(p.read('missing'), null);
		assert.ok(p.exists('pkg'));
		assert.deepEqual(p.list(''), ['pkg']);
		assert.deepEqual(p.list('missing'), []);
		assert.equal(p.run('no-such-program-symbiosis', []), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
