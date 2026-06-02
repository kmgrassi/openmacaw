# DR 0003: Split onboarding wizard shell from completion state UI

## Status

Proposed

## Context

`apps/web/src/components/OnboardingWizard/index.tsx` currently combines:

- step routing,
- progress rendering,
- finish/save actions,
- completion-state rendering,
- optional worker activation behavior.

The result is one file handling both the active wizard flow and the post-save confirmation screen. That increases branching in the top-level component and makes it harder to reason about changes to either path.

## Decision

Split the current file into smaller UI boundaries while keeping the store contract unchanged.

The target structure is:

- `OnboardingWizard` as the shell/controller,
- `OnboardingProgress` for the step indicator,
- `OnboardingCompletionCard` for the saved/activation state,
- `StepContent` or equivalent step router as a small leaf.

Business logic can stay in the shell first; the refactor does not require a new store or state model.

## Consequences

- The main onboarding entry point becomes easier to scan and review.
- The completion path can evolve independently from the step flow.
- Visual or copy changes to progress/completion no longer require editing the central shell every time.
- There is some short-term file churn, but the change is mechanical and should be low risk if behavior is preserved.

## Next step

Extract the progress UI first, then the completion card. Those two cuts should reduce most of the current file size without requiring store changes.
