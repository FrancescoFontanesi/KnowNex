<!-- knownex:start -->

## KnowNex continuity

Hooks capture the conversation automatically. Do not ask the user what to save and do not write artificial summaries to feed the memory. These instructions are in English, but they do not set the language: talk with the user in the language they use.

### Context and recall

- **STATE** is the automatic handoff when a new session starts in the same workspace: reuse it with the conversation context, without re-injecting it every turn or checking it periodically. After a compact STATE is not emitted again: the conversation summary already holds it.
- STATE is the project state up to the last confirmed checkpoint. Later events may have changed it.
- If the available context is enough, go on without Recall. Read a note already linked from STATE directly with `npm exec --offline -- knownex memory read`: it is a single read.
- Delegate history (HISTORY, windows, revisions and events), taxonomy and searches for unknown references to a subagent with its own context, which follows the `knownex-recall` skill (`.agents/skills/knownex-recall/SKILL.md`) read-only and returns facts, references, provenance and limits. Pass a precise request and the references you already know, not the whole conversation. If the harness has no subagents, say so.
- STATE holds the present, Knowledge the topic details, HISTORY the transitions. Do not explore whole archives without need.
- Reuse information and documents already retrieved during the turn. Do not repeat reads just to confirm.
- If the context is incomplete, the pending is partial or some information is missing, state the limits without inventing facts.

### Checkpoint

Keep the conversation natural. State decisions, results, evidence and open problems when they matter to the task, without templates or mandatory sections.

At significant milestones (superseded decisions, verified results, changes of focus, handoffs or relevant compactions) suggest in one line to run the checkpoint, for example `npm exec --offline -- knownex checkpoint --codex -m gpt-6.1-sol -r medium`, and keep working. The user decides the checkpoint: run it only on their explicit request, as a background command, and report only the outcome. Curation happens in a separate session: do not read or change the memory yourself to curate it.
<!-- knownex:end -->
