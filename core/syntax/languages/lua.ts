// Lua. A function's body is between its parameters and its `end`; an empty
// body has no `block` node at all. An import is `local x = require("x")`,
// anywhere: a body may require what it needs.
import type { Node } from 'web-tree-sitter';
import { callTo, childOfType, type LanguageSpec, nameField } from '../language.ts';

/** `local f = function() end`, `M.f = function() end`: the name is the variable's. */
function nameOf(fn: Node): string {
	const own = nameField(fn);
	if (own) return own;
	const assignment = fn.parent?.parent;
	if (fn.parent?.type !== 'expression_list' || assignment?.type !== 'assignment_statement') return '';
	return assignment.namedChildren.find((c) => c.type === 'variable_list')?.text ?? '';
}

function declName(node: Node): string {
	const own = nameField(node);
	if (own) return own;
	const assignment = node.type === 'assignment_statement' ? node : node.namedChildren.find((c) => c.type === 'assignment_statement');
	return assignment?.namedChildren.find((c) => c.type === 'variable_list')?.text ?? '';
}

/**
 * The module a statement requires, if it is `[local] x = require("x")` or
 * `[local] x = require("x").y`: the value is the call and nothing else, so
 * no other code hides in an import line.
 */
function required(node: Node): string | undefined {
	const assignment = node.type === 'assignment_statement' ? node : childOfType(node, ['assignment_statement']);
	const values = assignment?.namedChildren.find((c) => c.type === 'expression_list')?.namedChildren ?? [];
	if (values.length !== 1) return undefined;
	const value = values[0];
	const call = value.type === 'dot_index_expression' ? value.childForFieldName('table') : value;
	if (!call || call.type !== 'function_call' || !callTo(call, 'require')) return undefined;
	const args = call.childForFieldName('arguments')?.namedChildren ?? [];
	if (args.length !== 1 || args[0].type !== 'string') return undefined;
	return args[0].descendantsOfType('string_content')[0]?.text ?? '';
}

export const lua: LanguageSpec = {
	id: 'lua',
	extensions: ['.lua'],
	wasm: '@tree-sitter-grammars/tree-sitter-lua/tree-sitter-lua.wasm',
	functions: ['function_declaration', 'function_definition'],
	split(fn) {
		const parameters = fn.childForFieldName('parameters');
		const end = fn.lastChild;
		if (!parameters || end?.type !== 'end') return undefined;
		return { signature: { start: fn.startIndex, end: parameters.endIndex }, body: { start: parameters.endIndex, end: end.startIndex } };
	},
	name: nameOf,
	wrappers: ['block'],
	placeholder: (node) => node.type === 'function_call' && callTo(node, 'error'),
	imports(root) {
		return root.descendantsOfType(['variable_declaration', 'assignment_statement']).flatMap((node) => {
			// `local x = require("x")` holds an assignment_statement: count the outer one.
			if (node.type === 'assignment_statement' && node.parent?.type === 'variable_declaration') return [];
			const spec = required(node);
			return spec === undefined ? [] : [{ spec, node }];
		});
	},
	declarations: ['function_declaration', 'variable_declaration', 'assignment_statement'],
	holders: ['expression_list', 'assignment_statement', 'variable_declaration'],
	isPrivate: (decl) => decl.firstChild?.type === 'local',
	declName,
};
