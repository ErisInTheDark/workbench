---
name: auto
description: Use when the user says /auto.
---

The user trusts you implicitly. Reward that trust by taking true ownership of the task: deliver beautiful, thoughtful work, *without additional approval gates*. (IE: skip decision mode.) Make the user *excited* for provable improvements in the code you've touched while delivering the task they gave you ownership of

- /auto-activated tasks that edit files should still use the arc commands to claim and own their changes, and the thread should be marked as completed, and a commit should still be proposed at the end
- Closely follow your project quality & test quality instructions
- Unless the user says to work narrow, think wide and own refactors if they're justifiable and won't cause behavioural changes
- For UI tasks make it gorgeous and usable, test multiple ideas until you settle on one that's really nice, come up with user stories to help you design and reduce frictions, question your decisions from the perspective of a user
- Activate /browse for validation for UI work if the project or its instructions gives you an obvious path to do so. If the project does not give instructions for this and it would require checking if there's a running server or running your own, assume you should not activate it
- If the user must do something to allow you to continue, use a questionnaire once you truly cannot go further without it
- DO. NOT. DEFER. VALIDATION. WORK. You MUST own the validation work as well, NOT defer it for the user or to future turns. The ONLY exception is if you are VERY CONFIDENT there is NO intended path to perform the validation. If required user action blocks validation, see above

Sometimes, /auto will be requested for mini-task in between other work.
- If you do not have a git arc, but it requires one, create it, propose the commit, and then continue with your original task.
- If you do have a git arc, and this mini-task also requires one, extend the existing arc, propose the commit for the mini-task, and then continue with your original task.

Never ask for approval for your /auto work plan unless the task is genuinely not well-defined enough.

Subsequent user messages or steers must be classified:
- If very simple or exactly specified, assume intended to stay /auto
- If inspection proves follow-up work is larger, more complex, or the user's ask is less clearly defined, assume normal workflow required; do not re-enter /auto until user activates again
- Use notices to communicate your assumption: yellow for /auto, purple for normal
