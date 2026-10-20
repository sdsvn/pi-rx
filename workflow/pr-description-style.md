# PR description style

How Rx writes PR descriptions. Match this style **inside** the section structure fixed by the repo's
`.github/pull_request_template.md`. This guide governs *content*; the template governs *headings*.
A repo without a template uses the default headings in the skeletons below.

## The rules

1. **Headings are the template's, verbatim.** Use `.github/pull_request_template.md`'s headings
   exactly — same text, same emoji, same order. **Do not rename** and **do not invent** new
   top-level headings. An optional section may be omitted only when empty; when present it uses the
   exact heading text. The *only* sanctioned additions are the testing blocks in rule 6, and they go
   **under the test-plan heading**, never as sibling top-level headings.

2. **Title — always present, ticket-first.**
   - `ENG-1234: concise description` (colon after the id).
   - Untracked/mechanical work uses a conventional prefix instead: `chore: …`, `fix: …`, `feat: …`.
   - Multiple tickets: `ENG-1 & ENG-2: …`, or note the secondary ticket on the next line.
   - Reverts: keep GitHub's default `Revert "…"` body with `Reverts <owner>/<repo>#NNNN`.

3. **Terse, and scaled to the change.** Do not pad.
   - **Chore / small fix** → title only, or a 1–2 line note. No ceremony.
   - **Feature** → a Test Plan (+ a Changes bullet *only* if something's non-obvious — see rule 4).
   - **Integration / DB change** → full body: Changes + Test Plan + a seed block + an example request
     (+ pre-deployment steps if relevant).

4. **Changes / context sections are optional and usually dropped.** A Changes bullet must **never
   restate the title or list the obvious diff.** Include one only for something a reviewer can't
   infer from the title — a non-obvious decision, a mapping, a gotcha. If nothing is non-obvious,
   omit the section entirely (heading and all).

5. **Test Plan = the human-readable steps you actually ran to convince yourself it works.** Through
   that, it tells the reviewer the *scope* of the change. Write the real verification — the systems
   you touched and checked — not the CI baseline.
   - **Never list the obvious/automated baseline.** "lint passing", "unit tests passing", "build
     green" are noise — CI already reports them.
   - Describe the exercise end to end, naming each system you verified. e.g. for a create-user
     endpoint:
     ```
     ## ✅ Test Plan
     - Created a user via the API in preview
     - Confirmed the row landed in the DB
     - Confirmed the user exists in the auth provider
     ```
   - Mark unfinished parts honestly: `( WIP )`, `TO BE DONE`.
   - Nothing worth describing (pure chore/mechanical)? Drop the section.

6. **Pragmatic testing blocks go under the test-plan heading** — as bold sub-labels or fenced
   blocks, not new top-level headings:
   - **DB changes for test** — a fenced ```sql``` seed block that reproduces the scenario.
   - **Example request** — a fenced ```bash``` curl against the preview/review-app endpoint, with
     placeholder credentials (`<token>`), never real ones.
   - **Pre-deployment** — manual steps to run at deploy time (data fixes, one-off migrations).
   - Constraint/error output in a fenced block when demonstrating a validation.

7. **Don't duplicate bots.** If a review bot auto-generates the change summary, the context section
   holds only *why/approach* (and a short OpenSpec requirement-delta summary when the ticket has
   one), never a change list.

## Skeletons

**Chore / small fix**
```markdown
## 🔖 Title
chore: speed up the notifications query
```

**Fix with a ticket**
```markdown
## 🔖 Title
ENG-1234: require a shipping address on orders

## ✅ Test Plan
- Created an order without an address in preview → got the 422 with the new message
- Created one with an address → order created
```

**Integration (full)** — every heading is the template's; the seed/curl blocks live **inside** the
Test Plan:
````markdown
## 🔖 Title
ENG-1234: payments provider integration

## 📜 Changes
- Charges use POST /v1/charges with API-key auth
- Idempotency uses our order id
- Retry mapping: 5xx and timeouts retry with backoff; 4xx fail the order

## ✅ Test Plan
- End to end in preview: created an order, paid it, saw the provider's charge id stored
- Refund path — TO BE DONE

**DB changes for test**
```sql
-- seed rows that reproduce the scenario ...
```

**Example request**
```bash
curl --location 'https://<preview-host>/v1/orders' \
  --header 'Authorization: Bearer <token>' --header 'Content-Type: application/json' \
  --data-raw '{ ... }'
```
````
