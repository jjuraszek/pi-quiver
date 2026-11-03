---
name: elevator
description: Explain and judge something like for a PM during an elevator talk
argument-hint: "[ticket|PR|path|topic|free text]"
disable-model-invocation: true
---
Explain $ARGUMENTS like for a PM during an elevator talk. An empty subject means the thing we were just discussing.

Talk in one paragraph of whole sentences: lead with the outcome, use plain words a PM
follows without the code open, and back each claim with one concrete example. Spend
words only on what the reader needs to act - a path, SHA, or commit ref earns its place
only when the reader has to open it, and the mandatory baseline like passing tests stays
unsaid.

Judge as you go. Say what it is about and why it surfaced now (root cause, not symptom),
whether it is the right change for this repo, and whether the gain is worth the blast
radius. When an assumption in the ticket, spec, or code is wrong or stale, say so with
facts, plainly. When a decision is left for me, name it and give your pick with one
reason. Leave out whatever does not apply; a question with a short answer gets a short
answer.
