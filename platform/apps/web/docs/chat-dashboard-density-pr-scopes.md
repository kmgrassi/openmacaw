# Chat Dashboard Density PR Scopes

This document breaks the requested chat/dashboard polish work into small PRs that separate visual density, readability, status/action affordances, and navigation hierarchy. Each PR should keep behavior changes narrow, preserve existing data contracts, and verify the dashboard at desktop and mobile widths.

Primary files likely involved:

- `apps/web/src/routes/Dashboard.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatMessage.tsx`
- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/components/AgentList.tsx`
- `apps/web/src/components/ui/Button.tsx`
- `apps/web/src/components/ui/Badge.tsx`

Recommended verification for each PR:

- Run `pnpm -C apps/web run lint` if available.
- Run `pnpm -C apps/web run build` if available.
- Check the dashboard manually at a desktop viewport and a narrow/mobile viewport.

## PR 1: Reduce Chat Panel Dead Space

Goal: tighten the chat panel so messages sit closer together and the first visible message starts higher in the viewport.

Likely files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatMessage.tsx`

Implementation notes:

- Reduce the message scroll container vertical padding from the current generous top/bottom spacing.
- Reduce message stack spacing, for example from `space-y-3` to a tighter value.
- Ensure loading and empty states do not add excessive top padding before the first actual message.
- Keep enough room above the composer so the latest message is readable and not visually pressed against the input.

Checklist:

- [ ] Message list vertical padding is reduced.
- [ ] Gap between consecutive messages is reduced.
- [ ] First visible message appears closer to the top of the chat panel.
- [ ] Loading and empty states still look intentional.
- [ ] Latest message remains visible above the composer after auto-scroll.
- [ ] Desktop and mobile views have no clipped message content.

## PR 2: Improve Chat Bubble Readability

Goal: make incoming and outgoing message bubbles visually balanced with consistent max width, better padding, softer contrast, and clearer timestamp placement.

Likely files:

- `apps/web/src/components/ChatMessage.tsx`

Implementation notes:

- Use a consistent max width for both user and assistant bubbles. Avoid one role feeling much wider or visually heavier than the other.
- Tune bubble padding so short messages do not look oversized and long messages still breathe.
- Soften the outgoing bubble contrast from the current bright blue while preserving clear authorship.
- Give timestamps a predictable placement, such as bottom-right inside the bubble or a consistent small line beneath content.
- Ensure markdown content, code blocks, and long links still wrap or scroll correctly.

Checklist:

- [ ] User and assistant bubbles use consistent max-width rules.
- [ ] Bubble padding is balanced for short and long messages.
- [ ] Outgoing message color is less harsh while still distinct.
- [ ] Assistant bubble color has enough contrast against the panel.
- [ ] Timestamp placement is consistent for both roles.
- [ ] Markdown, code blocks, and long content remain readable.

## PR 3: Add Chat Starter Guidance

Goal: when the conversation has little content, show a lightweight starter area with suggested tasks: "Fix a bug", "Open PR", "Run tests", and "Inspect repo".

