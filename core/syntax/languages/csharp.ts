// C#. A member with no access modifier is private; a type with none is
// internal (visible in its assembly).
import type { Node } from 'web-tree-sitter';
import { type LanguageSpec, nameField, splitAtBody } from '../language.ts';

const TYPES = ['class_declaration', 'struct_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration'];

function declName(node: Node): string {
	const own = nameField(node);
	if (own) return own;
	// `int f;`: field_declaration > variable_declaration > variable_declarator.
	const declarator = node.descendantsOfType('variable_declarator')[0];
	return declarator ? (nameField(declarator) || (declarator.namedChildren[0]?.text ?? '')) : '';
}

export const csharp: LanguageSpec = {
	id: 'csharp',
	extensions: ['.cs'],
	wasm: 'tree-sitter-c-sharp/tree-sitter-c_sharp.wasm',
	functions: ['method_declaration', 'constructor_declaration', 'destructor_declaration', 'operator_declaration', 'local_function_statement'],
	split: (fn) => splitAtBody(fn, fn.childForFieldName('body')),
	name: nameField,
	wrappers: [],
	placeholder: (node) => node.type === 'throw_statement',
	imports(root) {
		return root.descendantsOfType('using_directive').map((node) => {
			const names = node.namedChildren.filter((c) => c.type === 'qualified_name' || c.type === 'identifier');
			return { spec: names[names.length - 1]?.text ?? '', node };
		});
	},
	declarations: [...TYPES, 'method_declaration', 'constructor_declaration', 'field_declaration', 'property_declaration', 'event_declaration', 'event_field_declaration', 'delegate_declaration'],
	holders: [],
	isPrivate(decl) {
		const modifiers = decl.namedChildren.filter((c) => c.type === 'modifier').map((c) => c.text);
		// A static constructor has no access modifier and runs on the first use of its type.
		if (decl.type === 'constructor_declaration' && modifiers.includes('static')) return false;
		if (modifiers.includes('private')) return true;
		if (modifiers.some((m) => m === 'public' || m === 'protected' || m === 'internal')) return false;
		if (!TYPES.includes(decl.type)) return true;
		// A type nested in a type is private; one in a namespace is internal.
		const list = decl.parent;
		return list?.type === 'declaration_list' && list.parent !== null && TYPES.includes(list.parent.type);
	},
	declName,
};
