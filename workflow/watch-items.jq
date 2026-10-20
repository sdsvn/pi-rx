# rx watch items: GitHub PR snapshot (stdin) x disposition ledger ($ledger) -> one row per review item.
# Keys carry their id space (t: thread, c: issue comment, r: review body) - GitHub ids are NOT comparable
# across those endpoints. The watcher posts as the PR author, so its thread replies carry the rx-watch
# marker: that is what separates "the watcher answered" from "the author left an instruction".
def rec($k): [$ledger[] | select(.key == $k)] | last;
def bot: (.body // "") | contains("<!-- rx-watch -->");
.data.repository.pullRequest as $p
| $p.author.login as $me
| ([$p.comments.nodes[], $p.reviews.nodes[]] | map(select(.author.login == $me) | (.createdAt // .submittedAt)) | max // "") as $mine
| [ ( $p.reviewThreads.nodes[] | .head.nodes[0] as $f | .tail.nodes[0] as $l
      | {key: "t:\($f.databaseId)", kind: "thread", by: $f.author.login, at: $l.createdAt, url: $f.url,
         where: "\(.path):\(.line // .originalLine // "-")", body: $f.body,
         last: (if $l.createdAt == $f.createdAt then "" else $l.body end),
         status: (if .isResolved then "resolved"
                  elif ($l | bot) or ($l.author.login == $me and $f.author.login != $me) then "replied"
                  else "waiting" end)} ),
    ( ($p.comments.nodes[] | select(.author.login != $me) | . + {k: "c", kind: "comment", at: .createdAt}),
      ($p.reviews.nodes[] | select(.body != "") | . + {k: "r", kind: "review", at: .submittedAt})
      | select(.author.__typename != "Bot")
      | {key: "\(.k):\(.databaseId)", kind, by: .author.login, at, url, where: "-", body, last: "",
         status: (if $mine > .at then "replied" else "waiting" end)} ) ]
| sort_by(.at)
| map(rec(.key) as $r | . + {action: ($r.action // ""), note: ($r.note // ""), acted: ($r.at // "")}
      | . + {fresh: (.status == "waiting" and .acted < .at),
             nudge: (.status == "waiting" and .acted >= .at and (.action == "human" or .action == "unhandled"))})
