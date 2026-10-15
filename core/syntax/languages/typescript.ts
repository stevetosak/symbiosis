// TypeScript, and JavaScript through the same grammar (it parses a superset).
import type { Node } from 'web-tree-sitter';
import { childOfType, type LanguageSpec, nameField, splitAtBody } from '../language.ts';

function nameOf(fn: Node): string {
	const own = nameField(fn);
	if (own) return own;
	// `const f = () => {}`: the name is the variable's.
	return fn.parent?.type === 'variable_declarator' ? nameField(fn.parent) : '';
}

function declName(node: Node): string {
	const own = nameField(node);
	if (own) return own;
	const declarator = node.namedChildren.find((c) => c.type === 'variable_declarator');
	return declarator ? nameField(declarator) : '';
}

export const typescript: LanguageSpec = {
	id: 'typescript',
	extensions: ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'],
	wasm: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
	functions: ['function_declaration', 'generator_function_declaration', 'method_definition', 'arrow_function', 'function_expression'],
	split: (fn) => splitAtBody(fn, fn.childForFieldName('body')),
	name: nameOf,
	wrappers: [],
	placeholder: (node) => node.type === 'throw_statement' || node.type === 'empty_statement',
	imports(root) {
		const statements = root.namedChildren
			.filter((c) => c.type === 'import_statement')
			.map((node) => {
				// `import fs = require('fs')` keeps its source in the clause.
				const source = node.childForFieldName('source') ?? childOfType(node, ['import_require_clause'])?.childForFieldName('source');
				return { spec: (source?.text ?? '').slice(1, -1), node };
			});
		const calls = root.descendantsOfType('call_expression').flatMap((node) => {
			const callee = node.childForFieldName('function');
			const args = node.childForFieldName('arguments')?.namedChildren ?? [];
			const loads = callee?.type === 'import' || (callee?.type === 'identifier' && callee.text === 'require');
			if (!loads || args.length !== 1 || args[0].type !== 'string') return [];
			return [{ spec: args[0].text.slice(1, -1), node }];
		});
		return [...statements, ...calls];
	},
	declarations: [
		'function_declaration',
		'generator_function_declaration',
		'class_declaration',
		'abstract_class_declaration',
		'interface_declaration',
		'type_alias_declaration',
		'enum_declaration',
		'lexical_declaration',
		'variable_declaration',
		'method_definition',
		'public_field_definition',
		'abstract_method_signature',
		'internal_module',
	],
	holders: ['export_statement', 'variable_declarator', 'lexical_declaration', 'variable_declaration'],
	isPrivate(decl, name) {
		const parent = decl.parent;
		if (!parent || parent.type === 'export_statement') return false;
		if (parent.type === 'program') return true;
		if (parent.type === 'class_body') {
			return name.startsWith('#') || decl.namedChildren.some((c) => c.type === 'accessibility_modifier' && c.text === 'private');
		}
		return false;
	},
	declName,
};

/** `.tsx` and `.jsx`: the same rules, the grammar with JSX. */
export const tsx: LanguageSpec = {
	...typescript,
	id: 'tsx',
	extensions: ['.tsx', '.jsx'],
	wasm: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
};
