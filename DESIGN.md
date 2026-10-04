---
name: MagicBuyer
description: Incumbent navy and mint control panel, extracted from implemented UI.
colors:
  mb-bg: "#0c121c"
  mb-bg-2: "#111a27"
  mb-card: "rgba(255,255,255,0.045)"
  mb-card-2: "rgba(255,255,255,0.075)"
  mb-line: "rgba(255,255,255,0.08)"
  mb-text: "#e9eef6"
  mb-muted: "rgba(233,238,246,0.6)"
  mb-accent: "#6ff5cf"
  mb-accent-2: "#3fd9e8"
  mb-gold: "#e2bc4a"
  mb-ok: "#3ee0a0"
  mb-warn: "#ffb020"
  mb-err: "#ff5d6c"
  mb-info: "#5aa7ff"
  input-bg: "#0a111b"
  primary-ink: "#041319"
  danger-surface: "rgba(255,93,108,0.14)"
  danger-text: "#ff8e99"
typography:
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "15px"
    fontWeight: 750
    letterSpacing: "0px"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "12px"
    lineHeight: 1.4
    letterSpacing: "0px"
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "12.5px"
    fontWeight: 650
    letterSpacing: "0px"
  button:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0px"
  input:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "13.5px"
    fontWeight: 600
    letterSpacing: "0px"
  hint:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
    fontSize: "11px"
    lineHeight: 1.35
    letterSpacing: "0px"
rounded:
  small-button: "8px"
  input-tab: "9px"
  card-button: "10px"
  mb-radius: "12px"
  pill: "999px"
spacing:
  tab-gap: "4px"
  compact-gap: "6px"
  grid-gap: "8px"
  control-gap: "10px"
  section-gap: "12px"
  panel-gutter: "14px"
components:
  button-primary:
    textColor: "{colors.primary-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.card-button}"
    padding: "8px 12px"
  button-ghost:
    backgroundColor: "{colors.mb-card-2}"
    textColor: "{colors.mb-text}"
    typography: "{typography.button}"
    rounded: "{rounded.card-button}"
    padding: "8px 12px"
  button-danger:
    backgroundColor: "{colors.danger-surface}"
    textColor: "{colors.danger-text}"
    typography: "{typography.button}"
    rounded: "{rounded.card-button}"
    padding: "8px 12px"
  input:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.mb-accent}"
    typography: "{typography.input}"
    rounded: "{rounded.input-tab}"
    padding: "0px 10px"
    height: "34px"
  tab:
    textColor: "{colors.mb-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.input-tab}"
    padding: "7px 11px"
  field-card:
    backgroundColor: "{colors.mb-card}"
    rounded: "{rounded.mb-radius}"
    padding: "9px 10px"
  selected-chip:
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "6px 8px 6px 10px"
  preview-table:
    textColor: "{colors.mb-text}"
    rounded: "{rounded.card-button}"
---

# Design System: MagicBuyer

## Overview

**Creative North Star: "MagicBuyer control panel"**

This is a descriptive record of the implemented panel, rather than a newly chosen brand metaphor. Preserve its navy surfaces, mint controls, compact grouped fields, and visible operating status. The established right-edge panel provides the visual authority for extensions.

The interface concentrates controls into bordered translucent cards. Bright accents identify actions, selected targets, and prices; softer text supports labels and explanations. The header, operating controls, metrics, tabs, scrolling content, and log remain distinct parts of one panel.

**Key Characteristics:**

- Navy surfaces with mint and cyan interaction accents.
- Compact system typography with stronger labels and numeric values.
- Rounded translucent field cards and pill-shaped selections.
- Persistent operating status and a separately scrolling log.

