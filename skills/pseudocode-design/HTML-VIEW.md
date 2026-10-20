# HTML Review View

The disposable rendering of the design for review — **written and opened automatically** whenever a
design with an artifact (medium+) is presented for review, and regenerated whenever the design
changes. **The markdown list stays canonical**: the HTML is generated *from* it, never edited
directly, and every decision taken in review is folded back into the markdown.

## Use the bundled scripts — don't hand-author

```bash
# THE DEFAULT at review — render live chrome, serve, open the URL:
python3 scripts/render_html.py <artifact>.pseudocode.md --live -o "$TMPDIR/design.html"
python3 scripts/live_review.py "$TMPDIR/design.html" "$TMPDIR/feedback.jsonl" &   # prints the URL
open "http://127.0.0.1:8321"
# then WATCH $TMPDIR/feedback.jsonl; after every markdown change re-run render_html.py
# --live -o the SAME path — browsers self-reload

# fallback only (no server possible, or the human wants a shareable file):
open "$(python3 scripts/render_html.py <artifact>.pseudocode.md)"
```

`render_html.py` parses the four artifact sections (Context / Design / Diagrams / Open Questions)
and emits everything specified below — collapsible `<details>` tree, altitude toggle, marker
badges, live mermaid. Hand-author HTML only if the artifact deviates from the standard structure;
the rest of this file is the spec for what the script produces.

Write one self-contained file to the OS temp directory — `$TMPDIR` falling back to `/tmp` —
as `<tmpdir>/pseudocode-<feature>-<timestamp>.html`, open it (`open` on macOS, `xdg-open` on
Linux), and tell the human the absolute path. Nothing lands in the repo.

## Collapse IS the abstraction level

This is the entire point of the HTML form: **each abstraction level is collapsible**. Every list
bullet with children becomes a `<details>` (its text the `<summary>`); leaf bullets are plain
`<li>`. Depth 1 (**L1**) renders `open`; everything deeper starts collapsed. Collapsed = higher
altitude, expanded = zoomed in — the ladder made physical. A reviewer approves the
business-language flow without opening anything; expanding a node is "zoom into X"; collapsing it
is "zoom out".

Add an **altitude toggle** in the header — three buttons, `L1 · L2 · L3` — that opens the tree to
exactly that depth, so "show me the whole design at L2" is one click:

```html
<nav class="flex gap-2 text-sm">
  <button data-level="1" class="px-2 py-1 rounded border">L1</button>
  <button data-level="2" class="px-2 py-1 rounded border">L2</button>
  <button data-level="3" class="px-2 py-1 rounded border">L3</button>
</nav>
<script>
  document.querySelectorAll("nav [data-level]").forEach(btn =>
    btn.addEventListener("click", () => {
      const n = +btn.dataset.level;
      document.querySelectorAll("#design details").forEach(d => {
        let depth = 0, p = d;
        while ((p = p.parentElement.closest("details"))) depth++;
        d.open = depth < n;
      });
    }));
</script>
```

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Design — {{feature}}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: true, theme: "neutral" });
  </script>
</head>
<body class="bg-stone-50 text-slate-900 font-sans">
  <main class="max-w-3xl mx-auto px-6 py-12 space-y-10">
    <header><!-- feature name, date, one-line context --></header>

    <section id="design">
      <details open class="pl-4 border-l border-slate-200">
        <summary class="cursor-pointer py-1">a pharmacy event arrives</summary>
        <ul class="pl-6">
          <li class="py-1">make sure it really came from the pharmacy
            <span class="text-slate-500">— ignore anything we can't trust</span></li>
          <details class="pl-4 border-l border-slate-200">
            <summary class="cursor-pointer py-1">record that we received it</summary>
            <!-- deeper bullets -->
          </details>
        </ul>
      </details>
    </section>

    <section id="diagrams"><!-- <pre class="mermaid"> blocks, only the ones the artifact has --></section>
    <section id="open-questions"><!-- Q1..Qn --></section>
    <!-- Every mermaid block from the artifact's Diagrams section is carried over verbatim and
         renders live (stateDiagram-v2, sequenceDiagram, flowchart, C4). Keep diagrams in this
         section, never inside a collapsed <details> — mermaid lays out against a zero-width
         container there and renders blank. -->

  </main>
</body>
</html>
```

## Markers become badges

Same three glyphs, now visually loud — review attention goes exactly where they are:

- `?`  → `<span class="rounded bg-amber-100 text-amber-800 text-xs px-1.5">? Q1</span>`, and the
  Open Questions section repeats each with the agent's recommended answer beside it.
- `⚠` → red-tinted badge; `✎` → indigo-tinted badge with the proposed name in `font-mono`.
- Reasoning after the em dash renders muted (`text-slate-500`) so steps scan first, rationale second.

## Live review — the default

Review is served, not a static file: browser comments are the feedback channel, alongside chat.
`scripts/live_review.py` is the server — stdlib only, localhost only, killed when review ends. It
serves the page, exposes `GET /version` (the page's mtime) and `POST /feedback` (appends one JSON
line per comment to the feedback file).

Page additions in live mode (`render_html.py --live` emits all of this; still no framework):

- a 💬 button on each `<summary>`/`<li>` that prompts for a comment and
  `fetch("/feedback", {method:"POST", body: JSON.stringify({node, comment})})`
- a **general chat box pinned at the bottom** of the page — a textarea + send button posting
  `{node: null, comment}` for anything not tied to one node ("this feels too deep overall",
  "what about auditing?"). Sent messages echo above the box so the reviewer sees what they've said.
- a poller: every 2s `fetch("/version")`; when the mtime changes, `location.reload()` — the page
  keeps itself current as the design is regenerated

The loop: run the server in the background → watch `feedback.jsonl` → each comment is human
feedback on a named node: fold the decision into the **canonical markdown**, regenerate the HTML,
and the reviewer's browser reloads on its own. Treat a comment exactly like a chat instruction —
same non-negotiables, same open-question discipline. Announce the URL (`http://127.0.0.1:8321`),
and shut the server down when review ends.

## Rules

- **Non-negotiables apply unchanged** — business language at depth 1, one tree, bullet budget,
  diagrams in their own section below the tree, open questions listed with recommendations.
- **No app code beyond the altitude toggle.** Tailwind CDN, Mermaid ESM, and the ~10-line level
  toggle above are the only scripts; `<details>` provides everything else. No state, no framework.
- **One-way generation.** Regenerate the HTML after the markdown changes; never reconcile backwards.
- Style: editorial, generous whitespace, one accent colour + amber for `?` and red for `⚠` — same
  restraint as the improve-codebase-architecture report.
