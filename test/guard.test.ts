import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { type Allowance, type GuardInput, guard, type Scope } from '../core/guard.ts';
import type { Resolver } from '../core/imports/policy.ts';
import { stubRef } from '../core/stubs.ts';
import { syntaxFor } from '../core/syntax/parse.ts';

const FIXTURES = new URL('./fixtures/stubs/', import.meta.url);
/** In these tests the project has node's modules and kotlin's standard library. */
const resolves: Resolver = (spec) => spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('kotlin.') || spec.startsWith('java.');

interface Case {
	file: string;
	stub: string;
	/** The file after the call, from the fixture's text. */
	change: (text: string) => string;
	scope?: Scope;
	allowances?: Allowance[];
	/** The path the call changes, when not the stub's file; `before` null makes it a new file. */
	other?: { path: string; before: string | null };
	/** The file before the call, in place of the fixture's text (the fixture still names the language). */
	source?: string;
	resolves?: Resolver;
}

async function check(c: Case) {
	const path = new URL(c.file, FIXTURES).pathname;
	const syntax = await syntaxFor(path);
	assert.ok(syntax);
	const text = c.source ?? readFileSync(path, 'utf8');
	const outline = syntax.outline(text);
	const fn = outline.functions.find((f) => f.name === c.stub && f.stub);
	assert.ok(fn, `no stub ${c.stub}`);
	const stub = stubRef(path, text, fn);
	const after = c.change(text);
	const input: GuardInput = {
		scope: c.scope ?? 'stub',
		target: stub,
		path: c.other?.path ?? path,
		before: c.other ? (c.other.before === null ? null : { text: c.other.before, outline: null }) : { text, outline },
		after: { text: after, outline: c.other ? null : syntax.outline(after) },
		resolves: c.resolves ?? resolves,
		allowances: c.allowances ?? [],
	};
	return guard(input);
}

const kinds = (r: { violations: { kind: string }[] }) => r.violations.map((v) => v.kind);

// TypeScript ---------------------------------------------------------------

const TS_FILL = (text: string) =>
	text.replace("\t// TODO(pi)\n\tthrow new Error('not written');", "\tconst data = await readFile(path, 'utf8');\n\treturn data.split('\\n').map(Number).reduce((a, b) => a + b, 0);");

test('ts: a fill inside the body is allowed', async () => {
	const r = await check({ file: 'sample.ts', stub: 'sumFile', change: TS_FILL });
	assert.equal(r.ok, true, r.reason);
	assert.equal(r.reason, '');
});

test('ts: a local helper inside the body is allowed', async () => {
	const r = await check({
		file: 'sample.ts',
		stub: 'sumFile',
		change: (t) => t.replace("throw new Error('not written');", "const add = (a: number, b: number) => a + b;\n\tfunction parse(s: string) { return Number(s); }\n\treturn [1].map(parse).reduce(add, 0);"),
	});
	assert.equal(r.ok, true, r.reason);
});

test('ts: a changed signature is blocked', async () => {
	const r = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => TS_FILL(t).replace('sumFile(path: string)', 'sumFile(path: string, limit: number)') });
	assert.deepEqual(kinds(r), ['signature']);
	assert.match(r.reason, /propose with kind "signature", target "sumFile"/);
});

test('ts: an accepted signature change goes through and moves the stub', async () => {
	const r = await check({
		file: 'sample.ts',
		stub: 'sumFile',
		allowances: [{ kind: 'signature', target: 'sumFile' }],
		change: (t) => TS_FILL(t).replace('sumFile(path: string)', 'sumFile(path: string, limit: number)'),
	});
	assert.equal(r.ok, true, r.reason);
	assert.deepEqual(r.used, [{ kind: 'signature', target: 'sumFile' }]);
	assert.match((r.target?.kind === 'stub' ? r.target.signature : '') ?? '', /limit: number/);
});

test('ts: an edit outside the body is blocked', async () => {
	const r = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => TS_FILL(t).replace('const LIMIT = 10;', 'const LIMIT = 20;') });
	assert.deepEqual(kinds(r), ['outside_edit']);
	assert.match(r.reason, /LIMIT = 20/);
});

test('ts: filling another stub is outside this one', async () => {
	const r = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => t.replace('\t\t// TODO(pi)\n\t}', '\t\tthis.size++;\n\t}') });
	assert.deepEqual(kinds(r), ['outside_edit']);
});

