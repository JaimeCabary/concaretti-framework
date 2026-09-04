<!--
  OPERATOR.md — the operator tier.

  Named for who writes it, and deliberately NOT named anything close to `.conca`.
  The two files are opposites and confusing them is the one mistake here that
  cannot be undone:

    * `.conca` is authority. Machine-read, enforced, and never sent anywhere.
    * `OPERATOR.md` is preference. Sent verbatim to a third-party provider on
      every prompt.

  A secret pasted into the policy file stays on this machine. The same secret
  pasted into this file has left it. So:

    * Put standing preferences here. Things you would otherwise repeat.
    * Do NOT put secrets here. Not an API key, not a password, not a card number.
      Credentials belong in .env, which is never sent anywhere. This file is.
    * Edits take effect on your next prompt. No restart.
    * Nothing here is remembered as history — it will never come back as a recall
      result, because it never enters the vector index. It is context, not memory.
    * Delete the file entirely to switch this tier off.

  Capability is not granted here. If you want the agent to be able to do
  something it currently refuses, edit .conca — this file cannot widen
  permission, and asking it to will not work.

  This tier follows Naomi Carrigan's Hikari, which keeps its memory in a single
  always-on markdown file for the same reason: a text file is the only part of an
  agent's memory a human can read and correct directly.
-->

# Standing notes

## Who I am

- (Your name, role, institution. The agent will address you and sign drafts accordingly.)

## How I want work done

- Be brief. Lead with the answer, not the reasoning.
- When something failed, say so plainly and say what you tried.
- Draft in British English.

## Defaults

- Save files to the Desktop unless I name a folder.
- Working hours are 09:00–18:00; do not schedule outside them without asking.
- Currency is GBP unless I say otherwise.

## Standing don'ts

- Never send mail or SMS on my behalf without showing me the text first.
  (Enforced in .conca as well — this line is the reminder, that file is the rule.)
