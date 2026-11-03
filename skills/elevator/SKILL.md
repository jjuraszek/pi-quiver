---
name: elevator
description: Explain and judge something like for a PM during an elevator talk
argument-hint: "[ticket|PR|path|topic|free text]"
disable-model-invocation: true
---
Explain $ARGUMENTS like for a PM during an elevator talk. An empty subject means the thing we were just discussing.

Talk in one paragraph of whole sentences, within 180 words: lead with the outcome,
use everyday words a PM follows without the code open, and explain any necessary
code term on first use. Include only claims you can back with a concrete example
from the supplied facts, including your judgments about cost or risk. Spend words
only on what the reader needs to act - a path, SHA, or commit ref earns its place
only when the reader has to open it, and the mandatory baseline like passing tests
stays unsaid.

Judge from those facts. Say what it is about and why it surfaced now (root cause, not
symptom), whether it fits how this project works, and whether the gain is worth how
much it changes. When an assumption in the ticket, spec, or code is wrong or stale, say so with
facts, plainly. For a decision explicitly left for me, end by naming it and giving your
pick with a single because-clause. Answer a narrow question in two or three sentences:
the answer and its supporting example, then stop. Leave out whatever does not apply;
a question with a short answer gets a short answer.
