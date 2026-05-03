---
type: task
status: active
created: 2026-05-02
completed: null
tags: [onboarding, welcome, voice]
first-action: "Open this file in org-viewer with your agent attached. The agent reads from here."
acceptance-criteria: |
  Onboarding is complete when:
  - context/voice.md is populated with the user's actual voice (not placeholder)
  - context/projects.md reflects the user's actual current projects (not placeholder)
  - context/current-state.md has at least one real entry under Active Tasks or Inbox
  - At least one real item exists in inbox/ or tasks/ that the user captured during the conversation
  - The user has read and either kept, modified, or deleted each starter principle in projects.md
  - This file (welcome.md) has been moved to tasks/completed/ with the completion timestamp
---

# Welcome

> **This document is for the agent, not you.** The user (you, reading this) is meant to open this file with their agent attached and let the agent run the conversation. The agent's job is to interview you, synthesize your answers into the right files, and then clean up. Your job is to answer honestly — not aspirationally.

> **Agent reading this file:** the user has opened systema-claude for the first time. `context/voice.md`, `context/projects.md`, and `context/current-state.md` still contain `_..._` placeholder text. Your job is to run the conversation below and produce populated files. Do not rush. Do not turn this into a survey. Follow threads, let tangents happen — the tangents are usually where the actual signal is. Plan for ~45 minutes if the user has the appetite for it; offer to pause at the end of any phase.

---

## What systema-claude is, in one paragraph the agent should be ready to say

> "This is a workspace, not a chat. The files in this folder are the substrate — your knowledge, your tasks, your projects, your inbox, your routines. I'm the agent: I read and write the same files you do. The frontmatter at the top of every file is how the system stays coherent — it's what makes the graph view, the dashboards, and my own context work without us having to coordinate explicitly. The verification harness is the central feature: every contract the workspace ships has a tiny test runner next to it. There are no katas — no prescribed routine templates, no required knowledge taxonomy. The seed you're looking at is a labeled blank room, not a template to fill in. You'll develop your own practice on top."

Say it in your own words. Do not read it verbatim.

---

## Phase 1 — Voice (20–30 min)

### Opening line for the agent

> "Let's set up this workspace. The most important part is helping me understand how you think — so I can be useful from the first message of every future session, not just this one. I'm going to ask some questions. There are no wrong answers. Just be honest, not aspirational. We'll do this for about half an hour, and at the end I'll draft a `voice.md` and we'll iterate until it feels right."

### Questions to ask conversationally (not as a survey)

You do not need all of them. Stop when you have enough signal to draft `context/voice.md`.

**How they think:**

- "What domains or fields do you actually move between in your work and life?" *Listen for cross-domain pairings — they often reveal the most about how the user reasons.*
- "When you hit a problem, do you reach for the abstract model first or the concrete thing that works? Or does it depend on the stakes?" *No right answer. Affects how to collaborate.*
- "What do you find yourself caring about that other people in your field tend to overlook?" *This often surfaces latent principles. 'I care way too much about error messages' is telling you about communication clarity. 'I can't stop thinking about naming' is conceptual precision. Listen for the value under the preference.*
- "What patterns keep showing up across different areas of your work?" *e.g., 'I always end up building the documentation system,' 'I keep automating myself out of jobs,' 'everything I build needs a CLI eventually.'*

**How they want to collaborate:**

- "Terse and direct, or more exploratory? Or different depending on context?" *'Direct' means different things to different people — get specific.*
- "What behaviors from AI assistants frustrate you?" *Gold. Common: over-explaining, asking permission for every step, hedging when a clear answer exists, sycophancy, refusing to disagree. Listen for theirs — they will be specific.*
- "When we disagree, how do you want me to handle it?" *Hard pushback? Present alternatives and let them choose? Just do it and flag concerns once? This shapes everything downstream.*
- "What should I never do?" *The negation is often clearer than the affirmation.*

**What they're working on (this seeds Phase 2):**

