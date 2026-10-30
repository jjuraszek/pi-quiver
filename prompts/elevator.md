---
description: Explain and judge something like for a PM during an elevator talk
argument-hint: "[ticket|PR|path|topic|free text]"
---
Explain ${@:-the thing we were just discussing} like for a PM during an elevator talk.

Format: outcome first, plain words, one concrete example per claim, max ~8 lines.
No code, SHAs, file paths, or commit refs unless the reader needs them to act.
Skip "tests pass" and other mandatory baseline.

Answer, in order, only what applies:
1. What it is about and why it surfaced now (the root cause, not the symptom).
2. Is it the right change - idiomatic for this repo, follows existing conventions
   and machinery, no new abstraction without a second caller?
3. Is it worth it - gain vs blast radius, is it material?
4. Which assumption is wrong or stale, in the ticket, the spec, or the code?
   Roast it: facts only, no diplomacy, no performed agreement.
5. What is left for me to decide, with your pick and one reason.
