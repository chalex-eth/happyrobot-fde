---
name: HappyRobot Logistics operations
description: Warm paper, black ink and signal color for a HappyRobot-inspired carrier operations desk.
colors:
  ink: "#1d211f"
  ink-soft: "#303834"
  muted: "#66716b"
  line: "#d5d7cf"
  paper: "#f3f0e8"
  surface: "#fffdf8"
  surface-2: "#ebe9e1"
  teal: "#0f5a4d"
  gold: "#e6b333"
  orange: "#ee704a"
  orange-deep: "#a9462e"
  slate: "#263633"
  focus: "#087662"
typography:
  display:
    fontFamily: "Georgia, 'Times New Roman', serif"
    fontSize: "clamp(48px, 6vw, 84px)"
    fontWeight: 500
    lineHeight: 0.95
    letterSpacing: "-.055em"
  section:
    fontFamily: "Georgia, 'Times New Roman', serif"
    fontSize: "clamp(42px, 5vw, 72px)"
    fontWeight: 500
    lineHeight: 0.98
    letterSpacing: "-.03em"
  body:
    fontFamily: "'Helvetica Neue', Helvetica, sans-serif"
    lineHeight: 1.55
  label:
    fontFamily: "'Helvetica Neue', Helvetica, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    letterSpacing: ".02em"
rounded:
  button: "0"
  field: "0"
  panel: "0"
spacing:
  compact: "8px"
  small: "12px"
  medium: "18px"
  large: "28px"
  section: "54px"
  wide: "82px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  button-primary-hover:
    backgroundColor: "{colors.orange}"
    textColor: "{colors.ink}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "11px 12px"
  state:
    open: "{colors.teal}"
    pending: "{colors.orange}"
    selected: "#164f88"
---

# Design System: HappyRobot Logistics operations

## Overview

**Creative North Star: "The carrier timetable"**

The operator dashboard translates HappyRobot's warm editorial brand into a working
surface for logistics operations. The page is a ruled schedule board: the live call is the
dark anchor, the TMS map and lane list are the current network, and the review queue
is the next set of decisions. The reference site's confident serif scale and black
ink are carried into the app without turning an operational tool into a marketing
page.

The design also borrows the discipline of a pocket timetable: a continuous paper
ground, flat panels, strong rules, compact state labels and a small signal palette.
The layout may become dense when the data is dense, but the current task remains
visible at the top and the next action is always labeled.

## Colors

Warm paper is the page ground and pale ivory is the working surface. Black-green ink
anchors headings and primary actions. The lane list and performance panel share the
same pale working surface as the rest of the dashboard, keeping the workspace light
and readable. Teal means an available or confirmed operational path; orange marks the
live demo, waiting work and pending routes; gold highlights the selected summary
state and important demo cues. Blue is reserved for a selected or focused route.

All state colors retain a text label. Error and partial-data notices keep a separate
warm error treatment and explain the recovery action.

## Typography

Georgia supplies the editorial display voice for the call prompt and operations
heading. Helvetica Neue carries controls, records, labels and metadata. Large headings stay
short and balanced; data uses tabular numerals and identifiers use monospace only
when the identifier itself is the content. Labels are uppercase where they function
as timetable headers, not as decorative kicker text.

## Layout

The page is a single operator workspace capped at 1500px, with generous paper around
the live call and a strong rule starting the operations section. The first viewport
exposes the live call trigger and verification-code area before the TMS workspace.
Desktop coverage uses a map and a light lane list side by side. Calls remain a ruled
table on wide screens and become two-column records on mobile. The three summary
filters form one connected row instead of separate floating cards. The performance
panel closes the page as a light ruled instrument.

At 1100px the call interaction stacks its code area below the controls. At 760px the
banner, coverage, queue and performance panel stack; the map remains bounded to its
container and the lane list remains scrollable. Search fields, filters, review notes
and manager actions preserve full-width touch targets.

## Elevation, borders and shape

The surface is flat at rest. One-pixel rules establish relationships and black rules
separate the primary work areas. Panels, fields and buttons are square-edged to echo
printed timetable cards and to avoid treating every record as a floating object. The
dark call banner supplies contrast while the lane list and performance panel stay light
and share the working surface.

## Components

### Live call banner

The call banner is the first product action, not a marketing hero. It uses a dark ink
ground, warm serif prompt, orange live rule and gold demo cues. The voice controls
stay adjacent to the OTP area. Loading, permission, connection, muted, ending and
error states keep their existing labels and behavior.

### Coverage map and lane list

The map keeps route direction and mapped/unmapped counts visible; its geography remains
an approximate network view rather than vehicle tracking. Open routes are teal, pending
routes are orange and selected/focused routes use blue. The lane list shares the pale
working surface, with compact rows that end at an explicit open or pending badge; deeper
dates and booking activity remain in the review flow. Filters remain native selects with
readable labels.

### Summary and review queue

Summary filters are a single ruled strip with a gold selected state. The review queue
keeps received time, carrier, load, agreed rate and action-needed reasons visible
before expansion. Expanded details separate the load and negotiation facts from
review-required work with a responsive divider. When multiple review types exist,
the outer label stays generic while each item keeps its specific state, such as
interrupted request or awaiting approval. Review notes and decision comments explain
their requirements beside the fields; manager decisions, simulation labels and
recovery states remain explicit.

### Performance panel

Business performance is a restrained light closing panel. Metrics use teal for the
values, gray bars for requests and teal bars for confirmed bookings. The chart remains
a compact operational comparison, not a decorative analytics surface.

## Interaction and accessibility

Buttons and fields remain at least 44px high. All interactive routes, city markers,
summary filters, tabs, review rows and form controls retain keyboard focus. The
global focus ring is teal and clearly offset. Scrollbars, selection, caret and
reduced-motion behavior are themed as part of the system. Empty, loading, partial,
error, simulated and confirmed states are always described in text.

## Do's and Don'ts

### Do

- Do keep the live call, OTP and demo cues adjacent and immediately findable.
- Do preserve TMS, Twin, approximate geography and simulation truth in the interactions.
- Do use rules, weight and contrast to make dense records scannable.
- Do keep teal, orange, gold and blue state meanings consistent.
- Do test the network view and review queue at mobile width.

### Don't

- Don't disclose the private rate ceiling or imply vehicle tracking.
- Don't hide review reasons or simulation labels behind visual styling.
- Don't add marketing claims, decorative imagery or generic dashboard widgets.
- Don't use shadows, pill-shaped cards or color-only statuses as shortcuts.
