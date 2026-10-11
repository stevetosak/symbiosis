Use your plan tool for this task, and keep it up to date as you go.

In this to-do app:

1. Write a new file `format.ts` with `formatTodo(todo)`: one to-do as one
   line, for example `[x] 2 call mum` (`[ ]` when it is not done).
2. Add `done(id)` to the `Store` in `store.ts`: it marks that to-do as done
   and returns it, or `undefined` for an unknown id.
3. Change `cli.ts`: `node cli.ts "buy milk" "call mum" --done 1` adds the
   to-dos, marks the ids after `--done`, and prints each to-do with
   `formatTodo`.
4. Add a test for `done()` and `formatTodo()` to `store.test.ts`, then run
   `node --test`.

Use the edit tool for changes to files that exist. Run no command other than
`node --test`.
