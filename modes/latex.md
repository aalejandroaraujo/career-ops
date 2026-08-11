# Mode: latex — LaTeX/Overleaf CV Export

> ## ⚠️ Two LaTeX templates. This file documents the CLASSIC one.
>
> | | AltaCV (**default**) | Classic (this file) |
> |---|---|---|
> | Template | `templates/cv-altacv.tex` + `altacv.cls` | `templates/cv-template.tex` |
> | Layout | Two-column, photo, Swiss/European | Single column, no photo, ATS-lean |
> | Builder | `build-cv-altacv.mjs` | `build-cv-latex.mjs` |
> | Compiler | `generate-latex.mjs` (both — template detected from `\documentclass`) | ← same |
> | **JSON schema** | `tagline` / `personal` / `achievements` / `skill_tags` / `languages` / `previous_experience` — **documented in `modes/pdf.md` → "AltaCV payload schema"** | `contact_line` / `projects` / `skills[].category` — **documented below** |
>
> **`/career-ops latex` with no flag produces AltaCV**, exactly like `/career-ops pdf`.
> Follow `modes/pdf.md`. The classic template below is an **opt-in fallback**, reached
> with `/career-ops latex --classic` (or `/career-ops pdf --classic`), or when the user
> asks for the ATS-lean / US-style / single-column version in words.
>
> **The two schemas are not interchangeable.** They share only `name`, `experience`,
> and `education`. Feeding the classic schema below to `build-cv-altacv.mjs` produces a
> `.tex` with an empty header, no tagline, no skills and no sidebar — it does not error,
> it just silently drops everything it does not recognize. This mismatch has already
> caused one broken implementation. Check which builder you are calling before you write
> the payload.

Export a tailored, ATS-optimized CV as a `.tex` file and compile it to PDF via `tectonic` or `pdflatex`.

## Pipeline (classic template — `--classic` only)

1. Read `cv.md` as source of truth
2. Read `config/profile.yml` for candidate identity and contact info
3. Ask the user for the JD if not already in context (text or URL)
4. Extract 15-20 keywords from the JD
5. Detect JD language → CV language (EN default)
6. Detect role archetype → adapt framing
7. Rewrite Professional Summary injecting JD keywords (same rules as `pdf` mode — NEVER invent skills)
8. Select top 3-4 most relevant projects for the offer
9. Reorder experience bullets by JD relevance
10. Inject keywords naturally into existing achievements
11. Build a JSON payload (**classic schema below**) and write to `/tmp/cv-{candidate}-{company-slug}.json`
12. Run both commands:

```bash
node build-cv-latex.mjs \
  /tmp/cv-{candidate}-{company-slug}.json \
  output/cv-{candidate}-{company-slug}-{YYYY-MM-DD}.tex

node generate-latex.mjs \
  output/cv-{candidate}-{company-slug}-{YYYY-MM-DD}.tex \
  output/cv-{candidate}-{company-slug}-{YYYY-MM-DD}.pdf
```

13. Verify: `generate-latex.mjs` prints JSON — `"template"` must be `"classic"`, `"valid"` must be `true`, and `"compiled"` must be `true`. A valid `.tex` does **not** imply a PDF; on `compiled: false` read `compileError` and report the PDF as not generated.
14. Report: .tex path, .pdf path, file sizes, section count, keyword coverage %

**Filename convention (identical for every CV format — see `modes/pdf.md`):**
`output/cv-{candidate}-{company-slug}-{YYYY-MM-DD}.{tex|pdf}`, where `{candidate}` is
`config/profile.yml` → `candidate.full_name` slugified (lowercase, ASCII, non-alphanumerics → `-`;
e.g. `Alejandro Araujo Rajzner` → `alejandro-araujo-rajzner`) and `{company-slug}` is the same
slug used in `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`.

**CLI signatures (the code is the truth):**
- `node build-cv-latex.mjs <input.json> <output.tex>`
- `node generate-latex.mjs <input.tex> [output.pdf]` — no template flag; it reads `\documentclass`

**Requires:** `tectonic` (preferred for this template — `brew install tectonic`, auto-downloads packages) or `pdflatex` (MiKTeX / TeX Live) on PATH. (AltaCV inverts that order and prefers `pdflatex`, because its XeTeX branch needs Lato as a system font.)

## Language support

- **Localized section titles are fine.** The validator counts `\section{}` blocks instead of matching English titles, so a Spanish/French/German CV (e.g. `\section{Educación}`) validates normally.
- **CJK (Japanese / Chinese / Korean) is NOT supported by EITHER LaTeX template.** Both are pdfLaTeX setups with no CJK font, so kana/kanji/hangul cannot render. `generate-latex.mjs` detects CJK characters and stops with guidance before compiling. For a CJK CV, use the HTML fallback — `/career-ops pdf --html` — which renders CJK via a `lang="ja"` font fallback in `cv-template.html`. This is the one case where falling back is automatic rather than user-requested.

## JSON Input Schema — CLASSIC TEMPLATE ONLY

**This schema feeds `build-cv-latex.mjs` only.** The default AltaCV format uses a
different schema (`tagline`, `personal`, `achievements`, `skill_tags`, `languages`,
`previous_experience`) documented in **`modes/pdf.md` → "AltaCV payload schema"**, which
is kept identical to `batch/batch-prompt.md` → Paso 4 → step 10. Do not send the JSON
below to `build-cv-altacv.mjs`.

