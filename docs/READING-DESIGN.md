# Reading design: typography, structure and colour

This document records **why the reader looks and behaves the way it does**. Each decision
below cites the evidence it rests on, and says honestly where the evidence is weak.

The short version:

1. **There is no single best text style.** People read up to 35% faster in the font that suits
   them. So BookMind ships research-backed *defaults* and lets every reader change them.
2. **Readers scan before they read.** They need visible structure (headings, lists, a sense of
   place) and a clear next step.
3. **Colour sets mood and signals meaning**, but only readable contrast actually helps reading.
   Every palette is machine-checked.

---

## 1. Text style (typography)

| Decision | Default | Evidence |
|---|---|---|
| **Let readers choose the typeface** (Aa panel): Literata, Atkinson Hyperlegible, classic serif, plain sans | Literata | Across 352 readers and 16 fonts, switching from a reader's slowest to fastest font raised speed by **35% with no loss of comprehension**, and the best font differed by person ([Wallace et al., 2022, *ACM TOCHI*](https://dl.acm.org/doi/10.1145/3502222); [summary](https://readabilitymatters.org/articles/towards-individuated-reading-experiences)). |
| **Literata** as the default body face | — | Designed for long-form reading on screens and used as the default in Google Play Books ([Literata](https://en.wikipedia.org/wiki/Literata); [TypeTogether](https://www.type-together.com/literata-font)). SIL Open Font License, bundled offline. |
| **Atkinson Hyperlegible** option | — | Built by the Braille Institute for low-vision readers. Easily confused characters (I/l/1, O/0, B/8) are deliberately differentiated ([Braille Institute](https://www.brailleinstitute.org/freefont/)). The settings sample line includes "Il1 O0 rn/m" so readers can see the difference. |
| **Serif vs sans is a preference, not a rule** | — | Controlled studies find no reliable speed or comprehension difference between common serif and sans faces on screen ([Bernard & Mills; see Human Factors International](https://www.humanfactors.com/Newsletters/more_about_fonts.html); [eye-tracking study](https://link.springer.com/chapter/10.1007/978-3-319-40355-7_55)). This is why both kinds are offered. |
| **Text size 19 px default, adjustable 15–28 px** | 19 px | Larger text measurably speeds reading, for readers with and without dyslexia; around 18 pt is recommended ([Rello et al., "Size Matters (Spacing not)", W4A 2013](https://pielot.org/pubs/Rello2013-W4A-SizeMatters.pdf)). |
| **Line length 55 / 66 / 75 characters** | 66 | 50–75 characters per line is optimal. About 55 cpl gave the best comprehension ([Dyson & Haselgrove 2001](https://www.sciencedirect.com/science/article/abs/pii/S1071581901904586); [Baymard](https://baymard.com/blog/line-length-readability)). The column is sized in `ch` of the *chosen* font, so the measure holds when the font changes. |
| **Line spacing 1.5 / 1.65 / 1.85** | 1.65 | WCAG 1.4.8 asks for at least 1.5 within paragraphs and larger paragraph spacing ([W3C](https://www.w3.org/WAI/WCAG21/Understanding/visual-presentation.html)). |
| **"Extra" letter & word spacing** option | off | Extra-large letter spacing improved reading in dyslexic children without training ([Zorzi et al., 2012, *PNAS*](https://www.pnas.org/doi/10.1073/pnas.1205566109)). The values used are WCAG 1.4.12's (0.12em letters, 0.16em words, 2em paragraphs). Hyphenation is switched off in this mode. |
| **Left-aligned, never justified** | always | Justification creates uneven "rivers" of white space that hurt readers with dyslexia; WCAG lists it as a failure ([W3C F88](https://www.w3.org/WAI/WCAG22/Techniques/failures/F88)). |
| **No ALL-CAPS headings** (converted to title case, acronyms kept) | always | Text in all capitals is read about **13% slower**, because words lose their shape ([Tinker & Paterson; review](https://legible-typography.com/en/5-overview-of-research-type)). The source PDFs use ALL CAPS heavily. |
| **No "Bionic Reading"** | — | Controlled studies found no speed benefit from bolding word beginnings ([Snell 2024, *Acta Psychologica*](https://www.sciencedirect.com/science/article/pii/S0001691824001811); [Readwise, 2,074 readers](https://blog.readwise.io/bionic-reading-results/)). It is deliberately not included. |
| **Light text on dark is optional, not the default** | Auto (follows device) | Dark text on a light background (positive polarity) was read faster, with fewer errors, by young and older adults ([Piepenbrock et al., 2013, *Ergonomics*](https://www.nngroup.com/articles/dark-mode/)). Dark mode stays one tap away for night reading and preference. |

## 2. Structure: helping readers follow through

The source text is extracted from PDFs, so it arrives hard-wrapped, with ALL-CAPS headings,
glyph bullets, page footers and (in the Roadmap) a blank line after every wrapped line.
`web/js/structure.js` rebuilds its structure before display. Tests in `tests/js` guarantee that
no content is lost.

| Feature | What the reader gets | Why |
|---|---|---|
| **Reflowed paragraphs** | Real paragraphs instead of a line break every 80 characters | Chunking into coherent paragraphs reduces load and supports scanning ([NN/g: chunking](https://www.nngroup.com/articles/chunking/)). |
| **Promoted headings**: Parts, Clauses, numbered sections, the Digest's questions | Headings that stand out in size, weight and colour | Readers scan headings first, in a "layer-cake" pattern; only about 16% read word by word ([NN/g: layer-cake scanning](https://www.nngroup.com/articles/layer-cake-pattern-scanning/)). Cues that highlight the organisation of material improve learning (Mayer's **signaling principle**, [Cambridge Handbook](https://www.cambridge.org/core/books/cambridge-handbook-of-multimedia-learning/signaling-or-cueing-principle-in-multimedia-learning/3972D4ACC628D5B53F7B2B4785DB2B06)). |
| **Hanging-indent clauses** `(1) (a) (b)` and bullets | Legal lists that line up like the printed Bill | The same signaling principle: list structure made visible. |
| **Sidebar contents** for the current document, with ✓ on sections already read | A map of where you are and what's around | Learner-controlled segments aid comprehension (Mayer's **segmenting principle**, [overview](https://educationaltechnology.net/mayers-principles-of-multimedia-learning/)). |
| **Live breadcrumb** (Document › Section › Subsection) that updates as you scroll | "You are here", always | Orientation for long documents. It uses the same source of truth as the sidebar highlight. |
| **Reading progress bar** and **"N min left in this document"** | A visible, shrinking distance to the goal | **Goal-gradient effect**: effort increases as a goal gets closer, and visible progress speeds completion ([Kivetz, Urminsky & Zheng 2006](https://journals.sagepub.com/doi/abs/10.1509/jmkr.43.1.39)). |
| **"Up next" at the end of each page** (next section, pages away, % read, Continue) | A clear next step at the natural stopping point | Same goal-gradient logic, and open goals pull people to resume them (**Ovsiankina / Zeigarnik** effect; the *resumption* tendency replicates well, the memory claim less so, per a [2025 meta-analysis](https://en.wikipedia.org/wiki/Zeigarnik_effect)). |
| **Resume where you left off** + **Return** after jumps | Interruption-proof reading | The same resumption tendency. |
| **Defined terms** (from the Bill's interpretation clause), dotted underline on first use, tap for the definition and its citation | Jargon explained in the law's own words, in place | Signaling key vocabulary. Shown once per page so the page isn't shouting at you. |
| **Focus mode** (optional): other paragraphs dim | Fewer distractions while reading or listening | Plausible, but *not strongly evidenced*, so it is off by default. |

## 2b. The research workspace (notebook)

Reading to understand a law is active work: marking, annotating, asking and gathering evidence.
The notebook supports that loop without leaving the page.

| Feature | Why |
|---|---|
| **Highlight** and **Note** straight from a selection; highlights shown back on the page | Keeping your own marks where they were made supports re-finding and review. It also makes readers select what matters, rather than saving everything. |
| **Your note** on any item, including AI answers | Writing in your own words (elaboration) is how understanding sticks; the answer alone is not the goal. |
| **Ask the documents** with page citations | Turns a question into evidence you can check. Answers say where they came from, and fall back to quoted passages when the model is unavailable. |
| **Research sessions** (one per topic) and **Export brief** | Segmenting a large task into topics (Mayer's segmenting principle), and ending with a tangible output that has references. |
| Filters, notebook search, **reading order** sort | Review follows the structure of the documents, not the order you happened to click. |

## 3. Colour: three palettes, three moods

Colour carries meaning and affects affect, cognition and behaviour, but its effects depend on
context ([Elliot & Maier 2014, *Annual Review of Psychology*](https://www.annualreviews.org/content/journals/10.1146/annurev-psych-010213-115035)).
So BookMind treats colour in two separate ways:

- **Mood** is a choice, offered as three palettes.
- **Readability** is never negotiable. Every text/background pair in every palette, in light and
  dark, is checked by `tools/themes.py` against WCAG (7:1 for body text; 4.5:1 for all other
  text). The build refuses to write the CSS if any of the 84 checks fails, and CI re-runs it.

| Palette | Source colours (all used) | Mood | Psychology |
|---|---|---|---|
| **Golden Hour** (default) | cream `#fbf5a3`, amber `#d8901e`, umber `#7f400e`, espresso `#1e0f0a` | Warm, immersive | Warm, low-glare paper tones for long sessions. Amber is used only for highlights, progress and buttons behind dark text, never as text on cream (that pair is only 2.4:1). |
| **Coastal Linen** | walnut `#866644`, slate `#8e9cab`, wheat `#cfb27c`, mist `#ccd0db`, sand `#d3b89e` | Cool, calm, analytical | Blue-grey is associated with openness and calm, and blue contexts produced an approach, exploratory motivation in [Mehta & Zhu 2009, *Science*](https://www.sciencedaily.com/releases/2009/02/090205142143.htm). Suited to careful study of the Bill. |
| **Terracotta Garden** | terracotta `#a66348`, ochre `#d89828`, moss `#354728`, sandstone `#c9a983`, twilight indigo `#232c42` | Earthy, grounded, restorative | Nature-derived colours echo **Attention Restoration Theory**: natural settings help recover depleted directed attention ([Kaplan; systematic review](https://www.tandfonline.com/doi/full/10.1080/10937404.2016.1196155)). Indigo chrome frames the page; moss carries links and simplified notes. |

**How each palette's colours are used.** Every colour is mapped to a *role*:

- page and background
- ink
- toolbars ("chrome")
- accent
- headings
- links
- secondary (simplified notes, Digest questions)
- reading highlight

Light-but-saturated colours (amber, ochre, wheat) are used as **fills behind dark text** or as
**highlights**, never as small text. The top edge of each page shows the palette's full colour
strip, so every colour is visible.

**What colour will not do.** Colour-psychology effects are real but small and context-bound
(Elliot & Maier). No palette is claimed to make you read faster; the palettes are there to make
reading *pleasant for you*, which is what keeps people reading.

---

## 4. Defaults, and how to change them

| Setting | Default | Options |
|---|---|---|
| Palette | Golden Hour | Golden Hour · Coastal Linen · Terracotta Garden |
| Brightness | Auto (follows the device) | Auto · Light · Dark |
| Typeface | Literata | Literata · Atkinson Hyperlegible · Classic serif · Plain sans |
| Text size | 19 px | 15–28 px |
| Line spacing | 1.65 | 1.5 · 1.65 · 1.85 |
| Line length | 66 characters | 55 · 66 · 75 |
| Letter spacing | Normal | Normal · Extra (WCAG 1.4.12) |
| Focus | Whole page | Whole page · Dim other paragraphs |

Settings are stored on the device and applied before the first paint, so there is no flash of
the wrong colours. "Reset to recommended" restores the research defaults.

## 5. Changing a palette

Edit the role mapping in `tools/themes.py`, run `python tools/themes.py`, and commit the
regenerated `web/css/themes.css`. If a change makes any text pair unreadable, the script prints
the failing pair and writes nothing.