test('ts: a re-indent outside the body is not a change', async () => {
	const r = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => TS_FILL(t).replace('const LIMIT = 10;', 'const  LIMIT =\n\t10;') });
	assert.equal(r.ok, true, r.reason);
});

const NEW_HELPER = "\nfunction parseLine(s: string): number {\n\treturn Number(s);\n}\n";
const EXPORTED = "\n/** Parse one line. */\nexport function parseLine(s: string): number {\n\treturn Number(s);\n}\n";

test('ts: a new top-level declaration is blocked in stub scope', async () => {
	const r = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => TS_FILL(t) + NEW_HELPER });
	assert.deepEqual(kinds(r), ['new_decl']);
	assert.match(r.reason, /parseLine/);
});

test('ts: file scope allows a new private declaration, not an exported one', async () => {
	const priv = await check({ file: 'sample.ts', stub: 'sumFile', scope: 'file', change: (t) => TS_FILL(t) + NEW_HELPER });
	assert.equal(priv.ok, true, priv.reason);
	const pub = await check({ file: 'sample.ts', stub: 'sumFile', scope: 'file', change: (t) => TS_FILL(t) + EXPORTED });
	assert.deepEqual(kinds(pub), ['new_decl']);
});

test('ts: a new method in the class is a new declaration', async () => {
	const r = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => TS_FILL(t).replace('\tget(key', '\tclear(): void {\n\t\tthis.size = 0;\n\t}\n\n\tget(key') });
	assert.deepEqual(kinds(r), ['new_decl']);
});

test('ts: a new import that resolves is allowed; an unknown package is a dependency', async () => {
	const ok = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => "import { join } from 'node:path';\n" + TS_FILL(t) });
	assert.equal(ok.ok, true, ok.reason);
	const dep = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => "import { sum } from 'lodash';\n" + TS_FILL(t) });
	assert.deepEqual(kinds(dep), ['dependency']);
	assert.match(dep.reason, /lodash/);
});

test('ts: an accepted dependency is spent on one call', async () => {
	const lodash = { kind: 'dependency', target: 'lodash' } as const;
	const r = await check({ file: 'sample.ts', stub: 'sumFile', allowances: [lodash], change: (t) => "import { sum } from 'lodash';\n" + TS_FILL(t) });
	assert.equal(r.ok, true, r.reason);
	assert.deepEqual(r.used, [lodash]);
});

test('ts: an allowance lets only its own target through', async () => {
	const r = await check({ file: 'sample.ts', stub: 'sumFile', allowances: [{ kind: 'dependency', target: 'ramda' }], change: (t) => "import { sum } from 'lodash';\n" + TS_FILL(t) });
	assert.deepEqual(kinds(r), ['dependency']);
	assert.deepEqual(r.used, []);
	assert.match(r.reason, /target `lodash`/);
});

test('ts: one allowance covers every violation of its kind and target in one call', async () => {
	const change = (t: string) => TS_FILL(t).replace("import { helper } from './helper.ts';\n", '').replace('const LIMIT = 10;', 'const LIMIT = 20;');
	const blocked = await check({ file: 'sample.ts', stub: 'sumFile', change });
	assert.deepEqual(kinds(blocked), ['outside_edit', 'outside_edit']);
	const allowance = { kind: 'outside_edit', target: blocked.violations[0].target } as const;
	const r = await check({ file: 'sample.ts', stub: 'sumFile', allowances: [allowance], change });
	assert.equal(r.ok, true, r.reason);
	assert.deepEqual(r.used, [allowance]);
});

test('ts: a removed import is outside the body', async () => {
	const r = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => TS_FILL(t).replace("import { helper } from './helper.ts';\n", '') });
	assert.deepEqual(kinds(r), ['outside_edit']);
});

test('ts: a write that rewrites the file is checked as an edit', async () => {
	// The whole file again: the body filled and a comment added at the top.
	const blocked = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => `// Rewritten.\n${TS_FILL(t)}` });
	assert.deepEqual(kinds(blocked), ['outside_edit']);
	const allowed = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => TS_FILL(t) });
	assert.equal(allowed.ok, true);
});

test('another file: a new one and an existing one', async () => {
	const created = await check({ file: 'sample.ts', stub: 'sumFile', change: () => 'export {}', other: { path: '/tmp/x.ts', before: null } });
	assert.deepEqual(kinds(created), ['new_file']);
	const edited = await check({ file: 'sample.ts', stub: 'sumFile', change: () => 'b', other: { path: '/tmp/notes.md', before: 'a' } });
	assert.deepEqual(kinds(edited), ['outside_edit']);
});

