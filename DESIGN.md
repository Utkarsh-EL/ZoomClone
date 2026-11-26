---
name: ZoomClone Participant
description: Quiet, readable controls for a shared meeting participant session.
colors:
  canvas: "#f3f4ef"
  surface: "#fff"
  ink: "#222e2b"
  muted: "#53635d"
  line: "#d8dfd8"
  accent: "#205c48"
  hover: "#e4ece6"
  warning: "#76501c"
  danger: "#9f302e"
  control-border: "#87978d"
  control-active: "#d3e2d7"
  accent-hover: "#174936"
  danger-hover: "#7d2524"
  notice-bg: "#fff3da"
  notice-ink: "#59401d"
  notice-border: "#ceb27f"
typography:
  headline:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "-.025em"
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 650
    lineHeight: 1.5
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: ".875rem"
    fontWeight: 600
    lineHeight: 1.5
  small:
    fontFamily: "system-ui, sans-serif"
    fontSize: ".875rem"
    fontWeight: 400
    lineHeight: 1.5
  detail:
    fontFamily: "system-ui, sans-serif"
    fontSize: ".8rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  control: "6px"
  conversation: "10px"
spacing:
  quarter: ".25rem"
  half: ".5rem"
  three-quarters: ".75rem"
  one: "1rem"
  one-quarter: "1.25rem"
  one-half: "1.5rem"
  two: "2rem"
components:
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: ".5rem .8rem"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: ".5rem .8rem"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: ".5rem .8rem"
  button-danger-hover:
    backgroundColor: "{colors.danger-hover}"
  textarea:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: ".75rem"
    width: "100%"
  conversation:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.conversation}"
  notice:
    backgroundColor: "{colors.notice-bg}"
    textColor: "{colors.notice-ink}"
    rounded: "{rounded.control}"
    padding: "1rem 1.25rem"
---

# Design System: ZoomClone Participant

## Overview

**Creative North Star: "The Participant Workspace"**

The implemented interface is a quiet workspace for operating a shared meeting participant. Warm neutral surroundings, one white conversation surface, and restrained green actions keep messages and current state easy to scan. System typography and native controls make the interface familiar and practical.

This document records the implementation in `client/participant.css`, `client/participant.html`, and `client/browser-bootstrap.js`, following `docs/superpowers/plans/2026-11-25-participant-ui.md`. It describes the current participant surface, without establishing a visual identity for future surfaces. The browser attaches to the same durable participant session as the CLI; the interface makes local attachment, meeting connection, and retained snapshot freshness separately readable.

**Key Characteristics:**

- Warm neutral canvas with a flat white conversation surface.
- Restrained green actions, explicit text states, and visible keyboard focus.
- Conversation first, with participants and ownership controls alongside it.
- Retained history and command outcomes remain inspectable during uncertainty.

## Colors

The palette uses warm pale neutrals, dark green text, and one restrained green accent; amber and red communicate exceptional states. The frontmatter records the source values.

### Primary

- **Deep green** (`accent`): primary submission, links, focus outlines, connected state, and successful command outcomes. `accent-hover` darkens filled primary actions on hover.
- **Pale green** (`hover`, `control-active`): secondary control hover and pressed feedback.

### Neutral

- **Warm canvas** (`canvas`): the page background.
- **White surface** (`surface`): conversation, fields, and secondary controls; also the light text on filled actions.
- **Forest ink** (`ink`): primary text.
- **Muted green gray** (`muted`): helper copy, system events, sequence numbers, and metadata.
- **Soft divider** (`line`): boundaries within the conversation, sidebar, command list, and footer.
- **Control stroke** (`control-border`): stronger boundaries around buttons and the message field.

### Semantic states

- **Amber** (`warning`): reconnecting, authority unavailable, and pending command states.
- **Red** (`danger`, `danger-hover`): leave actions and rejected command outcomes.
- **Warm notice** (`notice-bg`, `notice-ink`, `notice-border`): interrupted submission, errors, and leave confirmation. These notices share one visual treatment; their text identifies the situation.

**The Readable State Rule.** Pair every state color with explicit status text. Color alone must not carry connection, pending, rejection, or ownership meaning.

## Typography

The interface uses the system sans stack for headings, body text, buttons, and the message field. Its base size and line height favor readable conversation text rather than compressed diagnostics. Native code and preformatted elements retain their monospace defaults.

- **Headline:** meeting identity; semibold with slightly tightened tracking.
- **Title:** section headings; semibold at a modest step above body text.
- **Body:** messages and controls; message copy preserves line breaks and has a maximum width of 72 characters (`72ch`).
- **Label:** visible field labels. Filled primary actions use weight 600 at the body size.
- **Small:** helper copy, event headings, system events, connection status, and footer.
- **Detail:** page status, tags, command IDs, command state, and preformatted outcome details. Event sequence numbers use `.75rem`.

