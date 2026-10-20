---
name: jira
description: Jira issues — an Atlassian browse URL, or a bare key (PROJ-123) with `tickets: jira` in the config.
match:
  - ^https?://[^/]+\.atlassian\.net/browse/([A-Za-z][A-Za-z0-9_]*-\d+)
  - ^https?://[^/]+/browse/([A-Za-z][A-Za-z0-9_]*-\d+)
flags: i
id: $1
case: upper
---
Fetch Jira issue **$ID** (the user gave `$REF`).

1. Use the Atlassian MCP `getJiraIssue` tool with key `$ID`. If it isn't connected, use a Jira CLI
   if one is installed: `jira issue view $ID --plain --comments 5` or `acli jira workitem view $ID`.
2. Read the summary, description, acceptance criteria, subtasks, and the recent comments. Follow the
   epic or a linked issue only when it changes the scope.
3. **title** = the summary. **requirement** = the description and acceptance criteria, plus any
   decision settled in the comments. Keep every acceptance criterion word for word.

Nothing works, or `$ID` isn't found? Say so and ask the user to paste the issue. Never guess the
requirement from the key.
