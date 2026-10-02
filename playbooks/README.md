# Playbooks

Reusable expert knowledge for a topic (`footer.md`, `hero.md`, `nonprofit-donation-flow.md`,
`agency-portfolio-motion.md`, ...): the panel, floor and ceiling criteria, sources with dates, and
exemplar notes. Written by AI assistants during real audits (see docs/expert-brief.md) and shared across
projects so research compounds instead of repeating.

- `python3 client/bridge.py playbook list | get NAME | put NAME FILE`
- Keep each playbook topic-level and genre-tagged; project-specific decisions belong in that project's
  own taste/decisions file, not here.
- Date every source. Refresh when stale or when a new context doesn't fit.
