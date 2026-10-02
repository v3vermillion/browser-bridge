# The expert brief

Screenshots give an AI eyes. The brief gives it a professional's frame of reference **before** it looks,
so feedback comes from the standards, research, and current practice of the people who'd actually be
hired for this job, not from generic training-data instincts.

It is a way of working, not a form to fill in. Scale it to the request (see "How much"), and let the
user's direction steer it.

---

## The idea in one paragraph

Before viewing the site, work out **who the right experts are for this site and this question**, gather
what those experts would know that you might not apply by default (current standards, research, how the
best comparable sites actually do it right now), and write it down as criteria. Then look, and judge
against those criteria. Every finding must point back to a criterion and to what you saw. Anything that
can't is labeled as personal opinion.

---

## 1. Capture the human's direction (their words, then yours)

The user supplies the common sense and intent: "the purple and crimson feel bland", "the background
doesn't blend into the next section", "it should feel premium", "this is for families who are
struggling, not investors". Record it verbatim. Then translate each point into:

- the **professional vocabulary** an expert would use (e.g. "bland" -> low chroma, low value contrast,
  no focal accent; "doesn't blend" -> hard section seams, no transitional gradient or shared tone), and
- **checks you can actually run** (e.g. `perceive.py analyze` colorfulness, tonal range, seams; zoom on
  the transition; compare against references).

Show the user that translation briefly when it isn't obvious. It lets them correct you early, and over a
project it builds a shared language so later feedback stays consistent with what they want.

If the project has a `taste.md` / decisions file (see section 7), read it first: it records what this
user has already decided they like and don't.

## 2. Profile the context

Identify, from the site and the request:

- **Genre and purpose**: nonprofit, SaaS, e-commerce, local service, editorial, portfolio, agency /
  creative studio, government, event, etc. Mixed is common.
- **Brand intent**: calm and trustworthy? bold and experimental? luxury? playful? (Ask if it's unclear
  and it matters.)
- **Audiences and their jobs**: who arrives, and what must they be able to do?
- **Devices and conditions**: phone-first? older visitors? slow connections?

This decides everything below. A neon, motion-heavy studio site and a family-services nonprofit are
judged by different experts against different exemplars, even when the question ("critique the footer")
is identical.

## 3. Assemble the panel

Name the 3-7 roles a top agency or consultancy would actually put on this question, chosen for this
genre. Some patterns (illustrations, not a fixed menu):

- **Nonprofit**: development director (donor journey, giving UX), nonprofit communications lead
  (storytelling, dignity in language), UX lead, accessibility specialist, brand designer.
- **Creative agency / studio**: creative director, motion designer, interaction designer, front-end
  performance engineer (heavy visuals must still load and scroll smoothly), accessibility specialist.
- **E-commerce**: conversion/UX researcher, product photographer/art director, merchandiser, performance engineer.
- **SaaS**: product marketer (positioning and clarity), UX writer, visual designer, conversion specialist.

For each role, note what they'd look at first and what would make them wince. Narrow to the roles
relevant to the question: a footer critique doesn't need a motion designer unless the footer animates.

## 4. Build the reference base: floor, then ceiling

**Floor (applies to every site, every genre):** standards that aren't matters of taste.
- WCAG 2.2 AA (contrast, target size, focus visibility, consistent help, reduced motion, ...).
- Platform guidance where relevant (Apple Human Interface Guidelines, Material Design).
- Established usability research (e.g. Nielsen Norman Group, Baymard Institute; peer-reviewed HCI studies).

**Ceiling (situational: what excellent looks like for this genre, now):**
- Live exemplars: 3-5 strong, recent sites in the same genre, captured with this bridge using the same
  settings as the target (`examples/compare-sites.json` pattern). Measure them too: type scale, palette,
  spacing rhythm, section structure, how they handle the component in question.
- Genre-specific practice and research (e.g. donation-flow research for nonprofits; motion and
  performance practice for animation-heavy sites).
