# Mode: cv-judge — read the CV as its future readers will

Every tailored CV is judged after it compiles and before anyone sees it. The judge reads the **rendered PDF text** (what the ATS and every human downstream actually receive), the canonical JD record, and nothing else. It does not read the payload or the reasoning that produced it. A claim that needs the author's context to make sense fails.

## 1. Run the mechanical checks

```bash
node cv-judge.mjs output/cv-{candidate}-{slug}-{date}.pdf --record <jd-record.json>
node cv-judge.mjs output/cv-{candidate}-{slug}-{date}.pdf --record <jd-record.json> --json | jq -r .reader_text   # what the readers get
```

- `blocking` findings (ATS extraction defects, a metric repeated three or more times) must be fixed before the CV is used.
- `review` findings (claim words not found in `cv.md`, required topics not visible) must each be resolved: either fixed, or kept with a one-line reason in the judgment.

## 2. Read it as five readers, in order

Read only `reader_text` and the JD record. Write each reader's verdict in one or two sentences, then the findings.

**A. The 6-second skim (recruiter, page one only).** What does this reader remember after six seconds: a title, the last employer, one proof? Is that memory the reason to hire for THIS role? If what sticks is irrelevant or generic, that is a blocking finding.

**B. The ATS / keyword screen.** Are the JD's required topics present in plain words a parser can match, using the JD's own vocabulary where the candidate honestly has the skill? Missing must-haves that the candidate does have are a finding. Missing must-haves the candidate does not have are not; they are gaps for the cover letter or interview.

**C. The hiring manager's "so what?" test.** Do this for every metric and every claim in the About block and Key Achievements:
- *What changed, for whom, at what scale?* A number with no baseline, no scope and no consequence is decoration.
- *Is it evidence or assertion?* "Set the standards teams built to" is assertion until a scope (how many teams, what was built) backs it.
- *Is it this role's kind of proof?* A demo metric does not prove production platform architecture. A training metric does not prove delivery.
- **Vanity-metric rule:** a metric measured on a demo, a lab or a benchmark may appear at most **once**, in the bullet where its context is stated, and never as the headline proof in About or as the first Key Achievement. Repeating it does not make it stronger; a reader who sees it three times concludes it is the only proof there is.

**D. The skeptical interviewer.** Name the three claims you would probe first. For each: does `cv.md` back it at the strength written? If a fair question would shrink the claim ("so it was a demo?", "did you lead the team or advise it?", "is the app still live?"), the CV must already say it at the shrunk size. Over-claiming is blocking.

**E. The receiver (perception and underselling).** Read the rendered pages as the person the CV is actually sent to: who they are (hiring manager, lead architect, recruiter), how it reaches them (cold ATS, referral, forwarded by a colleague), and what travels with it (cover letter). Then:
- *What kind of professional do they think this is after 10 and 60 seconds?* If the answer is a lesser version of the candidate (a trainer instead of an architect, a consultant between jobs, a failed founder), find the words on the page that produce that read.
- *Negative inferences:* dates, titles, endings ("concluded the venture"), personal details and layout choices that invite a doubt the candidate would never write. Say whether each actually hurts with THIS receiver.
- *Underselling:* what in `cv.md` would make this receiver more interested but is missing, buried or worded below its strength. Rank by impact. The same truth rules apply: only what `cv.md` supports.
- *Consistency:* the CV and the cover letter tell one story, without contradictions or copy-paste repetition.

Overclaiming and underselling are both failures; the judgment checks for both.

## 3. Verdict

Write a `## CV judgment` section in the report:

```markdown
## CV judgment

| Reader | Verdict |
|---|---|
| 6-second skim | … what sticks, and whether it is the right thing |
| ATS | … required topics on page one x/y, defects |
| Hiring manager | … which proofs land, which are decoration |
| Interviewer | … the three claims probed first, and whether they hold |
| Receiver | … who they think this is, negative inferences, what is undersold |

**Blocking:** … (none / list)
**Changed after judgment:** … (what was rewritten and why)
**Result:** pass | pass after one revision | fail (CV not used)
```

If anything is blocking, revise the payload and rebuild **once**, run both steps again, and record what changed. If it still fails, mark the PDF as not usable (`pdf_emoji` ❌, the reason in the notes) rather than ship it.

Truth rules still apply: revisions reword, reorder and cut. They never add a fact that is not in `cv.md`, `article-digest.md` or `config/profile.yml`.
