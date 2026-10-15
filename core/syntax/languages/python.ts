// Python. A function's body is everything after its `:`, so a comment
// between the `def` line and the first statement is in the body. The intent
// may be a docstring instead of a comment above.
import type { Node } from 'web-tree-sitter';
import { type LanguageSpec, nameField } from '../language.ts';

function placeholder(node: Node): boolean {
	if (node.type === 'pass_statement' || node.type === 'raise_statement') return true;
	if (node.type !== 'expression_statement' || node.namedChildren.length !== 1) return false;
	const only = node.namedChildren[0];
	return only.type === 'ellipsis' || only.type === 'string';
}

function declName(node: Node): string {
	if (node.type === 'assignment') return node.childForFieldName('left')?.text ?? '';
	return nameField(node);
}

export const python: LanguageSpec = {
	id: 'python',
	extensions: ['.py', '.pyi'],
	wasm: 'tree-sitter-python/tree-sitter-python.wasm',
	functions: ['function_definition'],
	split(fn) {
		const colon = fn.children.find((c) => c.type === ':');
		if (!colon) return undefined;
		return { signature: { start: fn.startIndex, end: colon.endIndex }, body: { start: colon.endIndex, end: fn.endIndex } };
	},
	name: nameField,
	wrappers: ['block'],
	placeholder,
	imports(root) {
		return root.descendantsOfType(['import_statement', 'import_from_statement']).flatMap((node) => {
			if (node.type === 'import_from_statement') return [{ spec: node.childForFieldName('module_name')?.text ?? '', node }];
			if (node.type !== 'import_statement') return [];
			return node.namedChildren.map((name) => ({ spec: (name.type === 'aliased_import' ? name.childForFieldName('name')?.text : name.text) ?? '', node }));
		});
	},
	declarations: ['function_definition', 'class_definition', 'assignment'],
	holders: ['decorated_definition'],
	isPrivate: (_decl, name) => name.startsWith('_'),
	declName,
};
