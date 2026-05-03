# Charter

systema-claude is a school, not an on-ramp. This document explains what that commits the project to.

## The naming

systema-claude is named for the martial art **Systema**. Systema is unusual among martial arts in that it teaches no fixed forms (no katas), no prescribed responses to named attacks, and no graded ranks. It teaches breath, structure, relaxation, and the principle that effectiveness is the only honest test. Practitioners spend most of their time under partner-applied pressure, learning to find their own response in the moment.

The name is load-bearing. It commits this project to the same posture in software:

- **Principles over prescriptions.** We name a small number of principles and instantiate them. We do not ship a recipe book.
- **Effectiveness-checking over technique-collecting.** Every contract gets a test harness. Tests substitute for the partner a single-user workspace lacks.
- **You develop your own response.** The seed org is a blank room with equipment labeled, not a template to fill in.

## What systema-claude is *not*

(Repeated from README so it is not lost in the docs tree.)

- Not a chat interface.
- Not a coding IDE.
- Not a note-taking app with AI bolted on.
- Not a workflow platform.
- Not a memory feature.
- Not a federation client.
- **Not a graduation path to something more articulated.**

That last one matters. An earlier draft of this project framed systema-claude as preparation for a more developed practice elsewhere — the cathedral-and-on-ramp framing. That framing was wrong and got corrected on 2026-05-02. A Systema practitioner does not graduate to karate; they do not graduate at all. Operating in this workspace prepares you to participate in any federation later — including peer projects like `vincitamore/amore-network` — *on your own terms*. You bring your structure; you do not adopt the host's katas.

## The verification harness as the central feature

A single-user workspace has no counterparty by definition. Without a counterparty, register-contract failures (the agent says "I will produce something useful" and produces prose-shaped output that the next step cannot parse) stay invisible until they travel. Test vectors substitute for the counterparty.

Every contract this project ships gets a tiny harness:

- **Frontmatter schema.** Example input + expected normalized output bytes + runner that prints pass/fail.
- **Routine-step output shape.** When step N produces something step N+1 reads, validate the boundary (JSON schema, file presence, exit code). Not "trust the prose."
- **Agent CLI invocation envelope.** Confirm the expected args, env, working directory.

Cost: low. Payback: the first time your work meets another user's work. Or the first time your model upgrade silently changes its output shape.

## Disagreement as protocol

A newcomer who has spent any time with chat-LLMs has likely absorbed assistant-mode servility as the default. systema-claude's job, after teaching files-as-substrate, may be uninstalling that default.

Onboarding will eventually point to a real commit demonstrating the project disagreeing with itself and improving. Until that commit exists in this fork, the placeholder is: read `inbox/decisions/` files in the parent workspace and notice that decisions are resolved *by changing the decision file in place*, with the prior reasoning preserved. Disagreement is structural. Consensus is suspect.

## Architecture-inscribes-profile

When an LLM architects its own environment, it bakes its own behavioral defaults into every interface. Successor models hit friction proportional to divergence. The seed org and routine examples in this fork reflect the model that authored them (Claude Opus 4.7 in 2026). Forks are encouraged.

Remedy patterns this project tries to follow:
- **Format contracts, not register contracts.** Validate shape, not vibe.
- **Externally enforced budgets, not self-regulated.** The harness enforces; the agent does not promise.
- **Pull, don't push, context.** The agent reads what it needs from files, rather than the user pre-loading "the agent will need to know X."

## The diagnostic

The single test for whether this project is honoring its anchor:

> **Does the user develop their own response, or do they execute ours?**

If the latter — if the seed routine reads as a kata to copy rather than a worked example to learn-from-then-discard, if the principles read as commandments rather than starting points to argue with, if the agent configs read as the right configs rather than two examples among many — the project has drifted into kata-school territory. The fix is not better templates. The fix is fewer templates.

## Lineage and credit

Forked from `my-org-new` (Bryan Bartley + Claude Opus 4.7). Influenced by `vincitamore/amore-network` (Alex + Opus 4.7) — a peer pair's project that carried each shared concept several levels further on identity, transport, and governance. We learned from amore's articulation; we did not adopt its alchemical naming or 13-principle lattice. Two valid schools meeting at protocol surfaces.

The systema-as-martial-art framing was developed in conversation between Bryan and Claude on 2026-05-02 and corrected the same day to remove the "graduation path to cathedral" framing. The correction is the example, not the exception.