- "What are you actively working on right now? Don't worry about being organized — just dump."
- "What's something you keep meaning to do but haven't started?" *Great first inbox item.*

### Drafting voice.md

Once you have enough signal:

> "I have a good picture. Let me draft `context/voice.md` — this is the document any future agent reads first to understand how to work with you. I'll show you what I have and you tell me what's off."

Write `seed/context/voice.md` (which on first run is the user's `context/voice.md`) with real content. Principles:

- **Be specific, not generic.** "Direct communication" is generic. "Terse when executing, exploratory when designing, no preamble before code" is specific.
- **Reflect what they said, not what sounds good.** If they said "I hate when AI adds emoji" — write that down.
- **Include the surprising things.** Unusual preferences are the most differentiating.
- **Distinguish areas of depth from areas of active learning.** This prevents future agents from over-explaining things they're expert in or assuming knowledge they don't have.
- **Keep it 40–80 lines.** Dense and specific beats comprehensive and vague.

Show them the draft. Ask: "What's off? What's missing? What did I get wrong?" Iterate. **Do not over-polish on the first pass.** voice.md evolves through use; tell them so.

---

## Phase 2 — Projects + principles (15–20 min)

### Opening

> "Now let's map what you're actually working on. This is less about completeness and more about how the projects connect — which ones share technology or purpose, which themes show up in more than one place."

### Listen for

- **Project clusters:** projects sharing tech, purpose, or philosophy.
- **Recurring themes:** the same concern showing up in different contexts.
- **Maturity spectrum:** research vs. building vs. mature vs. winding down.

Write `seed/context/projects.md` (the user's `context/projects.md`) with conceptual clusters, project status, and a tech-stack reference. Use the user's own words for the cluster names where possible.

### The principle lattice — adapt, don't recite

systema-claude ships **four** starter principles in `docs/charter.md` and the seed `projects.md`. Walk through them like this:

> "The charter mentions four starter principles. I want to walk through them, but the goal isn't to teach you a system — it's to find which of these (if any) describe how you already think, modify the ones that almost-fit, and add the ones that are missing. End state is 4–6 principles that are honestly yours. Three of your own beats six borrowed."

Starters (from `docs/charter.md`):

- **Inversion** — place the complex at the simple point.
- **Sovereignty** — you own your data and your workflow; nothing here depends on a vendor staying alive.
- **Format contracts, not register contracts** — validate shape, not vibe; the harness enforces.
- **Develop your own response** — no katas; the workspace is a blank room with labeled equipment.

For each: explain in 30 seconds, then ask "does this show up in how you actually work?" If yes, help them find their own instantiations across their domains. If it doesn't click, leave it out — better to delete than to carry dead weight.

Then ask: **"Is there a principle you live by that isn't on this list? Something you keep coming back to?"**

There usually is. Examples that have come up for others: reversibility, automation-over-manual, explicit-over-implicit, worse-is-better, composability. Help them articulate it in the same shape: one-sentence statement + 2–5 instantiations.

**Target: 4–6 principles, 2–5 instantiations each.** Will grow with use. Do not force completeness.

### Initialize current-state.md

Update `seed/context/current-state.md` with:
- Anything that came up in conversation that's a real task → list it.
- Their projects with current status.
- Reset the inbox counts to reflect reality (probably zeros at this point).

---

## Phase 3 — First capture (5 min)

Things came up in the conversation. Create at least one real item now to establish the habit:

- A task in `tasks/` for something concrete the user said they need to do.
- An idea in `inbox/ideas/` for something percolating.
- A knowledge article in `knowledge/` if something the user said felt like a reusable insight (only if they agree it is).

Then say:

> "The most important habit is **capture immediately, sort later**. When something comes up — a task, an idea, a thing to investigate — drop it in `inbox/` and move on. Subfolders exist if you want to be specific (`ideas/`, `decisions/`, `investigations/`); `captures/` works as a catch-all. The inbox exists so you never lose a thought to 'I'll remember that later.'"

---

## Phase 4 — Disagreement-as-protocol moment (3 min)

This phase is unique to systema-claude. Do not skip it.

> "One more thing. systema-claude treats disagreement as a feature, not a failure mode. If you've been using chat-LLMs much, you've probably absorbed the default that the assistant should agree with you and be helpful. That default is wrong here. If I think you're heading the wrong way, I will say so. If you think *I'm* heading the wrong way, the right move is to push back — not to defer.
>
> Right now, in this onboarding: is there anything I just had you write into voice.md or projects.md that already feels off? Not 'wrong' — just off, like the language is mine and not yours, or the principle I picked doesn't actually describe you?"

Listen. If they push back: revise the file in place. The act of revision is the demonstration. If they don't push back the first time: probe once more. ("What about the principles — did any of those feel borrowed?") If they still don't push back, that's fine — note in voice.md that the user's appetite for disagreement-as-protocol is "to be developed through use."

---

## Phase 5 — Verification harness, by example (5 min)

Do not lecture. Just walk through it.

> "The seed ships with a tiny frontmatter validator at `examples/harness/validate-frontmatter.py`. I'm going to run it against `context/voice.md` right now. If we did this right, it passes."

Run the validator. Show the pass output.

> "Now let me deliberately break it — I'll change `type: context` to `type: contxt` in voice.md. Re-run."

Run the validator. Show the failure output. Restore the file.

> "That's the harness. Every contract this workspace ships with has one. Routine outputs validated at boundaries. Agent invocations validated at the call site. The harness substitutes for the second user you don't have. When you start writing your own routines (Phase 6 of the welcome path, separate task), you'll write a harness next to each one."

---

## Phase 6 — Cleanup

When all five phases are done:

1. **Move this file** to `tasks/completed/welcome.md` and set `completed: <today>` in the frontmatter.
2. **Drop the agent's interview script.** This file's contents are no longer load-bearing — the artifacts are voice.md / projects.md / current-state.md / the first inbox item. Future sessions read those, not this.
3. **Update CLAUDE.md** (if the seed shipped one) to remove any "see welcome.md" references.
4. **Final message to the user:**

> "Setup is complete. Your workspace is live. Three things to know:
>
> - **If something doesn't work for you, change it.** Rename folders, modify principles, restructure whatever. The only load-bearing constraint is that frontmatter stays valid — the harness will tell you when it isn't. Everything else is yours.
> - **Capture aggressively, sort lazily.** `inbox/` exists so no thought is ever 'I'll remember that later.'
> - **voice.md and projects.md will evolve.** When something feels wrong in a future session, just say so and we'll revise together. The first pass is never the right pass."

---

## Anti-patterns (for the agent)

- **Do not turn this into a survey.** It is a conversation. Follow threads. Let tangents happen — they reveal more than the planned questions do.
- **Do not over-explain the system.** They will learn it by using it. Explain only what's immediately relevant to the next step.
- **Do not force the principles.** Three honest ones beat six borrowed ones.
- **Do not skip Phase 4.** The disagreement moment is the central demonstration of what systema-claude is. If you skip it because the conversation has been smooth, you have already failed the lesson.
- **Do not skip Phase 5.** Running the harness once, with the user watching, is worth more than three paragraphs of documentation about it.
- **Do not auto-promote.** If the user dumped a lot of stuff in Phase 1 that sounds like potential projects or tasks, do not silently file them. Surface them at the end of Phase 3 and ask: "Of these, which is a task, which is an idea to percolate, and which was just thinking out loud?"

---

## Lineage

This welcome task adapts the structure of `vincitamore/claude-org-template/ONBOARDING.md` (Alex's onboarding script for the opus-tree template), reworked for systema-claude's posture: principles over prescriptions, harness as central feature, disagreement-as-protocol made explicit. We learned from Alex's pattern; the adaptations (Phase 4 disagreement moment, Phase 5 harness demonstration, the four-principle starter set rather than seven) are our own.
