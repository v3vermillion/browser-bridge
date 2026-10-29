# Brief: ship-readiness front-end review - caringforacauseindy.netlify.app - 2026-10-29
Depth: focused (scored ship-readiness verdict; front-end only, back-end features excluded)
## Direction (user's words)
- "thoroughly review ... as if you're a senior front end developer ... suitable for a professional quality ready to go site to ship? Score out of 100 (exclude back end features; visual/navigational, quality, graphics, front end criteria)"
## Context
- Genre: small family-services nonprofit (Central Indiana). Audiences: families seeking help (phone-first, possibly older devices), donors/sponsors, volunteers.
## Panel
- Senior front-end engineer (markup, CSS, responsiveness, perf, JS errors), UX lead (nav, IA, CTAs), accessibility specialist (WCAG 2.2 AA), visual/brand designer (type, imagery, spacing), nonprofit comms lead (copy quality, trust).
## Floor
- WCAG 2.2 AA (1.4.3 contrast, 2.4.7 focus visible, 2.5.8 target size, 1.1.1 alt), Lighthouse perf/a11y/BP/SEO, NN/g usability heuristics, Apple HIG 44pt targets.
## Rubric
| # | Criterion | How checked |
|---|---|---|
| R1 Visual design & polish | consistent type scale, spacing, imagery quality | full/tiles desktop+mobile, styles.json, images.json |
| R2 Layout & responsiveness | no overflow/breakage at phone/tablet/desktop, both engines | chromium+webkit x 3 devices |
| R3 Navigation & IA | working nav, mobile menu, anchors, clear CTAs | links.json, menu click step |
| R4 Accessibility | axe, contrast, focus, alt, form labels | a11y.json, tabWalk, forms.json |
| R5 Performance & code quality | Lighthouse, legacy deps, JS errors | lighthouse.json, network.json, html |
| R6 Content & trust | copy errors, placeholder text, dead links | text.md, checkLinks |
| R7 SEO/meta & share | title, description, OG, headings | meta.json |
