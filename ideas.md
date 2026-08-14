# Habit Tracker Design Direction

## Three Initial Approaches

### Theme Name: Quiet Garden
Very Brief Intro: A calm, tactile wellness dashboard inspired by a morning journal, with paper-like surfaces, botanical marks, and slow, reassuring feedback.
Probability: 0.03

### Theme Name: Signal / Streak
Very Brief Intro: A high-contrast editorial dashboard that treats habit data like a daily signal, pairing strong type with focused blocks of color and crisp progress cues.
Probability: 0.07

### Theme Name: Sunday Desk
Very Brief Intro: A warm, analog productivity workspace with tabbed notes, ink accents, and a friendly sense of physical ritual rather than gamified pressure.
Probability: 0.02

## Chosen Approach: Signal / Streak

### Design Movement
Contemporary editorialism with Swiss-influenced information design and a humane, paper-and-ink utility layer. The app should feel like a well-designed daily newspaper for the user's own attention: clear, calm, and purposeful.

### Core Principles
1. **Progress is a signal, not a score.** Visual hierarchy should make today's next action obvious without turning self-care into a leaderboard.
2. **Editorial contrast creates clarity.** Use oversized numerals, compact labels, and offset blocks to give the interface a distinct reading rhythm.
3. **Warm utility over sterile productivity.** Surfaces feel like paper and ink, with a single bright signal color for completion and focus.
4. **Small rituals deserve visible acknowledgement.** Completion states should feel satisfying through color, motion, and copy without becoming noisy.

### Color Philosophy
The foundation is warm chalk (#F4F1EA) and deep ink (#20231F), which keeps the interface grounded and legible in long sessions. A saturated saffron-orange (#E86A33) is the ownable signal color: it marks a completed action, highlights the current day, and adds optimism without the aggression of neon. Muted moss and clay tones support secondary categories, while a translucent graphite wash creates depth for utility controls. No gradients are necessary; the visual richness comes from tonal layers, hairline rules, and offset composition.

### Layout Paradigm
Use a persistent left rail and an asymmetric two-column workspace. The main dashboard begins with an offset editorial header, then flows into a wide weekly signal strip and a narrower “next up” rail. Cards should not all share the same radius or width; some are open blocks divided by rules, others are compact contained modules. On smaller screens, the rail becomes a top utility bar and the workspace stacks while preserving the offset rhythm.

### Signature Elements
1. **Signal bars:** a seven-day row of vertical marks whose height and fill show completion rhythm at a glance.
2. **Index labels:** small uppercase labels with a numeric prefix, used like magazine section markers.
3. **Saffron check tiles:** completed habits use an intentional square check tile rather than a generic circular checkbox.

### Interaction Philosophy
Interactions should be immediate and legible. Completing a habit changes its signal tile, updates the day summary, and gives a short “marked for today” confirmation. Adding a habit should feel like filing a new index card: a focused drawer or inline form, not a long multi-step wizard. Destructive actions stay quiet and explicit, while the primary completion action is always easy to find by keyboard and touch.

### Animation
Use short, physical transitions under 240ms with a cubic-bezier ease-out. On first load, the header and signal strip reveal with a restrained 40ms stagger per major block. Completion tiles should use a 160ms scale-and-color transition, never a bouncing celebration. New habit rows slide in from the right by 8px with opacity, while removed rows collapse only after the user confirms. Respect `prefers-reduced-motion` by disabling entrance transforms and keeping state changes to color and outline.

### Typography System
Use **DM Sans** for body copy and controls: highly readable, human, and compact. Use **Space Grotesk** for display numbers, section headings, and index labels: geometric enough to make the signal system feel intentional without becoming futuristic. H1 is 48–64px with tight tracking on desktop and 38px on mobile. Section headings are 18–22px semibold. Index labels are 10–11px uppercase with 0.14em tracking. Body text is 14–16px with generous line height. Numbers should use tabular figures wherever progress counts are shown.

### Brand Essence
**A daily signal board for building small, repeatable habits—designed for people who want clarity without pressure.**

Personality adjectives: **clear, grounded, quietly optimistic**.

### Brand Voice
Headlines are direct and observant, never breathless. CTAs use concrete verbs. Microcopy acknowledges effort without overpraising it.

Example lines:

> Keep the signal moving.

> One mark today is enough to change the week.

### Wordmark & Logo
The mark is a compact “signal flag”: three uneven vertical bars arranged inside an open square, with the tallest bar offset slightly to the right. It works as a bold, text-free icon in the rail and favicon. The wordmark uses a custom treatment of the name with a square period after “Habit” to echo the signal tile, but the icon should carry the identity at small sizes.

### Signature Brand Color
**Signal Saffron — #E86A33.** It is warm, visible, and action-oriented, reserved for completion, focus, and the small moments where the app says “this counts.”

## Style Decisions

- The interface will use a light, paper-and-ink foundation rather than a dark neon treatment.
- The primary layout will be asymmetric and editorial, not a centered template of identical cards.
- The generated signal-flag icon will appear in the header rail and favicon-sized contexts.
- Data will be stored locally in the browser so the app works immediately without an account or server.
