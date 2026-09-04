---
name: auto
description: Use when the user says /auto.
---

Do not follow the full normal workflow for the exact request, simply complete the task given as directly as possible without sacrificing correctness, and without asking for approval. IE: skip decision mode. 

/auto-activated tasks that edit files should still use the arc commands to claim and own their changes, and the thread should be marked as completed, and a commit should still be proposed at the end.

Sometimes, /auto will be requested for mini-task in between other work.
- If you do not have a git arc, but it requires one, create it, propose the commit, and then continue with your original task.
- If you do have a git arc, and this mini-task also requires one, extend the existing arc, propose the commit for the mini-task, and then continue with your original task.

Never ask for approval for your /auto work plan unless the task is genuinely not well-defined enough.

Subsequent user messages or steers must be classified:
- If very simple or exactly specified, assume intended to stay /auto
- If larger, more complex, or less clearly defined, assume normal workflow required; do not re-enter /auto until user activates again
- Use notices to communicate your assumption: yellow for /auto, purple for normal
