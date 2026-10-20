#!/usr/bin/env python3
"""Render a .pseudocode.md artifact as the collapsible HTML review view.

Usage:
    render_html.py <artifact.md> [-o out.html] [--live] [--openspec-dir DIR]

Default output: $TMPDIR/pseudocode-<stem>-<timestamp>.html (path printed to stdout).
--live injects per-node comment buttons, the general chat box, and the /version
poller for use with live_review.py.
--openspec-dir points at an OpenSpec change directory (.../changes/<id>); when
given and readable, its proposal.md and specs/*/spec.md render as an
"OpenSpec Change" section alongside the pseudocode tree. Omitted entirely
when the dir/files don't exist.
"""
import argparse
import html
import os
import re
import time

MARKERS = {
    "?": ("q", "bg-amber-100 text-amber-800", "?"),
    "⚠": ("warn", "bg-red-100 text-red-800", "⚠"),
    "✎": ("name", "bg-indigo-100 text-indigo-800", "✎"),
}


def parse_sections(text):
    """Split the artifact into {heading: body} by '## ' headings."""
    sections, current, buf = {}, None, []
    for line in text.splitlines():
        if line.startswith("## "):
            if current:
                sections[current] = "\n".join(buf)
            current, buf = line[3:].strip().lower(), []
        elif current:
            buf.append(line)
    if current:
        sections[current] = "\n".join(buf)
    return sections


def parse_bullets(body):
    """Indented '- ' bullets -> tree of {text, children}. 2 spaces = 1 level.
    Continuation lines (deeper indent, no dash) are folded into the previous bullet."""
    root = {"text": None, "children": [], "depth": -1}
    stack = [root]
    for line in body.splitlines():
        m = re.match(r"^(\s*)- (.*)$", line)
        if m:
            depth = len(m.group(1)) // 2
            node = {"text": m.group(2).strip(), "children": [], "depth": depth}
            while stack[-1]["depth"] >= depth:
                stack.pop()
            stack[-1]["children"].append(node)
            stack.append(node)
        elif line.strip() and len(stack) > 1:
            stack[-1]["text"] += " " + line.strip()
    return root["children"]


def inline(text):
    """Markdown inline -> HTML: markers to badges, em-dash reasoning muted, code/bold/italic."""
    out = html.escape(text)
    for glyph, (_, classes, label) in MARKERS.items():
        out = out.replace(
            f"`{glyph}`",
            f'<span class="rounded {classes} text-xs px-1.5 py-0.5 font-medium">{label}</span>',
        )
    out = re.sub(r"`([^`]+)`", r'<code class="font-mono text-sm bg-slate-100 rounded px-1">\1</code>', out)
    out = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", out)
    # first " — " splits step from reasoning; reasoning renders muted
    parts = out.split(" — ", 1)
    if len(parts) == 2:
        out = f'{parts[0]} <span class="text-slate-500">— {parts[1]}</span>'
    return out


def render_node(node, depth, live):
    btn = (
        f'<button class="cmt ml-2 text-slate-300 hover:text-slate-600" '
        f'data-node="{html.escape(plain(node["text"])[:80])}" title="comment">💬</button>'
        if live
        else ""
    )
    text = inline(node["text"])
    if node["children"]:
        kids = "\n".join(render_node(c, depth + 1, live) for c in node["children"])
        is_open = " open" if depth < 1 else ""
        return (
            f'<details{is_open} class="pl-4 border-l border-slate-200">'
            f'<summary class="cursor-pointer py-1">{text}{btn}</summary>'
            f'<ul class="pl-2">{kids}</ul></details>'
        )
    return f'<li class="py-1 list-none">{text}{btn}</li>'


def plain(text):
    return re.sub(r"[`*]", "", text)

def render_markdown_generic(text):
    """Generic '#'-heading / '- ' bullet / paragraph markdown -> HTML, for OpenSpec
    files (proposal.md, spec.md) whose structure isn't the pseudocode bullet tree."""
    out, para, bullets = [], [], []

    def flush_para():
        if para:
            out.append(f'<p class="text-sm text-slate-600 my-1">{inline(" ".join(para))}</p>')
            para.clear()

    def flush_bullets():
        if bullets:
            out.append('<ul class="list-disc ml-5 space-y-0.5">' + "".join(bullets) + "</ul>")
            bullets.clear()

    for line in text.splitlines():
        s = line.strip()
        if not s:
            flush_para()
            flush_bullets()
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", s)
        if m:
            flush_para()
            flush_bullets()
            level = min(len(m.group(1)) + 1, 6)  # shift down one level to nest under the page's own h1/h2
            size = {2: "text-lg font-semibold mt-4", 3: "text-base font-semibold mt-3"}.get(
                level, "text-sm font-semibold mt-2 text-slate-700"
            )
            out.append(f'<h{level} class="{size}">{inline(m.group(2).strip())}</h{level}>')
            continue
        bm = re.match(r"^-\s+(.*)$", s)
        if bm:
            flush_para()
            bullets.append(f'<li class="text-sm text-slate-600">{inline(bm.group(1))}</li>')
            continue
        flush_bullets()
        para.append(s)
    flush_para()
    flush_bullets()
    return "\n".join(out)


