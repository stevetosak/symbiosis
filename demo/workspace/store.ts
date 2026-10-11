// A to-do list kept in memory. Ids start at 1.
export interface Todo {
	id: number;
	text: string;
	done: boolean;
}

export class Store {
	private todos: Todo[] = [];
	private next = 1;

	add(text: string): Todo {
		const todo = { id: this.next++, text, done: false };
		this.todos.push(todo);
		return todo;
	}

	list(): Todo[] {
		return [...this.todos];
	}
}