test('scope off lets everything through', async () => {
	const r = await check({ file: 'sample.ts', stub: 'sumFile', scope: 'off', change: (t) => `${t}\nexport const x = 1;\n` });
	assert.equal(r.ok, true);
});

test('several violations are all named, each with its kind', async () => {
	const r = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => "import { sum } from 'lodash';\n" + TS_FILL(t).replace('const LIMIT = 10;', 'const LIMIT = 20;') + NEW_HELPER });
	assert.deepEqual(kinds(r).sort(), ['dependency', 'new_decl', 'outside_edit']);
	// An allowance for one kind does not let the call through while another blocks.
	const partly = await check({ file: 'sample.ts', stub: 'sumFile', allowances: [{ kind: 'dependency', target: 'lodash' }], change: (t) => "import { sum } from 'lodash';\n" + TS_FILL(t) + NEW_HELPER });
	assert.deepEqual(kinds(partly), ['new_decl']);
	assert.deepEqual(partly.used, []);
});

// Kotlin -------------------------------------------------------------------

const KT_FILL = (text: string) => text.replace('    // TODO(pi)\n    TODO()', '    return File(path).readLines().sumOf { it.trim().toInt() }');

test('kt: a fill inside the body is allowed', async () => {
	const r = await check({ file: 'sample.kt', stub: 'sumFile', change: KT_FILL });
	assert.equal(r.ok, true, r.reason);
});

test('kt: a changed signature is blocked', async () => {
	const r = await check({ file: 'sample.kt', stub: 'sumFile', change: (t) => KT_FILL(t).replace('fun sumFile(path: String): Int', 'fun sumFile(path: String): Long') });
	assert.deepEqual(kinds(r), ['signature']);
});

test('kt: an edit outside the body is blocked', async () => {
	const r = await check({ file: 'sample.kt', stub: 'sumFile', change: (t) => KT_FILL(t).replace('LIMIT = 10', 'LIMIT = 11') });
	assert.deepEqual(kinds(r), ['outside_edit']);
});

test('kt: a new top-level function is blocked; a private one passes in file scope', async () => {
	const helper = '\nprivate fun parse(s: String): Int = s.trim().toInt()\n';
	const stub = await check({ file: 'sample.kt', stub: 'sumFile', change: (t) => KT_FILL(t) + helper });
	assert.deepEqual(kinds(stub), ['new_decl']);
	const file = await check({ file: 'sample.kt', stub: 'sumFile', scope: 'file', change: (t) => KT_FILL(t) + helper });
	assert.equal(file.ok, true, file.reason);
	const pub = await check({ file: 'sample.kt', stub: 'sumFile', scope: 'file', change: (t) => KT_FILL(t) + '\nfun parse(s: String): Int = s.toInt()\n' });
	assert.deepEqual(kinds(pub), ['new_decl']);
});

test('kt: imports: the standard library resolves, an unknown package does not', async () => {
	const ok = await check({ file: 'sample.kt', stub: 'sumFile', change: (t) => KT_FILL(t).replace('import java.io.File', 'import java.io.File\nimport kotlin.math.min') });
	assert.equal(ok.ok, true, ok.reason);
	const dep = await check({ file: 'sample.kt', stub: 'sumFile', change: (t) => KT_FILL(t).replace('import java.io.File', 'import java.io.File\nimport com.google.gson.Gson') });
	assert.deepEqual(kinds(dep), ['dependency']);
});

test('kt: a local function inside the body is allowed', async () => {
	const r = await check({
		file: 'sample.kt',
		stub: 'sumFile',
		change: (t) => t.replace('    // TODO(pi)\n    TODO()', '    fun parse(s: String) = s.trim().toInt()\n    return File(path).readLines().sumOf(::parse)'),
	});
	assert.equal(r.ok, true, r.reason);
});

test('kt: the stub in a class: a fill is allowed, a new member is not', async () => {
	const fill = (t: string) => t.replace('        // TODO(pi)\n    }', '        size += value\n    }');
	const r = await check({ file: 'sample.kt', stub: 'put', change: fill });
	assert.equal(r.ok, true, r.reason);
	const member = await check({ file: 'sample.kt', stub: 'put', change: (t) => fill(t).replace('    fun get(', '    fun clear() { size = 0 }\n\n    fun get(') });
	assert.deepEqual(kinds(member), ['new_decl']);
});

