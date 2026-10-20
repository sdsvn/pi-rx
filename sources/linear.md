---
name: linear
description: Linear issues — a linear.app issue URL, or a bare id (ENG-1234) while Linear is the default ticketing system.
match:
  - ^https?://linear\.app/[^/]+/issue/([A-Za-z][A-Za-z0-9_]*-\d+)
flags: i
id: $1
case: upper
---
Fetch Linear issue **$ID** (the user gave `$REF`).

1. Use the Linear MCP `get_issue` tool with id `$ID`. If the Linear MCP isn't connected, use the
   Linear CLI (`linear issue view $ID`) if it's installed.
2. Read the title, description, acceptance criteria, sub-issues, and the recent comments. Follow a
   parent or related issue only when it changes the scope.
3. **title** = the issue title. **requirement** = the description and acceptance criteria, plus any
   decision settled in the comments. Keep every acceptance criterion word for word.

Neither tool works, or `$ID` isn't found? Say so and ask the user to paste the ticket. Never guess
the requirement from the id.
