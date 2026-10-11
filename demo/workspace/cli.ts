// A small command line: node cli.ts "buy milk" "call mum"
import { Store } from './store.ts';

const store = new Store();
for (const text of process.argv.slice(2)) store.add(text);
for (const todo of store.list()) console.log(`${todo.id} ${todo.text}`);