Likely files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatComposer.tsx` if starter actions should prefill or submit text

Implementation notes:

- Replace the plain "No messages yet" copy with a compact starter area.
- Show four suggested task actions: `Fix a bug`, `Open PR`, `Run tests`, `Inspect repo`.
- Keep this area lightweight and avoid a marketing-style hero. It should feel like part of the chat workspace.
- Decide whether suggestion clicks immediately send a prompt or prefill the composer. Prefer the repo's existing composer flow if it already supports controlled values; otherwise keep buttons as visible affordances and wire behavior in a follow-up PR.
- Hide starter guidance once messages exist or the session is loading history.

Checklist:

- [ ] Empty chat state uses a starter area instead of plain text.
- [ ] Suggested tasks include `Fix a bug`, `Open PR`, `Run tests`, and `Inspect repo`.
- [ ] Starter area is compact and does not recreate the large initial gap.
- [ ] Starter area disappears once messages are present.
- [ ] Loading history state remains distinct from empty state.
- [ ] Mobile layout does not wrap buttons awkwardly.

## PR 4: Improve Chat Scroll Affordance

Goal: make the chat scrollbar less visually prominent and keep the latest message clearly anchored near the bottom.

Likely files:

- `apps/web/src/components/ChatView.tsx`
- Global CSS file if scrollbar utilities belong there

Implementation notes:

- Add a subtle scrollbar style for the chat scroll container only, or add a reusable utility if the project already uses global Tailwind/CSS utilities.
- Use a narrow thumb, transparent or low-contrast track, and a slightly stronger hover state.
- Preserve keyboard and pointer scrolling behavior.
- Confirm the existing auto-scroll behavior still keeps new messages and streaming text visible.
- Consider adding bottom padding inside the scroll area if the composer visually crowds the latest message.

Checklist:

- [ ] Chat scrollbar is subtler than the browser default.
- [ ] Scrollbar remains discoverable on hover or active scroll.
- [ ] Auto-scroll still follows new messages and streamed text.
- [ ] Latest message has comfortable bottom spacing above the composer.
- [ ] Scroll behavior works with mouse wheel, trackpad, keyboard, and touch.
- [ ] Styling does not unintentionally affect unrelated page scrollbars.

## PR 5: Make Agent Status More Actionable

Goal: replace the small status pill on the Engine Instance card with a clearer status module containing a colored state, short explanation, and quick action such as `View logs` or `Restart`.

Likely files:

- `apps/web/src/routes/Dashboard.tsx`
- `apps/web/src/components/ui/Button.tsx`
- API/client files only if wiring a real restart or logs action is already supported

Implementation notes:

- Convert the current status badge area into a compact status module near the top of the Engine Instance card.
- Include:
  - colored state indicator
  - human-readable status label
  - one-sentence explanation
  - at least one quick action
- If no real logs/restart endpoint exists, wire `View logs` to reveal existing debug/details content or navigate to the most relevant debug/runtime surface. Do not invent backend behavior without an API.
- Keep `Stop Agent` inside expanded details unless this PR intentionally changes the destructive-action hierarchy.
- Normalize status labels to title case or sentence case consistently.

Checklist:

- [ ] Engine status is shown as a clear module, not only a small pill.
- [ ] Module uses color and text, not color alone.
- [ ] Each known status has a short explanation.
- [ ] Module includes a useful quick action such as `View logs`, `Restart`, or `Refresh`.
- [ ] Unsupported actions are not shown as functional controls.
- [ ] Failed/unhealthy states are more visible than the current badge.
- [ ] Destructive actions remain clearly separated and intentional.

## PR 6: Tighten The Engine Instance Card

Goal: turn Host, Port, and Uptime into a compact key-value row layout so the card does not feel oversized.

Likely files:

- `apps/web/src/routes/Dashboard.tsx`

Implementation notes:

- Replace the vertical Host/Port/Uptime stack with a compact row or responsive grid.
- Use small labels and stronger values.
- Preserve expanded details for Last Health and Config Sync, but make them visually align with the compact key-value pattern.
- Ensure long host values truncate gracefully with a tooltip or readable wrapping.

Checklist:

- [ ] Host, Port, and Uptime render in a compact key-value row layout.
- [ ] Card height is reduced when details are collapsed.
- [ ] Expanded details align visually with the compact metadata pattern.
- [ ] Long host values do not break the card layout.
- [ ] Mobile layout stacks cleanly without crowding.
- [ ] Existing engine details toggle still works.

## PR 7: Improve Selected Agent State

Goal: make the selected sidebar agent easier to distinguish without relying only on a blue background.

Likely files:

- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/components/AgentList.tsx`

Implementation notes:

- Add a left accent bar to active agent rows.
- Increase active agent title weight or contrast.
- Add or preserve a status dot where activation state is available.
- Use the same active-state language in both the main app sidebar and any agent list component to avoid divergent states.
- Ensure collapsed sidebar active states remain visible.

Checklist:

- [ ] Active agent row includes a left accent bar or equivalent non-background cue.
- [ ] Active agent title is visually stronger than inactive rows.
- [ ] Active state does not rely only on blue fill/color.
- [ ] Collapsed sidebar still communicates selection.
- [ ] `AppShell` and `AgentList` use compatible active styling.
- [ ] Hover and focus-visible states remain clear.

