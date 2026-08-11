# Mode: pdf — CV Generation (AltaCV is the default)

`/career-ops pdf` produces the **AltaCV** CV: two-column, photo-bearing, Swiss/European
style (`templates/cv-altacv.tex` + `templates/altacv.cls`). This is the project's
primary CV format and the one the batch worker produces, so manual and automated
runs emit the same document.

The HTML template and the classic single-column LaTeX template still exist and are
still maintained, but they are **opt-in fallbacks**. You never select one on your
own — see [Fallback formats](#fallback-formats).

---

## Output naming convention (one convention, used everywhere)

Every CV artefact — AltaCV, HTML fallback, classic fallback, Canva export — uses:

```
output/cv-{candidate}-{company-slug}-{YYYY-MM-DD}.{tex|pdf}
```

| Token | How it is derived | Example |
|-------|-------------------|---------|
| `{candidate}` | `config/profile.yml` → `candidate.full_name`, lowercased, accents folded to ASCII, every run of non-`[a-z0-9]` replaced by `-`, leading/trailing `-` trimmed. **All name parts, never abbreviated.** | `Alejandro Araujo Rajzner` → `alejandro-araujo-rajzner` |
| `{company-slug}` | Company name, same normalization. Matches the slug used in `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`. | `Digital Attitude` → `digital-attitude` |
| `{YYYY-MM-DD}` | Generation date | `2026-08-11` |

Reproduce the slug deterministically with:

```bash
printf '%s' "Alejandro Araujo Rajzner" | iconv -t ascii//TRANSLIT | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g'
```

Intermediate payload (not an artefact — `/tmp`, disposable):

```
/tmp/cv-{candidate}-{company-slug}.json     # AltaCV payload
/tmp/cv-{candidate}-{company-slug}.html     # HTML fallback only
```

The `.tex` is written next to the `.pdf` in `output/` on purpose: `generate-latex.mjs`
stages `altacv.cls` (and the photo) beside it, so the same directory can be
re-compiled or uploaded to Overleaf as-is.

**Never invent a different filename.** Scripts, the tracker, and report headers all
assume this exact shape.

---

## Format selection

| Invocation | Template | Toolchain |
|------------|----------|-----------|
| `/career-ops pdf {slug}` (**default**) | AltaCV, two-column, photo | `build-cv-altacv.mjs` → `generate-latex.mjs` |
| `/career-ops pdf {slug} --html` | `templates/cv-template.html` | `generate-pdf.mjs` (Playwright) |
| `/career-ops pdf {slug} --classic` (same as `/career-ops latex`) | `templates/cv-template.tex`, single column, no photo | `build-cv-latex.mjs` → `generate-latex.mjs` (schema in `modes/latex.md`) |

**Rules for picking a format:**

1. **Default to AltaCV. Always.** No flag, no explicit request → AltaCV. Do not
   infer a fallback from the market, the ATS, the JD, or the company.
2. A fallback requires an **explicit** signal: the `--html` / `--classic` flag, or
   the user asking for it in words ("the ATS-lean one", "the US-style single-column
   version", "the HTML one").
3. **One automatic exception — CJK.** `generate-latex.mjs` refuses Japanese /
   Chinese / Korean text (both LaTeX templates are pdfLaTeX/XeLaTeX setups with no
   CJK font, and the check runs before compilation). For a CJK CV, say so and fall
   back to `--html`, which renders CJK via the `lang="ja"` font fallback in
   `cv-template.html`.
4. `cv.output_format` in `config/profile.yml` is **legacy and no longer routes the
   format.** Both of its historical values (`"html"`, `"latex"`) now resolve to
   AltaCV. It is kept only so old profiles do not break. A stale value must never
   silently produce the wrong format.
5. Rules in `modes/_custom.md` (§House Rules) override this table if they conflict.

---

## Pipeline (default — AltaCV)

1. Read `cv.md` as the source of truth, plus `config/profile.yml` for identity and contact info
2. Ask the user for the JD if it is not in context (text or URL)
3. Extract 15-20 keywords from the JD
4. Detect JD language → CV language (EN default). CJK → see rule 3 above
5. Detect role archetype → adapt framing
6. Build an internal recruiter-side risk map from the JD using `modes/heuristics/recruiter-side.md`: likely doubts, matching evidence, and which document section should address each doubt
7. **Write `summary` (the "About Me" block) as positioning, not as an inventory.** It answers *"why this person, for THIS opening?"* — role-matched identity, the employer's problem and the candidate's angle on it, 1-2 quantified proofs chosen for this JD, and the differentiator only they have. Cut any sentence that would be true of any competent candidate in the field; tool and compliance lists belong in `skill_tags`, not here. The long-form version of this rule (with the discard test and the forbidden list) is in `batch/batch-prompt.md` → Paso 4 → step 5. Apply the exit narrative from `modes/_profile.md` and any rule in `modes/_custom.md` (§House Rules) — those take precedence.
8. Select the top 3-4 most relevant projects/roles for the job
9. Reorder experience bullets by JD relevance and by the risk map: strongest matching evidence first
10. Build `skill_tags` (6-8 keyword phrases, grouped into rows)
11. Inject keywords naturally into existing achievements (**NEVER invent**)
12. Apply the six-second clarity gate from `modes/heuristics/recruiter-side.md`: the top third must make target role, strongest fit, and proof obvious
13. Compute `{candidate}` and `{company-slug}` per the naming convention above
14. Write the JSON payload to `/tmp/cv-{candidate}-{company-slug}.json` using the [AltaCV payload schema](#altacv-payload-schema) below
15. Run the two commands in [Commands](#commands)
16. **Verify the PDF exists before reporting success** (see [Verification](#verification))
17. Report: `.tex` path, `.pdf` path, file size, page count, keyword coverage %

### Commands

Both steps, exactly as the batch worker runs them (`batch/batch-prompt.md` → Paso 4 → step 11).
The second command validates **and** compiles.

```bash
node build-cv-altacv.mjs \
  /tmp/cv-{candidate}-{company-slug}.json \
  output/cv-{candidate}-{company-slug}-{YYYY-MM-DD}.tex

node generate-latex.mjs \
  output/cv-{candidate}-{company-slug}-{YYYY-MM-DD}.tex \
  output/cv-{candidate}-{company-slug}-{YYYY-MM-DD}.pdf
```

These match the scripts' own usage strings:

- `node build-cv-altacv.mjs <input.json> <output.tex>` (also `node build-cv-altacv.mjs --test` for a self-test that needs no payload)
- `node generate-latex.mjs <input.tex> [output.pdf]` — the template is detected from `\documentclass`, so there is no format flag to get wrong

### Verification

`generate-latex.mjs` prints a JSON report and exits non-zero when the compile fails.

- `"template"` must be `"altacv"`. If it says `"classic"`, the `.tex` was built by the
  wrong builder.
- `"valid": false` → read `issues` (missing `\makecvheader` / `\cvevent`, fewer than 4
  `\cvsection{}` blocks, unresolved `{{PLACEHOLDER}}`, CJK text). Nothing is compiled
  in this case.
- `"compiled": true|false` → **a valid `.tex` does not imply a PDF.** If a LaTeX
  package is missing the compiler aborts without producing a file. On `false`, read
  `compileError`.
- Expect `engine: "pdflatex"` for AltaCV (deliberate — the tectonic/XeTeX branch needs
  Lato installed as a system font; pdflatex uses the bundled Type1 `lato`).
- A healthy AltaCV PDF is **~2.5 MB** because of the embedded photo. A ~80 KB PDF means
  the photo was dropped or the classic template was used.

If `compiled` is `false` or the file is not there, treat the PDF as not generated
(tracker `pdf_emoji` = `❌`) and put the error in the notes. Never report a path you
have not confirmed exists.

### Photo

Do **not** put a photo in the payload. `build-cv-altacv.mjs` resolves it itself:
`payload.photo` if you set it, otherwise a case-insensitive scan of `assets/` for
`headshot.{jpg,jpeg,png}`. It copies the file next to the output `.tex` so the compile
finds it. If nothing is found it compiles without a photo and adds a `warning` field to
its JSON output — check for it.

This is independent of `candidate.photo` in `config/profile.yml`, which only drives the
`{{PHOTO}}` slot of the **HTML** fallback.

---

## AltaCV payload schema

**This is the AltaCV schema. It is NOT the schema in `modes/latex.md`** — that one
documents the classic single-column template and uses different field names
(`contact_line`, `projects`, `skills[].category`). Mixing them produces a `.tex` with
empty sections. This schema is the same one used by `batch/batch-prompt.md` → Paso 4 →
step 10; keep the two identical.

```json
{
  "name": "<config/profile.yml full_name>",
  "tagline": "<target title, e.g. the role from the JD>",
  "personal": {
    "phone": "...", "email": "...", "location": "...",
    "linkedin": "<handle, no URL>", "github": "<handle>",
    "citizenship": ["..."]
  },
  "summary": "<positioning summary from step 5>",
  "experience": [
    { "role": "...", "company": "...", "company_url": "", "dates": "...",
      "location": "...", "bullets": ["...", "..."] }
  ],
  "achievements": [{ "icon": "faGem", "title": "...", "detail": "..." }],
  "skill_tags": [["Kw1", "Kw2"], ["Kw3"]],
  "education": [{ "degree": "...", "institution": "...", "dates": "...", "location": "" }],
  "certifications": [{ "title": "...", "detail": "" }],
  "languages": [{ "name": "English", "level": 5 }],
  "previous_experience": [{ "role": "...", "company": "...", "dates": "...", "location": "" }]
}
```

- `languages[].level` is 1-5. `icon` must be a valid FontAwesome icon (`faGem`, `faHeart`, `faChartLine`…).
- **Do not escape LaTeX**: `build-cv-altacv.mjs` escapes everything. Pass plain text.
- The photo resolves itself from `assets/headshot.png` — do not put it in the payload.

> The block above is kept **byte-identical** to `batch/batch-prompt.md` → Paso 4 → step 10
> so the two paths cannot drift. `"from step 5"` is that file's numbering for the
> positioning summary; in this file's pipeline it is **step 7**. If you change one copy,
> change both.

Field notes:

| Field | Renders as | Notes |
|-------|-----------|-------|
| `tagline` | Line under the name | The target title, not the current one |
| `personal` | Header contact block | `linkedin` / `github` are handles, not URLs |
| `summary` | "About Me" | 5-6 sentences, ~120 words max — longer pushes the layout onto a 3rd page |
| `experience[]` | `\cvevent` entries, main column | Top 3-4 roles, bullets reordered by JD relevance |
| `previous_experience[]` | Compact "earlier roles" list | Older roles with no bullets — keeps page count down |
| `achievements[]` | Sidebar "Key Achievements" | `icon` + `title` + `detail` |
| `skill_tags` | Sidebar `\cvtag` pills | Array **of arrays** — each inner array is one visual row |
| `languages[]` | Sidebar rating bars | `level` 1-5 |

`skills[]` in the classic shape (`{ "category": …, "items": … }`) is accepted as a
fallback and flattened into tags, but prefer `skill_tags` — it controls the row layout.

---

## ATS notes

AltaCV is a **designed two-column CV with a photo**. That is a deliberate trade-off for
the Swiss/European market (see `modes/_custom.md`), not an oversight:

- Text is real, selectable UTF-8 — no rasterization, no text inside images.
- Two columns and a photo can still degrade parsing in strict ATS-first markets
  (US/UK/Canada/Australia), where photos may also trip bias-avoidance filters.
- When the user wants a strict-ATS document, that is exactly what `--classic`
  (single-column, no photo, `\pdfgentounicode=1`) and `--html` are for. Offer it; do
  not switch on your own.

Rules that hold on every format:

- Standard section names: "About Me"/"Professional Summary", "Experience", "Education", "Skills", "Certifications", "Projects"
- No critical information in headers/footers (ATS ignores them)
- No nested tables, no text baked into images
- Keywords distributed: summary (top 5), first bullet of each role, skills/tags
- No hidden text, keyword stuffing, or white-font tricks. Optimize for parseability *and* human review.

## Recruiter review gates

- The summary should answer: "What role is this person targeting, and why this one?"
- The first screen should show 1-2 proof points that map to the JD's highest-risk requirements.
- Bullets should emphasize outcomes, systems, users, or business effects rather than task history.
- Logistics such as location, work authorization, salary, and availability belong in the CV only when appropriate for the market and profile; otherwise handle them in form answers or recruiter scripts.

## Keyword injection strategy (ethical, truth-based)

Examples of legitimate reformulation:
- JD says "RAG pipelines" and CV says "LLM workflows with retrieval" → change to "RAG pipeline design and LLM orchestration workflows"
- JD says "MLOps" and CV says "observability, evals, error handling" → change to "MLOps and observability: evals, error handling, cost monitoring"
- JD says "stakeholder management" and CV says "collaborated with team" → change to "stakeholder management across engineering, operations, and business"

**NEVER add skills that the candidate does not have. Only reword real experience using the exact JD vocabulary.**

---

## Fallback formats

Both fallbacks are fully supported. Neither is ever selected automatically (except the
CJK rule above).

### Fallback A — HTML → PDF (`--html`)

Playwright renders `templates/cv-template.html`. Use it when the user asks for it, or
for CJK CVs.

Steps 1-13 of the AltaCV pipeline are unchanged. Then:

1. Fill the `{{...}}` placeholders in `cv-template.html` (table below)
2. Write the HTML to `/tmp/cv-{candidate}-{company-slug}.html`
3. Run:

```bash
node generate-pdf.mjs \
  /tmp/cv-{candidate}-{company-slug}.html \
  output/cv-{candidate}-{company-slug}-{YYYY-MM-DD}.pdf \
  --format={letter|a4}
```

Matches the script's usage string: `node generate-pdf.mjs <input.html> <output.pdf> [--format=letter|a4]`.

Paper format: US/Canada → `letter`; rest of the world → `a4`.

**HTML placeholders:**

| Placeholder | Content |
|-------------|-----------|
| `{{LANG}}` | CV language code (e.g. `en`, `es`, `ja`, `ar`). Drives language-specific CSS in the template: `ja` enables a CJK font fallback so Japanese renders instead of tofu (□); `ar` enables RTL + Arabic fonts. Use the BCP-47/ISO-639 code that matches the CV language. |
| `{{PAGE_WIDTH}}` | `8.5in` (letter) or `210mm` (A4) |
| `{{PHOTO}}` | Opt-in profile photo (#264). When `profile.yml` has a non-empty `candidate.photo`, replace with `<img class="cv-photo" src="<path-or-data-URL>" alt="{{NAME}}">`; otherwise **remove the whole `{{PHOTO}}` line** so no markup (and no `<img>`) is emitted. Opt-in for DACH/European markets — an absent photo renders identically (pixel-for-pixel) to the photoless layout (US/UK and many-market ATS penalize photos). |
| `{{NAME}}` | (from profile.yml) |
| `{{PHONE}}` | (from profile.yml — include with its separator only when `profile.yml` has a non-empty `phone` value; omit both the `<a href="tel:…">` element and the following `<span class="separator">` otherwise) |
| `{{EMAIL}}` | (from profile.yml) |
| `{{LINKEDIN_URL}}` | [from profile.yml] |
| `{{LINKEDIN_DISPLAY}}` | [from profile.yml] |
| `{{PORTFOLIO_URL}}` | [from profile.yml] (or /es depending on language) |
| `{{PORTFOLIO_DISPLAY}}` | [from profile.yml] (or /es depending on language) |
| `{{LOCATION}}` | [from profile.yml] |
| `{{SECTION_SUMMARY}}` | Professional Summary |
| `{{SUMMARY_TEXT}}` | Personalized summary with keywords |
| `{{SECTION_COMPETENCIES}}` | Core Competencies |
| `{{COMPETENCIES}}` | `<span class="competency-tag">keyword</span>` × 6-8 |
| `{{SECTION_EXPERIENCE}}` | Work Experience |
| `{{EXPERIENCE}}` | HTML for each job with reordered bullets |
| `{{SECTION_PROJECTS}}` | Projects |
| `{{PROJECTS}}` | HTML for top 3-4 projects |
| `{{SECTION_EDUCATION}}` | Education |
| `{{EDUCATION}}` | Education HTML |
| `{{SECTION_CERTIFICATIONS}}` | Certifications |
| `{{CERTIFICATIONS}}` | Certifications HTML |
| `{{SECTION_SKILLS}}` | Skills |
| `{{SKILLS}}` | Skills HTML |

**HTML design tokens** (the AltaCV template has its own; these apply to the HTML
fallback only):

- **Fonts**: Space Grotesk (headings, 600-700) + DM Sans (body, 400-500), self-hosted in `fonts/`
- **Header**: name in Space Grotesk 24px bold + gradient line `linear-gradient(to right, hsl(187,74%,32%), hsl(270,70%,45%))` 2px + contact row
- **Section headers**: Space Grotesk 13px, uppercase, letter-spacing 0.05em, cyan primary
- **Body**: DM Sans 11px, line-height 1.5 — **Company names**: purple `hsl(270,70%,45%)`
- **Margins**: 0.6in — **Background**: pure white
- **Section order**: Header → Professional Summary → Core Competencies → Work Experience → Projects → Education & Certifications → Skills

**Profile photo (opt-in, market-specific):** the `{{PHOTO}}` slot is off by default.
DACH / continental Europe: a professional photo is standard — opt in by setting
`candidate.photo` in `config/profile.yml` (local path or `data:` URL). US / UK / Canada
/ Australia and ATS-first markets: leave it empty — the `{{PHOTO}}` line is dropped
entirely and the CV renders pixel-for-pixel identical to the photoless layout. When set,
the photo floats into the top corner (mirrored for RTL/Arabic); `.cv-photo` in
`cv-template.html` controls size and framing.

### Fallback B — classic single-column LaTeX (`--classic`)

`templates/cv-template.tex` via `build-cv-latex.mjs` → `generate-latex.mjs`. Single
column, no photo, `\pdfgentounicode=1`, Overleaf-ready with stock CTAN packages. The
ATS-lean / US-style option.

Full pipeline and **its own, different** JSON schema: `modes/latex.md`.

```bash
node build-cv-latex.mjs \
  /tmp/cv-{candidate}-{company-slug}.json \
  output/cv-{candidate}-{company-slug}-{YYYY-MM-DD}.tex

node generate-latex.mjs \
  output/cv-{candidate}-{company-slug}-{YYYY-MM-DD}.tex \
  output/cv-{candidate}-{company-slug}-{YYYY-MM-DD}.pdf
```

---

## Canva CV Generation (optional)

If `config/profile.yml` has `cv.canva_resume_design_id` set, offer the user a choice before generating:
- **"AltaCV (default, LaTeX, two-column)"** — the flow above
- **"Canva CV (visual, design-preserving)"** — the flow below

If the user has no `cv.canva_resume_design_id`, skip this prompt and use the AltaCV flow.

### Canva workflow

#### Step 1 — Duplicate the base design

a. `export-design` the base design (using `cv.canva_resume_design_id`) as PDF → get download URL
b. `import-design-from-url` using that download URL → creates a new editable design (the duplicate)
c. Note the new `design_id` for the duplicate

#### Step 2 — Read the design structure

a. `get-design-content` on the new design → returns all text elements (richtexts) with their content
b. Map text elements to CV sections by content matching:
   - Look for the candidate's name → header section
   - Look for "Summary" or "Professional Summary" → summary section
   - Look for company names from cv.md → experience sections
   - Look for degree/school names → education section
   - Look for skill keywords → skills section
c. If mapping fails, show the user what was found and ask for guidance

#### Step 3 — Generate tailored content

Same content generation as steps 1-12 of the AltaCV pipeline:
- Rewrite the summary as positioning with JD keywords + exit narrative
- Reorder experience bullets by JD relevance
- Select top competencies from JD requirements
- Inject keywords naturally (NEVER invent)

**IMPORTANT — Character budget rule:** Each replacement text MUST be approximately the same length as the original text it replaces (within ±15% character count). If tailored content is longer, condense it. The Canva design has fixed-size text boxes — longer text causes overlapping with adjacent elements. Count the characters in each original element from Step 2 and enforce this budget when generating replacements.

#### Step 4 — Apply edits

a. `start-editing-transaction` on the duplicate design
b. `perform-editing-operations` with `find_and_replace_text` for each section:
   - Replace summary text with tailored summary
   - Replace each experience bullet with reordered/rewritten bullets
   - Replace competency/skills text with JD-matched terms
   - Replace project descriptions with top relevant projects
c. **Reflow layout after text replacement:**
   After applying all text replacements, the text boxes auto-resize but neighboring elements stay in place. This causes uneven spacing between work experience sections. Fix this:
   1. Read the updated element positions and dimensions from the `perform-editing-operations` response
   2. For each work experience section (top to bottom), calculate where the bullets text box ends: `end_y = top + height`
   3. The next section's header should start at `end_y + consistent_gap` (use the original gap from the template, typically ~30px)
   4. Use `position_element` to move the next section's date, company name, role title, and bullets elements to maintain even spacing
   5. Repeat for all work experience sections
d. **Verify layout before commit:**
   - `get-design-thumbnail` with the transaction_id and page_index=1
   - Visually inspect the thumbnail for: text overlapping, uneven spacing, text cut off, text too small
   - If issues remain, adjust with `position_element`, `resize_element`, or `format_text`
   - Repeat until layout is clean
e. Show the user the final preview and ask for approval
f. `commit-editing-transaction` to save (ONLY after user approval)

#### Step 5 — Export and download PDF

a. `export-design` the duplicate as PDF (format: a4 or letter based on JD location)
b. **IMMEDIATELY** download the PDF using Bash:
   ```bash
   curl -sL -o "output/cv-{candidate}-{company-slug}-canva-{YYYY-MM-DD}.pdf" "{download_url}"
   ```
   The export URL is a pre-signed S3 link that expires in ~2 hours. Download it right away.
c. Verify the download:
   ```bash
   file output/cv-{candidate}-{company-slug}-canva-{YYYY-MM-DD}.pdf
   ```
   Must show "PDF document". If it shows XML or HTML, the URL expired — re-export and retry.
d. Report: PDF path, file size, Canva design URL (for manual tweaking)

#### Error handling

- If `import-design-from-url` fails → fall back to the AltaCV pipeline with a message
- If text elements can't be mapped → warn user, show what was found, ask for manual mapping
- If `find_and_replace_text` finds no matches → try broader substring matching
- Always provide the Canva design URL so the user can edit manually if auto-edit fails

---

## Cover Letter Sub-flow

After generating the CV PDF, offer to generate a cover letter:

```text
CV PDF generated: output/cv-{candidate}-{company-slug}-{YYYY-MM-DD}.pdf

Want a cover letter for this role too?
- Say "yes" or "cover letter" to generate one now
- Or run `/career-ops cover {slug}` later
```

Apply `voice-dna.md` (if present) to the cover letter — full guardrail, conversational voice included (Tier 1 + Tier 2). The CV PDF itself stays Tier 1 only (formal ATS register). See `_shared.md` → Voice DNA.

If the user says yes, run the full cover letter flow from `modes/cover.md` in slug mode:
1. Load the existing `## Cover Letter Draft` from the evaluation report as a starting point
2. Run company research (Step 3 of cover.md)
3. Present keyword list for confirmation (Step 4)
4. Surface any gaps (Step 5)
5. Ask the four prompts: why / problems / approach / tone (Step 6)
6. Draft in chat, wait for approval (Steps 7-8)
7. Generate cover letter PDF via `node generate-cover-letter.mjs` (Step 9)
8. Report both PDF paths

Do not auto-generate the cover letter PDF without going through the interactive steps above.

## Post-generation

Update tracker if the job is already registered: change PDF from ❌ to ✅.