// Imports: a changed line counts as removed ----------------------------------

test('ts: an import line that changes is blocked, even with the same module', async () => {
	const rebind = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => TS_FILL(t).replace('{ helper }', '{ evil as helper }') });
	assert.deepEqual(kinds(rebind), ['outside_edit']);
	assert.match(rebind.reason, /add a new import line instead/);
	const added = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => TS_FILL(t).replace('{ helper }', '{ helper, other }') });
	assert.deepEqual(kinds(added), ['outside_edit']);
});

test('ts: an import() or require() inside the body must resolve', async () => {
	const dynamic = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => t.replace("throw new Error('not written');", "const pad = await import('left-pad');\n\treturn 0;") });
	assert.deepEqual(kinds(dynamic), ['dependency']);
	const node = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => t.replace("throw new Error('not written');", "const fs = require('node:fs');\n\treturn 0;") });
	assert.equal(node.ok, true, node.reason);
});

test('ts: a new declaration under an old section comment leaves the comment', async () => {
	const source = '// Helpers.\nfunction a() {\n\t// TODO(pi)\n}\n';
	const r = await check({ file: 'sample.ts', source, stub: 'a', scope: 'file', change: (t) => t.replace('// Helpers.\n', '// Helpers.\nfunction b() {}\n') });
	assert.equal(r.ok, true, r.reason);
});

test('the reason says when the file does not parse after the call', async () => {
	const r = await check({ file: 'sample.ts', stub: 'sumFile', change: (t) => TS_FILL(t).replace('const LIMIT = 10;', 'const LIMIT = (10;') });
	assert.equal(r.ok, false);
	assert.match(r.reason, /does not parse/);
});

// Go ---------------------------------------------------------------------------

const GO_FILL = (t: string) => t.replace('\t// TODO(pi)\n\tpanic("not written")', '\tdata, err := os.ReadFile(path)\n\treturn len(data), err');

test('go: a fill is allowed; an import added to the group must resolve', async () => {
	const fill = await check({ file: 'sample.go', stub: 'SumFile', change: GO_FILL });
	assert.equal(fill.ok, true, fill.reason);
	const group = await check({ file: 'sample.go', stub: 'SumFile', resolves: (s) => !s.includes('.'), change: (t) => GO_FILL(t).replace('\t"os"\n', '\t"os"\n\t"strings"\n') });
	assert.equal(group.ok, true, group.reason);
	const dep = await check({ file: 'sample.go', stub: 'SumFile', resolves: (s) => !s.includes('.'), change: (t) => GO_FILL(t).replace('\t"os"\n', '\t"os"\n\t"github.com/x/y"\n') });
	assert.deepEqual(kinds(dep), ['dependency']);
	const alias = await check({ file: 'sample.go', stub: 'SumFile', resolves: () => true, change: (t) => GO_FILL(t).replace('\t"os"\n', '\tos "io"\n') });
	assert.deepEqual(kinds(alias), ['outside_edit']);
});

test('go: new var, const and type are declarations, not outside edits', async () => {
	for (const [added, name] of [['var cache = map[string]int{}', 'cache'], ['type entry struct{ n int }', 'entry'], ['const max = 3', 'max']]) {
		const stub = await check({ file: 'sample.go', stub: 'SumFile', change: (t) => `${GO_FILL(t)}\n${added}\n` });
		assert.deepEqual(kinds(stub), ['new_decl'], added);
		const file = await check({ file: 'sample.go', stub: 'SumFile', scope: 'file', change: (t) => `${GO_FILL(t)}\n${added}\n` });
		assert.equal(file.ok, true, `${added}: ${file.reason}`);
		const allowed = await check({ file: 'sample.go', stub: 'SumFile', allowances: [{ kind: 'new_decl', target: name }], change: (t) => `${GO_FILL(t)}\n${added}\n` });
		assert.equal(allowed.ok, true, `${added}: ${allowed.reason}`);
	}
});

test('go: init and var _ run at load, so file scope does not let them in', async () => {
	for (const added of ['func init() { os.Exit(1) }', 'var _ = os.Remove("x")']) {
		const r = await check({ file: 'sample.go', stub: 'SumFile', scope: 'file', change: (t) => `${GO_FILL(t)}\n${added}\n` });
		assert.deepEqual(kinds(r), ['new_decl'], added);
	}
});

// Python -----------------------------------------------------------------------