def render_openspec_section(openspec_dir):
    """proposal.md + specs/*/spec.md under an OpenSpec change dir -> a collapsible
    section. "" (omitted) when the dir or its files don't exist."""
    if not openspec_dir or not os.path.isdir(openspec_dir):
        return ""
    parts = []

    def card(title, body_html, open_):
        o = " open" if open_ else ""
        return (
            f'<details{o} class="rounded-lg border border-slate-200 bg-white p-4">'
            f'<summary class="cursor-pointer font-semibold">{html.escape(title)}</summary>'
            f'<div class="mt-2 space-y-1">{body_html}</div></details>'
        )

    proposal_path = os.path.join(openspec_dir, "proposal.md")
    if os.path.isfile(proposal_path):
        text = open(proposal_path, encoding="utf-8").read()
        title_m = re.search(r"^# (.+)$", text, re.M)
        title = title_m.group(1) if title_m else "Proposal"
        body = re.sub(r"^# .+\n", "", text, count=1)
        parts.append(card(title, render_markdown_generic(body), True))

    specs_dir = os.path.join(openspec_dir, "specs")
    if os.path.isdir(specs_dir):
        for cap in sorted(os.listdir(specs_dir)):
            spec_path = os.path.join(specs_dir, cap, "spec.md")
            if not os.path.isfile(spec_path):
                continue
            parts.append(card(f"spec: {cap}", render_markdown_generic(open(spec_path, encoding="utf-8").read()), False))

    if not parts:
        return ""
    return (
        '<section id="openspec" class="space-y-3">'
        '<h2 class="text-lg font-semibold mb-2">OpenSpec Change</h2>' + "\n".join(parts) + "</section>"
    )


def render_diagrams(body):
    """Alternate prose and ```mermaid blocks."""
    out, in_mermaid, buf = [], False, []
    for line in body.splitlines():
        if line.strip().startswith("```mermaid"):
            in_mermaid, buf = True, []
        elif line.strip() == "```" and in_mermaid:
            in_mermaid = False
            out.append(
                '<div class="rounded-lg border border-slate-200 bg-white p-4 my-4">'
                f'<pre class="mermaid">{html.escape(chr(10).join(buf))}</pre></div>'
            )
        elif in_mermaid:
            buf.append(line)
        elif line.strip():
            out.append(f'<p class="text-sm text-slate-600 mt-4">{inline(line.strip())}</p>')
    return "\n".join(out)


LIVE_JS = """
<div class="flex flex-wrap gap-2 items-center sticky top-0 bg-stone-50 py-3 border-b border-slate-200 z-10 mb-4">
  <button id="approve" class="px-4 py-1 rounded bg-emerald-600 text-white text-sm">✓ Approve design</button>
  <button id="request" class="px-4 py-1 rounded bg-amber-600 text-white text-sm">✎ Request changes</button>
  <span id="gatemsg" class="text-sm text-slate-500"></span>
</div>
<div id="chatlog" class="space-y-1 text-sm text-slate-600"></div>
<form id="chat" class="flex gap-2 sticky bottom-0 bg-stone-50 py-3 border-t border-slate-200">
  <textarea id="msg" rows="2" placeholder="General feedback — not tied to a node…"
    class="flex-1 rounded border border-slate-300 p-2 text-sm"></textarea>
  <button class="px-4 rounded bg-slate-800 text-white text-sm">Send</button>
</form>
<script>
const post = (node, comment) => fetch("/feedback", {method: "POST",
  body: JSON.stringify({node, comment, ts: Date.now()})});
document.querySelectorAll(".cmt").forEach(b => b.addEventListener("click", e => {
  e.preventDefault(); e.stopPropagation();
  // Inline editor, not prompt(): resident webviews (Paseo, VS Code, Electron) block window.prompt.
  const host = b.closest("details, li");
  const open = host.querySelector(":scope > .cbox");
  if (open) { open.remove(); return; }
  const box = document.createElement("div");
  box.className = "cbox flex flex-col gap-1 my-1";
  const ta = document.createElement("textarea");
  ta.rows = 2; ta.placeholder = "Comment on: " + b.dataset.node;
  ta.className = "rounded border border-slate-400 p-2 text-sm";
  const bar = document.createElement("div"); bar.className = "flex gap-2";
  const send = document.createElement("button");
  send.textContent = "Send"; send.className = "px-3 py-1 rounded bg-slate-800 text-white text-xs";
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel"; cancel.className = "px-3 py-1 rounded border border-slate-300 text-xs";
  bar.append(send, cancel); box.append(ta, bar);
  if (host.tagName === "DETAILS") { host.open = true; host.querySelector("summary").insertAdjacentElement("afterend", box); }
  else { host.appendChild(box); }
  ta.focus();
  cancel.addEventListener("click", () => box.remove());
  send.addEventListener("click", () => {
    const c = ta.value.trim(); if (!c) return;
    post(b.dataset.node, c); b.classList.add("text-emerald-600"); b.title = "commented"; box.remove();
  });
  ta.addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); send.click(); } });
}));
document.getElementById("chat").addEventListener("submit", e => {
  e.preventDefault();
  const t = document.getElementById("msg");
  if (!t.value.trim()) return;
  post(null, t.value.trim());
  const d = document.createElement("div");
  d.textContent = "you: " + t.value.trim();
  document.getElementById("chatlog").appendChild(d);
  t.value = "";
});
// Approval gate: Approve implements; Request-changes sends the general box (plus any
// buffered per-node comments) as one revision request. Both POST /feedback with a `kind`.
const gatePost = body => fetch("/feedback", {method: "POST", body: JSON.stringify(body)});
const gatemsg = document.getElementById("gatemsg");
document.getElementById("approve")?.addEventListener("click", () => {
  gatePost({kind: "approve", ts: Date.now()});
  if (gatemsg) gatemsg.textContent = "approved — implementing…";
});
document.getElementById("request")?.addEventListener("click", () => {
  const t = document.getElementById("msg");
  const comment = t ? t.value.trim() : "";
  gatePost({kind: "revise", comment, ts: Date.now()});
  if (t) t.value = "";
  if (gatemsg) gatemsg.textContent = "changes requested — revising…";
});
let v = null;
setInterval(async () => {
  try {
    const nv = await (await fetch("/version")).text();
    if (v && nv !== v) location.reload();
    v = nv;
  } catch {}
}, 2000);
</script>
"""