Write a JSON file with this structure. `build-cv-latex.mjs` handles template merge and LaTeX escaping — no need to escape special characters yourself.

```json
{
  "name": "Jane Smith",
  "contact_line": "San Francisco, CA | +1 415 555 0100",
  "email": { "url": "jane@example.com", "display": "jane@example.com" },
  "linkedin": { "url": "https://linkedin.com/in/janesmith", "display": "linkedin.com/in/janesmith" },
  "github": { "url": "https://github.com/janesmith", "display": "github.com/janesmith" },
  "education": [
    {
      "institution": "University Name",
      "location": "City, State",
      "degree": "Bachelor of Science in Computer Science",
      "dates": "2018 - 2022",
      "coursework": ["Data Structures", "Algorithms", "Machine Learning"]
    }
  ],
  "experience": [
    {
      "company": "Company Name",
      "role": "Job Title",
      "location": "Remote",
      "dates": "June 2022 - Present",
      "bullets": [
        "Achievement bullet with JD keywords injected",
        "Another bullet with quantified impact"
      ]
    }
  ],
  "projects": [
    {
      "name": "Project Name",
      "context": "Tech stack summary for the project line",
      "dates": "",
      "bullets": [
        "What you built and what it does"
      ]
    }
  ],
  "skills": [
    { "category": "Languages", "items": "Python, JavaScript, C++" },
    { "category": "Frameworks", "items": "FastAPI, React, PyTorch" }
  ]
}
```

### Field reference

| Field | Type | Source |
|-------|------|--------|
| `name` | string | `profile.yml → candidate.full_name` |
| `contact_line` | string | Phone / City, State / Visa — built from profile.yml |
| `email.url` | string | Email for `\href{mailto:...}` (sanitized via sanitizeUrl, not LaTeX-escaped) |
| `email.display` | string | Display text for the email link |
| `linkedin.url` | string | Full URL with scheme for `\href{}` (sanitized via sanitizeUrl, not LaTeX-escaped) |
| `linkedin.display` | string | Display text only (no scheme) |
| `github.url` | string | Full URL with scheme for `\href{}` (sanitized via sanitizeUrl, not LaTeX-escaped) |
| `github.display` | string | Display text only (no scheme) |
| `education[].institution` | string | From cv.md Education |
| `education[].location` | string | Institution location |
| `education[].degree` | string | Degree name |
| `education[].dates` | string | Date range |
| `education[].coursework` | string[] | Optional — generates a coursework line if present |
| `experience[].company` | string | From cv.md Experience |
| `experience[].role` | string | Job title |
| `experience[].location` | string | Work location |
| `experience[].dates` | string | Date range |
| `experience[].bullets` | string[] | Reordered and keyword-injected achievement bullets |
| `projects[].name` | string | From cv.md Projects |
| `projects[].context` | string | Tech stack — appears next to project name |
| `projects[].dates` | string | Date range (or empty) |
| `projects[].bullets` | string[] | Selected project achievements |
| `skills[].category` | string | Skill category name (e.g. "Languages", "Frameworks") |
| `skills[].items` | string | Comma-separated skills in that category |

## LaTeX Escaping (handled by the script)

`build-cv-latex.mjs` automatically escapes all user-supplied text before insertion:

| Character | Escape |
|-----------|--------|
| `&` | `\&` |
| `%` | `\%` |
| `$` | `\$` |
| `#` | `\#` |
| `_` | `\_` |
| `{` | `\{` |
| `}` | `\}` |
| `~` | `\textasciitilde{}` |
| `^` | `\textasciicircum{}` |
| `\` | `\textbackslash{}` |
| `±` | `$\pm$` |
| `→` | `$\rightarrow$` |

**Exception:** URLs inside `\href{}` are NOT escaped by the LaTeX escaper, but `sanitizeUrl()` still validates the scheme (mailto/http/https) and removes dangerous characters to prevent injection.

## ATS Rules (classic template — the reason this fallback exists)

- Single-column layout (enforced by template)
- Standard section headers: Education, Work Experience, Personal Projects, Technical Skills
- UTF-8, machine-readable via `\pdfgentounicode=1` (AltaCV has no such primitive — it must compile under XeLaTeX too)
- Keywords distributed: first bullet of each role, skills section
- No images, no graphics, no photo, no color in body text

This is the document to reach for in strict ATS-first markets (US/UK/Canada/Australia),
where a two-column layout and a photo can degrade parsing or trip bias-avoidance
filters. See `modes/pdf.md` → "ATS notes" for the trade-off the AltaCV default makes.

## Keyword Injection Strategy

Same ethical rules as `modes/pdf.md`:
- NEVER add skills the candidate doesn't have
- Only reformulate existing experience using JD vocabulary
- Examples:
  - JD says "RAG pipelines" → reword "LLM workflows with retrieval" to "RAG pipeline design"
  - JD says "MLOps" → reword "observability, evals" to "MLOps and observability"

## Overleaf Compatibility

The generated `.tex` file uses only standard CTAN packages (no custom or bundled dependencies):

- `latexsym`, `fullpage`, `titlesec`, `marvosym`, `color`, `verbatim`, `enumitem`
- `hyperref`, `fancyhdr`, `babel`, `tabularx`, `fontawesome5`, `multicol`, `glyphtounicode`

Upload the `.tex` file directly to Overleaf — compiles with no extra configuration.