Sequence numbers, page counts, and session values use tabular numerals where implemented. Long names, identifiers, and messages wrap rather than expanding the page.

## Layout

The shared header, connection bar, and main container have a maximum width of 1440px and desktop horizontal padding of 2rem. The workspace is a two-column grid: flexible conversation plus a 320px sidebar, with a 2rem gap. The sidebar groups participants, logical share turns, and local capture ownership. Command outcomes and session details sit below the workspace.

At 900px and below, the conversation and sidebar stack; sidebar sections form two columns with a 1.5rem gap. At 540px and below, page gutters become 1rem, sidebar sections form one column, conversation insets become 1rem, the composer footer stacks, and session definition lists become a single column. Sidebar section dividers return on this narrow layout.

The history viewport is 26rem high on larger screens and 23rem at the narrow breakpoint. It scrolls independently and contains overscroll. The roster, share queue, and command list also have bounded scrolling regions. History paging has explicit Older, Newer, and Latest actions; browsing retained history stays put, while following latest scrolls to the newest event.

The spacing tokens record recurring values from the stylesheet, rather than a newly imposed scale. Conversation heading insets, history tools, and composer use the same broad horizontal alignment. The message field resizes vertically between 6rem and 24rem.

## Elevation & Depth

The current interface uses no shadows. White against the warm canvas establishes the conversation surface, while thin borders and section spacing establish grouping. Notices use a warmer fill and stroke to attract attention without floating above the page. Leave confirmation is an inline notice above the workspace.

**The Flat Workspace Rule.** Use tonal surfaces, borders, and spacing to match the implemented depth; preserve the conversation as the principal bounded surface.

## Shapes

Controls, the message field, and notices have gently rounded corners using the control radius. The conversation uses the slightly larger conversation radius. Boundaries are one-pixel strokes. The small “You” label is plain text without a pill background or border.

## Components

### Buttons

Secondary controls are white with an ink label and visible stroke. Send message is the filled green primary action. Leave meeting is a red text/stroke secondary action; Confirm leave is filled red. Controls have a minimum height of 44px. Disabled controls retain their shape at half opacity and do not show enabled hover or pressed feedback.

Background transitions last 150ms with ease-out timing. Reduced-motion preference removes the transition. All keyboard-focusable elements use a green three-pixel focus outline with a three-pixel offset. Secondary buttons use pale green hover and pressed fills; filled actions have their own darker hover states.

### Message field

The composer has a persistent visible label, white background, control stroke, matching radius, green caret, and muted placeholder. Helper text explains durable submission and the maximum of 8192 UTF-8 bytes. Send is disabled when submission is unavailable or the draft is blank. A draft clears only after the submission returns an ID, provided the user has not changed the draft in the meantime.

### Conversation and history navigation

The white conversation groups its heading, history controls, event stream, and composer with internal dividers. Messages show author, sequence, and preserved multiline content. System events use smaller muted text and separators. Empty states explain whether the interface is loading or has no retained events. The history list is keyboard-focusable; the skip link leads directly to the message field.

### Participants and ownership

Roster entries show names and a plain “You” tag. The share queue shows the current logical holder, ordered requests, and queue position. Request, cancel, and release labels follow the observed share state. A separate section shows this tab's local capture lease and its claim, replacement, or release action.

**The Ownership Rule.** Keep the logical share grant, local capture lease, and actual media capability distinct. Neither requesting a turn nor claiming local ownership implies camera, microphone, screen capture, or media transport.

### Notices and confirmation

Errors announce through an alert region. Interrupted submissions show an explicit review notice linking to the command list and a deliberate review action; the warning does not invite automatic resubmission. Leave confirmation explains that leaving affects the shared browser and CLI participant, while closing the tab only detaches it. Opening confirmation focuses Stay in meeting; cancelling returns focus to Leave meeting.

### Command outcomes and session details

Recent shared commands are reverse chronological disclosure rows with an operation label, explicit outcome or Pending text, and the original command ID. Expanding a row reveals its operation and outcome. Session details use a native disclosure with a responsive definition list. Snapshot text gives observation time, watermark, inbox progress, and an explicit stale-state warning when applicable.

## Do's and Don'ts

### Do:

- **Do** preserve the warm canvas, white conversation, and restrained green primary action.
- **Do** keep local attachment, meeting connection, snapshot freshness, and command outcomes separately legible.
- **Do** preserve visible labels, keyboard focus, long-content wrapping, and explicit empty states.
- **Do** retain original command IDs and expose uncertain outcomes for deliberate review.

### Don't:

- **Don't** imply that logical share turns or local capture ownership start actual media.
- **Don't** treat closing a browser tab as leaving the shared participant session.
- **Don't** use color without the corresponding readable state label.
- **Don't** replace retained history or command outcomes with invented meeting activity.
