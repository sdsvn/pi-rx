---
name: gitlab
description: GitLab issues — an issue URL or gl-123; set `tickets: gitlab` and `ticket_shape: ^#(?<id>\d+)$` to use #123.
match:
  - ^https?://[^/]+/.+/-/issues/(\d+)
  - ^gl-(\d+)$
id: gl-$1
---
Fetch GitLab issue **$ID** (the user gave `$REF`; the issue number is the digits in `$ID`).

1. `glab issue view <number> --comments`. When `$REF` is a URL of another project, add
   `--repo <group/project>` from it.
2. **title** = the issue title. **requirement** = the description plus any decision settled in the
   comments; keep checklists and acceptance criteria word for word.

`glab` fails or the issue doesn't exist? Say so and ask the user to paste it.
