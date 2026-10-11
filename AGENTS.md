# symbiosis: how changes land

- Build each feature on its own branch (`feat/<name>`, `fix/<name>`), never
  on `main`.
- Push the branch and open a pull request with `gh pr create`. The operator
  reviews and merges it. Never push to `main`, never merge.
- Stage files by name, not `git add -A` or `git add .`.
- Before the pull request: `npm test` and the e2e scripts that touch the
  change (see README.md, "Test").