- Where they come from: showcases and awards that publish recent work (e.g. Awwwards, CSS Design Awards,
  Webby Awards, Mobbin-style pattern libraries), genre-specific "best of" collections from credible
  publishers, and the user's own references if they have them (always ask; theirs beat yours).

**Source quality, roughly in order:** standards bodies and platform owners > published research >
recognized practitioners' detailed write-ups > live exemplars (observed, not described) > everything
else. Avoid content-marketing listicles as sources of truth. Note dates: design practice moves faster
than standards.

**Where floor and ceiling conflict, the floor wins, and you say so.** A high-contrast neon aesthetic is
a legitimate ceiling; text that fails contrast or motion that ignores `prefers-reduced-motion` still fails
the floor. When a genre deliberately bends a usability convention (e.g. experimental navigation on a
studio site), frame it as a trade-off with its cost, not as an error.

## 5. Write the rubric, then look

Turn the panel's knowledge into a short list of criteria for this question. Each criterion:
`what good looks like` / `why (source)` / `how you'll check it` (screenshot, zoom, measurement, interaction).

Only then open the target. Use the lightest mode that can check each criterion:
glance for wording, batch capture for broad audits, a live session to interact, `perceive.py` and the
extractors for anything measurable.

## 6. Findings: the contract

Every finding states:

| Field | Meaning |
|---|---|
| What | The issue or opportunity, specifically ("footer links are 13px with 6px spacing on mobile") |
| Evidence | The screenshot/zoom/measurement you saw (file name) |
| Criterion | Which rubric line it fails or could exceed |
| Source | Where the criterion comes from |
| Lens | Which panel role raises it |
| Severity | blocks users / costs trust or conversions / polish |
| Confidence | high (measured or clearly visible) / medium / low |
| Fix | What to change, concretely; with a preview when a visual change is proposed (live `inject` + screenshot, or a rendered mockup) |

Anything that can't meet the contract goes under **Opinion** at the end, labeled as such. This is what
makes the expertise real rather than performed: a skipped brief shows up as findings with no criterion
and no source.

Finish with a **challenge pass**: for each panel role, ask "what would they push back on, and what did
I not check?" Add or downgrade findings accordingly.

## 7. Keep what you learn

- **Playbooks** (`playbooks/<topic>.md`, shared across projects via `bridge.py playbook get|put`): the
  reusable part of a brief - panel, floor criteria, ceiling criteria, sources with dates, exemplar
  notes - for a topic like `footer`, `hero`, `nonprofit-donation-flow`, `agency-portfolio-motion`.
  Load one if it exists and fits; refresh it if it's stale (older than ~3-6 months, or the context
  differs); save what you add.
- **Project taste / decisions file** (in the project's own repo, e.g. `taste.md`): the user's stated
  preferences and decisions ("prefers editorial serif headlines", "no stock photography", "rejected the
  dark theme"). Read it before every audit of that project; append when the user decides something.
  Record only what they actually said or chose.

## How much

| Request | Brief |
|---|---|
| Factual or wording check ("what does the footer say?") | None. Just answer. |
| One component ("critique the footer", "is the hero working?") | Focused: context profile, 2-4 panel roles, floor + 2-3 genre exemplars for that component, short rubric. A few minutes, faster with a playbook. |
| Redesign direction, full audit, "make it look like the best in its class" | Full: every relevant role, an exemplar set, measured comparison, rubric across all lenses, previews for major proposals. |

If you skip or shorten the brief, say so in one line ("quick take, no references gathered") so the
user knows what kind of answer they're getting.

## Honest limits

- This raises the floor and the consistency of feedback a lot. It does not manufacture taste: judgment
  still applies the rubric, and it can be wrong.
- Exemplars show what's working now in a genre; they are not designs to copy. Borrow qualities
  (hierarchy, rhythm, restraint, typographic discipline), not layouts, assets, or copy.
- Automated measurements (perceive.py, axe, Lighthouse) are evidence, not verdicts.
