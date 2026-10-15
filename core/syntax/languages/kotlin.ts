// Kotlin. Its `function_declaration` has only `name` as a field: the
// parameters and the body are found by node type.
import type { Node } from 'web-tree-sitter';
import { callTo, childOfType, type LanguageSpec, nameField, splitAtBody } from '../language.ts';

/** `val x = 1`: the name is in the variable declaration. */
function declName(node: Node): string {
	const own = nameField(node);
	if (own) return own;
	const name = childOfType(node, ['identifier', 'type_identifier', 'simple_identifier']);
	if (name) return name.text;
	const variable = childOfType(node, ['variable_declaration']);
	return variable ? (childOfType(variable, ['identifier', 'simple_identifier'])?.text ?? '') : '';
}

export const kotlin: LanguageSpec = {
	id: 'kotlin',
	extensions: ['.kt', '.kts'],
	wasm: '@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm',
	functions: ['function_declaration'],
	split: (fn) => splitAtBody(fn, childOfType(fn, ['function_body'])),
	name: nameField,
	wrappers: ['function_body', 'block'],
	placeholder: (node) => node.type === 'call_expression' && callTo(node, 'TODO'),
	imports(root) {
		return root
			.descendantsOfType(['import', 'import_header'])
			.filter((node) => node.parent === null || node.parent.type === 'source_file' || node.parent.type === 'import_list')
			.map((node) => {
				const path = childOfType(node, ['qualified_identifier', 'identifier']);
				const star = node.text.trimEnd().endsWith('.*') ? '.*' : '';
				return { spec: (path?.text ?? '') + star, node };
			});
	},
	declarations: ['function_declaration', 'class_declaration', 'object_declaration', 'property_declaration', 'type_alias', 'companion_object', 'secondary_constructor'],
	holders: [],
	isPrivate(decl) {
		const modifiers = childOfType(decl, ['modifiers']);
		return modifiers?.namedChildren.some((m) => m.type === 'visibility_modifier' && m.text === 'private') ?? false;
	},
	declName,
};