Evidence: `app/ui/styles.js`, `app/ui/panel.js`, `app/ui/fields.js`, `app/ui/pages/target.js`, and `app/ui/pages/settingsPages.js`. The actual panel was inspected with synthetic EA providers at desktop (1440 × 1000) and mobile (375 × 812); the scoped reviewer independently inspected saved screenshots. DOM measurements at viewport widths 375, 414, 768, 1024 and 1440 showed no document-level horizontal overflow. These checks establish local layout behavior only; they do not establish live EA integration, real quote availability, or execution of trades. No PRODUCT.md exists, so no product-positioning claims are inferred here. The token frontmatter is normative; `.impeccable/design.json` supplies rendering snippets and properties outside that schema. Format reference: [DESIGN.md specification](https://raw.githubusercontent.com/google-labs-code/design.md/main/docs/spec.md).

## Colors

The palette combines dark navy layering with bright mint controls and restrained semantic highlights. Values retain the source CSS notation, including translucent colors.

### Primary

- **Mint accent** (`mb-accent`): selected tabs, input values, selected chips, live prices, and one end of the primary-action gradient.
- **Cyan accent** (`mb-accent-2`): the other end of the primary-action gradient, focus outline, and input border tint.

### Secondary

- **Warm gold** (`mb-gold`): filter price summaries, the logo gradient, and progress fill accents.

### Neutral

- **Deep navy** (`mb-bg`) and **raised navy** (`mb-bg-2`): the panel's vertical background gradient.
- **Translucent card** (`mb-card`) and **raised translucent card** (`mb-card-2`): field cards and secondary controls.
- **Quiet divider** (`mb-line`): borders and separators.
- **Pale text** (`mb-text`) and **muted text** (`mb-muted`): primary content and subordinate information.
- **Input navy** (`input-bg`): inset input and select surfaces.
- **Primary ink** (`primary-ink`): dark text on the mint/cyan primary action.

Success, warning, error, and informational states use `mb-ok`, `mb-warn`, `mb-err`, and `mb-info`. Danger actions use a translucent danger surface with lighter danger text. Start, Pause, and Stop have their own existing green, amber, and red source treatments; preserve those action distinctions.

**The Semantic Status Rule.** Preserve the implemented success, warning, error, and information color roles alongside readable state text.

## Typography

One native system font stack serves the panel. There is no separate display typeface or hero scale. The implementation forces inherited font family and zero letter spacing inside the panel and HUD.

- **Title:** the panel name uses the title token.
- **Body:** the body token describes informational notes; table and log copy have their own compact source rules.
- **Label:** field labels and tabs use the label token; section captions are smaller, bold, and uppercase.
- **Button:** regular actions use the button token; compact variants use a smaller source size.
- **Input:** input values use the input token.
- **Hint:** supporting explanations use the hint token.

Metrics and table prices use tabular numerals. Do not introduce a headline hierarchy absent from this compact control panel.

## Layout

The fixed panel attaches to the right edge, spans the viewport height, and uses a maximum desktop width (468px). Its width expression is `min(var(--mb-width), 100vw)`. At the source breakpoint (720px and below), it becomes viewport-wide and field grids collapse from two columns to one. Metrics retain four columns; tabs remain horizontally scrollable.

Header and content share the panel gutter. Form grids use the grid gap; action rows wrap and use the compact gap. Full-width fields span the whole grid. The body scrolls independently, and the resizable log defaults to part of the viewport height (34vh), bounded by its source minimum and maximum. The collapsed log height is (38px).

Category controls retain zero minimum width, full-width selects, and a larger minimum input height (44px). Exact Test search result buttons also have a minimum height (44px), wrap their text, and cap text width (14rem). Matching-transfer preview cells allow wrapping and break long content anywhere. These are contained extensions of the established panel.

The local fixture showed expected panel widths, no document-level horizontal overflow, and category controls contained within the panel at the five viewport widths above. Browser text scaling and a live EA page have not been established by this documentation pass.

## Elevation & Depth

Tonal layering distinguishes ordinary controls. Borders and low-opacity fills define cards without giving each card a shadow. Structural overlays carry shadows: the panel casts a leftward shadow (`-24px 0 60px rgba(0,0,0,0.5)`); autocomplete results use a downward shadow (`0 16px 36px rgba(0,0,0,0.5)`); the HUD uses (`0 12px 32px rgba(0,0,0,0.45)`). Soft cyan and gold radial washes sit over the panel's navy gradient.

The panel slides horizontally with the existing transition (0.22s ease). Switches transition over (0.15s), and the running status dot pulses over (1.6s). These source behaviors are recorded in the sidecar; this pass does not add a motion system.

## Shapes

Field cards use the `mb-radius` token. Regular buttons, metric cards, result menus, and preview containers use the card/button radius; inputs and tabs use the input/tab radius. Compact buttons use the small-button radius. Selected-item chips and the floating HUD are pills; status dots are circles. Preserve this existing distinction between rectangular controls and compact identity/status markers.

## Components

- **Actions:** primary buttons have a mint-to-cyan diagonal gradient with dark text. Ghost actions use a translucent raised surface. Danger actions use the documented danger treatment. Hover brightens regular actions; disabled controls lower opacity and show the unavailable cursor.
- **Fields:** labels sit above an inset navy input, followed by optional muted hints. Key fields add a mint-tinted border and background. Inputs focus with a mint border; panel buttons, inputs, and selects have a cyan keyboard-focus outline (2px, offset 2px). Invalid inputs change border/text treatment and expose `aria-invalid`.
- **Navigation:** tabs show muted inactive text, pale hover text, and mint active text on a mint-tinted background. Retain the scrolling tab strip.
- **Selection:** a selected item appears as a bounded mint-tinted chip with an accessible remove button. Its text truncates within available width.
- **Target categories:** manager, club, and consumable criteria use existing field-card and select primitives. Subtype and dependent criteria come from available provider data; unsupported choices are not decorative placeholders.
- **Test search:** item names are exact-selection buttons within the preview table. Numeric columns align right. Green rows indicate matching candidates within the displayed buy ceiling; muted rows show nonmatches. Selection is represented by the existing chip.
- **Price reference:** reference notes display the source, price, identity, and age when available. Warning notes communicate missing or unavailable references. These are data states, not a guarantee that a quote is available.
- **Matching listing:** the Transfers surface first shows a preview with Item, Reference, and Proposed BIN columns, including skip reasons. The listing action appears only when the prepared preview has eligible rows. Preserve the preview and status-note treatment.

Sidecar snippets are isolated visual examples, not working trading controls. They use source-token fallback values because the application declares variables on panel roots rather than globally. Synthetic tonal ramps are omitted: the implementation has no tonal-scale token family.

## Do's and Don'ts

### Do

- Do preserve the incumbent navy/mint panel and its compact grouped controls.
- Do reuse field cards, labels, hints, chips, notes, and action variants for extensions.
- Do retain readable status and reference-source text alongside color.
- Do contain category controls and wrapping preview content inside the panel.
- Do preserve keyboard-focus outlines and accessible control labels.

### Don't

- Don't replace the established visual identity while extending the panel.
- Don't turn every field card into a raised shadowed surface.
- Don't add display typography or a hero composition to the compact panel.
- Don't present synthetic fixture observations as proof of live EA data or trading behavior.