## PR 8: Add Agent Metadata Hierarchy

Goal: in the sidebar, make agent name primary and capability/model secondary with smaller muted text and less crowding.

Likely files:

- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/components/AgentList.tsx`

Implementation notes:

- Keep the agent name as the primary line with medium or semibold weight.
- Move capability/type/model to a smaller muted secondary line.
- Avoid cramming multiple metadata fields into a single dense string if it harms scanability.
- Normalize separators. Prefer a simple middle dot or separate secondary fragments; avoid mixed hyphen usage if the rest of the UI uses title/sentence case.
- Truncate secondary metadata predictably.

Checklist:

- [ ] Agent name is the most prominent text in each row.
- [ ] Capability/type/model metadata is smaller and muted.
- [ ] Secondary metadata is readable without crowding.
- [ ] Long model names truncate cleanly.
- [ ] Metadata formatting is consistent between sidebar surfaces.
- [ ] Selected and hover states do not reduce metadata legibility.

## PR 9: Unify Capitalization And Labels

Goal: normalize message text and labels to avoid mixed casing such as `hello` / `Hello`, and keep agent names, model labels, and status text consistent.

Likely files:

- `apps/web/src/routes/Dashboard.tsx`
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatMessage.tsx`
- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/components/AgentList.tsx`
- `apps/web/src/components/settings/RuntimeSection.tsx`

Implementation notes:

- Audit visible labels in the dashboard, chat, runtime, and sidebar surfaces.
- Use sentence case for explanatory UI copy.
- Use title case sparingly for section titles and proper nouns.
- Normalize status labels such as `unknown`, `running`, and config sync statuses before rendering.
- Preserve exact model IDs where they are technical identifiers.
- Preserve user-entered chat message content exactly. Do not transform actual conversation text.

Checklist:

- [ ] Visible system labels use consistent casing.
- [ ] Status text is normalized for display.
- [ ] Agent names preserve configured/proper casing.
- [ ] Model IDs are not incorrectly title-cased.
- [ ] User-authored message content is not modified.
- [ ] Empty/loading/error copy follows the same capitalization style.

## PR 10: Make The Top Bar Clearer

Goal: move `Debug Off` and `Edit Setup` into a more structured header action area with buttons or icons and hover states.

Likely files:

- `apps/web/src/routes/Dashboard.tsx`
- `apps/web/src/components/ui/Button.tsx`

Implementation notes:

- Group header actions in a clear action cluster.
- Consider adding compact labels or icons if an icon system is already available. If no icon package exists, keep text buttons rather than adding a new dependency only for this PR.
- Make debug state clearer than `Debug Off`; for example, use a toggle-style button with `Debug` and an `On`/`Off` state indicator.
- Keep `Edit Setup` visually secondary but discoverable.
- Ensure the action group wraps cleanly under the page title on small screens.

Checklist:

- [ ] Header actions are grouped as a structured action area.
- [ ] Debug control has clear on/off state and hover state.
- [ ] Edit Setup is styled as an intentional action, not loose text.
- [ ] Header wraps cleanly on mobile.
- [ ] Keyboard focus states remain visible.
- [ ] No new icon dependency is added unless already standard in the app.

## Suggested PR Order

1. PR 1: Reduce Chat Panel Dead Space
2. PR 2: Improve Chat Bubble Readability
3. PR 4: Improve Chat Scroll Affordance
4. PR 3: Add Chat Starter Guidance
5. PR 6: Tighten The Engine Instance Card
6. PR 5: Make Agent Status More Actionable
7. PR 7: Improve Selected Agent State
8. PR 8: Add Agent Metadata Hierarchy
9. PR 9: Unify Capitalization And Labels
10. PR 10: Make The Top Bar Clearer

PRs 1, 2, 3, and 4 touch the same chat files, so avoid running them in parallel unless each agent has a clearly isolated ownership scope. PRs 5, 6, and 10 all touch `Dashboard.tsx` and should also be sequenced or coordinated carefully.
