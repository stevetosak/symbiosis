// Go. A name that starts with a lower-case letter is private to its package.
import type { Node } from 'web-tree-sitter';
import { callTo, type LanguageSpec, nameField, splitAtBody } from '../language.ts';

function panics(node: Node): boolean {
	if (node.type === 'call_expression') return callTo(node, 'panic');
	return node.type === 'expression_statement' && node.namedChildren.length === 1 && callTo(node.namedChildren[0], 'panic');
}

export const go: LanguageSpec = {
	id: 'go',
	extensions: ['.go'],
	wasm: 'tree-sitter-go/tree-sitter-go.wasm',
	functions: ['function_declaration', 'method_declaration', 'func_literal'],
	split: (fn) => splitAtBody(fn, fn.childForFieldName('body')),
	name: nameField,
	wrappers: ['statement_list'],
	placeholder: panics,
	imports(root) {
		// In `import ( ... )` each spec is its own import, so one can be added
		// to the group; `import "fmt"` is the whole statement.
		return root.descendantsOfType('import_spec').map((spec) => ({
			spec: (spec.childForFieldName('path')?.text ?? '').slice(1, -1),
			node: spec.parent?.type === 'import_declaration' ? spec.parent : spec,
		}));
	},
	declarations: ['function_declaration', 'method_declaration', 'type_spec', 'type_alias', 'var_spec', 'const_spec'],
	// `var x = 1` is the declaration of `x`; in `var ( ... )` each spec is its own.
	holders: ['var_declaration', 'const_declaration', 'type_declaration'],
	holds: (holder) => holder.namedChildren.filter((c) => c.type.endsWith('_spec') || c.type === 'type_alias').length === 1,
	// `init` and `var _ = f()` run when the package loads: never a harmless helper.
	isPrivate: (decl, name) => name !== '' && name !== '_' && !/^\p{Lu}/u.test(name) && !(decl.type === 'function_declaration' && name === 'init'),
};