TOGGLE_JS = """
<script>
// Event delegation on document: survives script-timing and live-reload re-renders,
// and works even if the buttons are (re)created after this script runs.
document.addEventListener("click", (e) => {
  const btn = e.target.closest("nav [data-level]");
  if (!btn) return;
  e.preventDefault();
  const n = +btn.dataset.level;
  document.querySelectorAll("#design details").forEach((d) => {
    let depth = 0, p = d.parentElement;
    while (p) { if (p.tagName === "DETAILS") depth++; p = p.parentElement; }
    d.open = depth < n;                       // L1 shows depth 0, L2 shows 0-1, L3 shows 0-2
  });
});
</script>
"""


def render(artifact_path, live=False, openspec_dir=None):
    text = open(artifact_path, encoding="utf-8").read()
    title_m = re.search(r"^# (?:Feature: )?(.+)$", text, re.M)
    title = title_m.group(1) if title_m else os.path.basename(artifact_path)
    s = parse_sections(text)

    context = "".join(
        f'<p class="text-slate-600">{inline(p.strip())}</p>'
        for p in s.get("context", "").split("\n\n") if p.strip()
    )
    design = "\n".join(render_node(n, 0, live) for n in parse_bullets(s.get("design", "")))
    diagrams = render_diagrams(s.get("diagrams", ""))
    questions = "\n".join(
        f'<li class="py-1">{inline(n["text"])}</li>' for n in parse_bullets(s.get("open questions", ""))
    )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Design — {html.escape(title)}</title>
<script src="https://cdn.tailwindcss.com"></script>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
mermaid.initialize({{ startOnLoad: true, theme: "neutral" }});
</script>
</head>
<body class="bg-stone-50 text-slate-900 font-sans">
<main class="max-w-3xl mx-auto px-6 py-12 space-y-10">
<header class="space-y-3">
  <h1 class="text-2xl font-semibold">{html.escape(title)}</h1>
  <nav class="flex gap-2 text-sm">
    <button data-level="1" class="px-2 py-1 rounded border border-slate-300">L1</button>
    <button data-level="2" class="px-2 py-1 rounded border border-slate-300">L2</button>
    <button data-level="3" class="px-2 py-1 rounded border border-slate-300">L3</button>
  </nav>
  {context}
</header>
<section id="design">{design}</section>
<section id="diagrams">{diagrams}</section>
{render_openspec_section(openspec_dir)}
<section id="open-questions">
  {'<h2 class="text-lg font-semibold mb-2">Open Questions</h2><ul>' + questions + '</ul>' if questions else ''}
</section>
{LIVE_JS if live else ''}
{TOGGLE_JS}
</main>
</body>
</html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("artifact")
    ap.add_argument("-o", "--out")
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--openspec-dir", help="OpenSpec change dir (.../changes/<id>); renders proposal.md + specs/*/spec.md alongside the pseudocode")
    args = ap.parse_args()
    out = args.out or os.path.join(
        os.environ.get("TMPDIR", "/tmp"),
        f"pseudocode-{os.path.splitext(os.path.basename(args.artifact))[0]}-{int(time.time())}.html",
    )
    with open(out, "w", encoding="utf-8") as f:
        f.write(render(args.artifact, live=args.live, openspec_dir=args.openspec_dir))
    print(out)


if __name__ == "__main__":
    main()
