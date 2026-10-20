# One real chat turn

    npm run eval:chat
    npm run eval:chat -- "some other question"

Replays the starter-pack question a lead actually asked and prints what the
model did with it: every tool it called, every page it proposed, the answer,
and a checklist of the four things the original transcript got wrong.

**A script, never a test.** Every run is a real call and costs money — the
same reason `eval/inspect` is a script. More importantly, a test cannot do
this job at all: `chatLoop.test.ts` pins that the system prompt SAYS what it
should, and says nothing about whether the model acts on it. P13-5 found
three defects this way, one of them a hard failure, and the suite was green
through all of them.

Nothing is written. A write tool in chat is proposed and never run, so a
proposal in the output is the signal, not a side effect.

The transcript this replays, and what each run of it showed, is in
`specs/chat-starter-pack-postmortem.md`.
