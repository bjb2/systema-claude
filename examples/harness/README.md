# Verification harness

The verification harness is the central feature of systema-claude. Every contract the workspace ships gets a tiny test runner next to it. Tests substitute for the second pair of eyes a single-user workspace lacks by definition.

This directory holds the harness primitives.

## What's here

- `validate-frontmatter.py` — reference frontmatter shape validator. Walks a workspace and reports any `.md` file with missing required fields. The shape it checks is the contract the rest of the workspace assumes.
- `fixtures/valid/` — test vectors that should PASS the validator.
- `fixtures/invalid/` — test vectors that should FAIL the validator. Each broken file documents which field is missing and why.

## Self-testing the harness

The harness has its own contract. Verify it before trusting it:

```bash
# Should print PASS, exit 0
python examples/harness/validate-frontmatter.py examples/harness/fixtures/valid

# Should print one violation, exit 1
python examples/harness/validate-frontmatter.py examples/harness/fixtures/invalid
```

If those two commands produce the expected output, the harness is honest. If not, the harness itself has drifted — fix it before trusting it on real content.

## Why "self-testing the harness" matters

A harness that always passes is no harness. A harness that always fails is no harness either. Both states are silently broken — the user learns nothing from the runs. The valid + invalid fixture pair makes this checkable in two seconds.

This is the pattern systema-claude expects you to apply to anything you build on top: a contract, an example that satisfies it, an example that violates it, a runner. Cost is low. Payback is the first time your work meets another user's work, or your model upgrade silently changes its output shape.

## Extending

When you write a new contract (a routine output shape, an agent invocation envelope, a custom frontmatter type), copy the pattern: a `validate-X.py` next to two fixture trees. Keep the runner under ~150 lines. Keep dependencies to one obvious thing (PyYAML, jsonschema). Crypto-grade is not the goal — visibility is.
