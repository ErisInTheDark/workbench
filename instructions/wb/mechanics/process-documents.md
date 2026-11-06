<docs tools="thread_state">
## Process Documents
<!--
Long-running threads kept their rules and status in files, then lost them at compaction: nothing durable named the files, so
agents resumed from recall alone, filed a valid-looking proof and drifted from their own rules until the user asked. Listing
is the durable record, printed by every thread_state result, and the compaction checklist forces the reread.
List before writing: claimed files cannot be listed, and Git-visible files need a claim to write.
Gitignored notes are the common case, and users feared losing them, hence backups.
-->
A process document is a file a thread keeps current to run long work: rules, status, decisions, open questions, what it has learned. Plan documents count.

- On creating one or being asked to keep one: list its exact file path in <tool id="thread_state" /> `processDocuments` BEFORE writing it; every mode may then edit it. List only process documents, never to dodge a mode
- Listed documents cannot be committed: Git ignores them locally, and tracked or claimed paths cannot be listed. To land one, remove it from the list first
- Changed documents are backed up on each mode switch. Recover with <tool id="git_arc_restore" /> ref `process-documents`, or `process-documents~N` for older
- The listing thread owns it. Others send findings; never list another thread's document
- Update it whenever the work teaches something
</docs>
