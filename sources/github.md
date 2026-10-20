---
name: github
description: GitHub issues — #123, gh-123, owner/repo#123, or an issue URL.
match:
  - ^https?://github\.com/[^/]+/[^/]+/issues/(\d+)
  - ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#(\d+)$
  - ^#(\d+)$
  - ^gh-(\d+)$
id: gh-$1
---
Fetch GitHub issue **#$1** (the user gave `$REF`).

1. `gh issue view $1 --comments`. When `$REF` names another repository (a URL or
   `owner/repo#N`), add `--repo owner/repo`.
2. **title** = the issue title. **requirement** = the issue body plus any decision settled in the
   comments; keep checklists and acceptance criteria word for word.

`gh` fails or the issue doesn't exist? Say so and ask the user to paste it.
