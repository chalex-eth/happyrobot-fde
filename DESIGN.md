---
name: Carrier sales POC
description: Light ink-and-teal workspace for carrier calls and brokerage operations.
colors:
  ink: "#203d39"
  muted: "#526760"
  line: "#d9e2dc"
  paper: "#f6f8f5"
  teal: "#205c50"
  teal-hover: "#16483e"
  white: "#ffffff"
  focus: "#297d70"
  route-open: "#2c7c68"
  route-pending: "#ab702e"
  route-selected: "#173c8b"
typography:
  display:
    fontFamily: "Georgia, 'Times New Roman', serif"
    fontSize: "clamp(27px, 2.8vw, 38px)"
    fontWeight: 500
    lineHeight: 1.16
    letterSpacing: "-.025em"
  headline:
    fontFamily: "Georgia, 'Times New Roman', serif"
    fontSize: "30px"
    fontWeight: 500
    letterSpacing: "-.025em"
  title:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    letterSpacing: "-.025em"
  body:
    fontFamily: "Arial, Helvetica, sans-serif"
    lineHeight: 1.55
  label:
    fontFamily: "Arial, Helvetica, sans-serif"
    fontSize: "12px"
    fontWeight: 600
rounded:
  badge: "4px"
  field: "7px"
  button: "8px"
  panel: "14px"
  banner: "16px"
spacing:
  compact: "8px"
  small: "12px"
  medium: "16px"
  large: "24px"
  section: "32px"
  wide: "40px"
components:
  button-primary:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.white}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  button-primary-hover:
    backgroundColor: "{colors.teal-hover}"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    padding: "11px 18px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    padding: "8px"
  field:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "11px 12px"
  panel:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.panel}"
  badge:
    rounded: "{rounded.badge}"
    padding: "4px 7px"
---

# Design System: Carrier sales POC

## Overview

**Creative North Star: "The operations desk"**

The existing interface pairs light paper and white surfaces with dark green ink and a restrained teal action color. Serif page headings separate major groups; compact sans-serif controls and records support operational reading. The north star uses the implemented section title, rather than introducing a new brand concept.

This is a source-derived record of the incumbent POC, grounded in `app/globals.css` and the call, map and operator components. Surface-specific composition remains in `docs/m5-design.md`; product scope remains in `PRODUCT.md`.

**Key Characteristics:**
- Light surfaces, green ink and restrained borders.
- Serif section headings with practical sans-serif data and controls.
- Spacious groups around compact operational records.
- Explicit state labels and visible keyboard focus.

## Colors

### Primary

Teal marks primary actions, links and detail affordances. Its deeper hover tone provides immediate feedback. The focus color gives keyboard users a separate, conspicuous outline.

### Neutral

Ink carries headings and primary facts; muted green carries supporting text. Paper forms the page background, white forms panels and fields, and the line color divides related records without heavy frames.

Route colors encode open, pending/other and selected states. Pending routes also use dashes, and selection also increases line weight. Success, danger and simulation badges use distinct pale fills with readable dark labels; preserve the source variants rather than treating their colors as new brand accents.

## Typography

Georgia with Times New Roman fallback supplies display and section headings. Arial with Helvetica fallback supplies the body, forms and records. Identifiers alone use monospace; times, OTP output and counts use tabular numerals.

The headline role drops to 26px on mobile. Operational text mostly uses 11–15px according to density, with 16px headings inside expanded details. OTP digits use a bold 30px treatment, increasing to 32px on mobile. Keep their letter spacing and single-line presentation. Long detail paragraphs are capped at 75ch.

## Layout

The centered page is capped at 1440px with 40px horizontal padding, changing to 52px above 1500px, 24px at 1100px and 16px at 760px. Reuse the observed spacing steps rather than adding a new scale.

At desktop widths, the call banner uses two columns, and lane coverage uses a wider map beside a load list. At 1100px, OTP stacks directly below the call controls. At 760px, the banner, map/list and call-detail columns stack; OTP remains in the call interaction group. Mobile call rows become two-column records and the desktop table heading disappears. The search form occupies a full row and its input can shrink within the viewport.

Scrollable lists have bounded height. The map fits the mobile container; zoom can create a scrollable map. City-label sizing is computed from rendered SVG width to retain approximately 12 screen pixels, including during zoom. Alaska and Hawaii have labeled insets. Dense network views label the hovered, focused or selected city; city, equipment and availability filters share one network snapshot. City selection includes incoming and outgoing lanes; marker and dropdown share the same city/state identity. Selecting a lane shows its equipment type and status below the map.

## Elevation & Depth

The system is flat at rest. White and pale green surfaces, borders and background changes establish groups and interaction states. The selected load row uses an inset two-pixel accent outline; it is a selection indicator, not a raised card shadow. There are no ambient drop shadows.

## Shapes

Small-radius badges, gently rounded fields and buttons, and larger-radius panels form the shape vocabulary in the frontmatter. Record rows remain rectangular and edge-aligned inside panels. Borders are generally one pixel. Avoid rounding each table record into a separate floating card.

## Components

### Buttons

Primary buttons are solid teal; secondary buttons are white with restrained borders; text actions are muted and underlined. Standard actions have a 44px minimum height. Map controls and pagination use smaller explicit variants. Hover transitions affect background and border over 150ms. Disabled actions reduce opacity and change the cursor. All keyboard-focusable controls share a three-pixel outline with a three-pixel offset, except map routes, whose focus changes the route itself. Reduced-motion preference disables transitions.

### Inputs / Fields

Fields use white backgrounds, a visible green-gray stroke and a minimum height of 44px. Labels sit above fields with a seven-pixel gap. Textareas are vertically resizable and at least 82px tall. Error notices use a warm pale background, visible border and dark error text; keep the accompanying message explicit.

### Cards / Containers

Coverage and calls share white panels with restrained borders, larger corners and clipped contents. Headings, lists and footers use dividers. The pale call banner is a separate, larger-radius grouping. Expanded call details use a faint tinted surface and two columns where space permits.

### Navigation

The header uses an ink wordmark with a divided subtitle; the workspace label disappears on mobile. Within calls, text tabs sit together and the active tab has a pale green fill. Review counts remain attached to the tab label.

### Chips

Status badges are compact, softly rounded and text-labeled. Booked, uncertain/error and simulation states have separate variants. Allow labels to wrap; retain the explicit simulation wording.

### Lane map and coordinated records

Geographic outlines, city endpoints and curved routes explain lane coverage. Open routes are solid; pending/other routes are dashed; selection and focus use a stronger blue line. Hovering or focusing a city highlights its connected routes while unrelated routes remain visible at 18% opacity. Clicking the selected city again restores all cities. Clicking or keyboard-activating a route selects its matching load row, which receives a pale fill and inset outline. Keep unmapped counts and coordinate-unavailable messages visible. Attribution and the approximate-location disclaimer belong with the map.

### Calls and operator review

Call rows expose the carrier, lane, outcome and open review reasons before expansion. Expanded details separate conversation context from review work. Review notes and actions remain adjacent. Loading, empty, unavailable and stale-data states use plain text in the affected panel.

## Do's and Don'ts

### Do:
- **Do** extend the incumbent light ink-and-teal system.
- **Do** preserve visible text labels alongside status colors.
- **Do** keep OTP adjacent to call controls as the layout stacks.
- **Do** retain geographic attribution, unmapped states and simulation labels.
- **Do** preserve readable records and keyboard focus at narrow widths.

### Don't:
- **Don't** imply vehicle tracking or fabricate geographic positions.
- **Don't** hide review reasons until the call is expanded.
- **Don't** add raised-card shadows to the flat operational panels.