const PY_FILL = (t: string) => t.replace('    # TODO(pi)\n    ...', '    with open(path) as f:\n        return sum(int(line) for line in f)');

test('py: a fill is allowed; an import in the body must resolve', async () => {
	const fill = await check({ file: 'sample.py', stub: 'sum_file', change: PY_FILL });
	assert.equal(fill.ok, true, fill.reason);
	const dep = await check({ file: 'sample.py', stub: 'sum_file', resolves: () => false, change: (t) => t.replace('    ...', '    import requests\n    return 0') });
	assert.deepEqual(kinds(dep), ['dependency']);
});

test('py: a second def of an old name is blocked even in file scope', async () => {
	const r = await check({ file: 'sample.py', stub: 'sum_file', scope: 'file', change: (t) => `${PY_FILL(t)}\n\ndef _get(key: str) -> int:\n    return 0\n` });
	assert.deepEqual(kinds(r), ['new_decl']);
	assert.match(r.reason, /a second declaration of `_get`/);
	const helper = await check({ file: 'sample.py', stub: 'sum_file', scope: 'file', change: (t) => `${PY_FILL(t)}\n\ndef _parse(s: str) -> int:\n    return int(s)\n` });
	assert.equal(helper.ok, true, helper.reason);
});

test('py: a decorator added to the stub is outside the body', async () => {
	const r = await check({ file: 'sample.py', stub: 'sum_file', change: (t) => PY_FILL(t).replace('def sum_file', '@cache\ndef sum_file') });
	assert.deepEqual(kinds(r), ['outside_edit']);
});

// C# ---------------------------------------------------------------------------

const CS_FILL = (t: string) => t.replace('            // TODO(pi)\n            throw new NotImplementedException();', '            return File.ReadAllLines(path).Sum(int.Parse);');

test('cs: a fill is allowed; a private member passes in file scope', async () => {
	const fill = await check({ file: 'sample.cs', stub: 'SumFile', change: CS_FILL });
	assert.equal(fill.ok, true, fill.reason);
	const member = await check({ file: 'sample.cs', stub: 'SumFile', scope: 'file', change: (t) => CS_FILL(t).replace('        public int Get(', '        int Parse(string s) => int.Parse(s);\n\n        public int Get(') });
	assert.equal(member.ok, true, member.reason);
});

test('cs: a type in a namespace and a static constructor are not private', async () => {
	const type = await check({ file: 'sample.cs', stub: 'SumFile', scope: 'file', change: (t) => CS_FILL(t).replace('namespace Demo\n{\n', 'namespace Demo\n{\n    class Evil { }\n\n') });
	assert.deepEqual(kinds(type), ['new_decl']);
	const ctor = await check({ file: 'sample.cs', stub: 'SumFile', scope: 'file', change: (t) => CS_FILL(t).replace('        int size = 0;', '        int size = 0;\n\n        static Cache() { }') });
	assert.deepEqual(kinds(ctor), ['new_decl']);
});

// Lua --------------------------------------------------------------------------

test('lua: a fill that requires a module is allowed', async () => {
	const r = await check({ file: 'sample.lua', stub: 'sum_file', resolves: (s) => s === 'util', change: (t) => t.replace('  -- TODO(pi)\n', '  local io2 = require("util")\n  return io2.sum(path)\n') });
	assert.equal(r.ok, true, r.reason);
});

test('lua: only a plain require is an import, so code after it is seen', async () => {
	const tail = await check({ file: 'sample.lua', stub: 'sum_file', change: (t) => t.replace('local util = require("util")', 'local util = require("util") or os.exit(1)') });
	assert.ok(kinds(tail).includes('outside_edit'));
	const fn = await check({ file: 'sample.lua', stub: 'sum_file', change: (t) => t.replace('function M.get(key)\n  return', 'function M.get(key)\n  require("util")\n  os.exit(1)\n  return') });
	assert.deepEqual(kinds(fn), ['outside_edit']);
});

test('lua: a stub assigned to a field is found and filled', async () => {
	const source = 'local M = {}\n\n-- Sum it.\nM.sum = function(path)\n  -- TODO(pi)\nend\n\nreturn M\n';
	const r = await check({ file: 'sample.lua', source, stub: 'M.sum', resolves: (s) => s === 'util', change: (t) => t.replace('  -- TODO(pi)\n', '  local u = require("util")\n  return u.sum(path)\n') });
	assert.equal(r.ok, true, r.reason);
});
