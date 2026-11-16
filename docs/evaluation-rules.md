# Evaluation rules

How career-ops turns a job description into a decision, in plain language. Every evaluation path follows these rules: the batch worker, `/career-ops` modes, `gemini-eval` / `ollama-eval`, and Hermes calling the MCP server. Code enforces the parts that can be computed. An agent that disagrees with a rule should change the rule here and in code, not work around it.

| Rule | Enforced by |
|---|---|
| One canonical JD record per input | `jd-intake.mjs` |
| Fit vs Deal, decision, priority, next_action, hard-stop limits, language and level gaps, domain gaps, total comp | `evaluation-rules.mjs` (`enforce`) |
| Truthful titles, guarded facts, English CV, Swiss spelling | `output-guards.mjs` (CV builder, cover-letter generator) |
| PDF metadata, 2 pages, no open date ranges, photo margin | `cv-verify.mjs` (run by `generate-latex.mjs`) |
| CV judged as its future readers will meet it | `cv-judge.mjs` + `modes/cv-judge.md` |
| Apply-control detection | `liveness-core.mjs` / `check-liveness.mjs` |
| Regression | `calibrate.mjs` golden cases |

## 1. One record per JD, whatever the input

A JD can arrive as a URL, pasted text, a PDF, .docx, .md or .txt file, a screenshot, a forwarded email or a scan row. Before any scoring, `jd-intake.mjs` turns it into one record:

- `source_type`, `url`, `company`, `title`, `language`, `location`, `workload`
- `employment_type`: `direct_hire` | `contract_b2b` | `agency` | `unknown`
- `channel`: `company_ats` | `aggregator` | `recruiter` | `referral`
- `responsibilities`, and `requirements` marked `required` or `nice_to_have`
- `benefits` (bonus, pension employer share, vacation days, mobile office)
- `contact` (name, role, channel) and `apply_control_present`

PDFs are text-extracted and screenshots are OCRed. The same JD gives the same record (same `content_hash`) in every form. Evaluations read the record; they do not re-derive these fields from raw text.

## 2. Fit decides, Deal prioritises

Score each dimension from 1 to 5:

- **Fit** = CV match and North Star alignment, minus red flags.
  - **4.0 or more: apply**
  - **3.0 to 3.9: consider**
  - **below 3.0: skip**
  - Any hard stop means skip.
- **Deal** = comp, culture and risk (5 means low risk).
  - It sets **priority**: 4.0 or more is high, 3.0 to 3.9 medium, below 3.0 low.
  - It feeds the negotiation notes.
  - **It never changes the decision.** A great deal does not rescue a poor fit. A comp band below target does not sink a strong fit.

Title band, process friction and doubts about the posting belong to Deal or legitimacy, never Fit. Availability never lowers either score.

## 3. What a hard stop is

A hard stop is either of these:

- a `required` item with no direct or adjacent evidence in the candidate's files;
- a language level above the candidate's that the JD states as mandatory, e.g. "Deutsch C1 zwingend" for a B1 candidate.

These are never hard stops:

- `nice_to_have` items (Soll-Kriterien, "von Vorteil", "preferred");
- a German-language JD, or German without a stated level;
- a domain the profile lists under `industries`.

These are soft gaps, each with a mitigation.

## 4. Next action depends on how you are hired

- **Direct hire through a company ATS with a named recruiter:**
  1. apply through the ATS;
  2. send a LinkedIn connection note to that recruiter, in the JD language, under 300 characters.

  Never email the recruiter "to confirm the salary band or working language before applying". Those questions are lines in the first-call script.
- **Agency or B2B contract:** qualify first.
  - Ask whether it is B2B or direct hire, the rate or band, and the end client's working language.
  - Send no CV before the role is qualified.
  - Give no information about other commitments or dates.
- **Someone inside (referral or warm introduction):** the introduction comes **before** the application.
  1. Brief your contact with a short forwardable intro and the CV.
  2. Your contact introduces or refers you internally. Agree a date to follow up.
  3. Learn what the posting cannot say: why it is still open, the band, what screens people out.
  4. Apply, naming the referral where the form allows.
  5. Thank your contact and keep them updated.

  No cold LinkedIn note. A referral is a valid reason to apply at `consider`, but it never rescues a `skip`. To mark a role, queue it with the note `referral: <who>`, or pass `--referral "<who>"` to `jd-intake.mjs` or `evaluation-rules.mjs enforce`.
- **Skip:** no application. For an agency, send a one-line decline asking to be matched to target roles.

`next_action` is an ordered checklist. Each step comes with a ready-to-paste text: ATS form answers, cover letter, LinkedIn note, first-call script, or qualification message.

## 5. Level and age-band read

On every JD, compare the level the JD hires at with the candidate's natural level (`candidate.level` in the profile). When the JD is below it, add the soft gap "overqualified / age-band read" and mitigate it:

- the About block says in one sentence why a builder/IC role is a deliberate choice;
- the interview block carries verbatim answers to "Is this a step down for you?" and "Why not a lead/architect role?".

## 6. Evidence, titles and guarded facts

- **Production evidence first.** When the JD talks about operating or shipping (produktiv, betreibst, operate, run, ship, go-live), shipped-to-production evidence ranks above evaluation or demo metrics. That applies in the About block, in Key Achievements and in each role's first bullet.
- **Titles are not tailored.** Experience role titles are copied from `cv.md` unchanged. Only the tagline under the name may mirror the JD title. The CV builder rejects a renamed role.
- **Guarded facts.** `canonical_facts` in the profile carry usage guards:
  - `never_name_client`: use `say_instead`;
  - `never_say_not_launched`;
  - `forbid`: listed strings never appear.

  The CV builder and the cover-letter generator refuse output that breaks a guard.
- **Domain gaps.** Check `industries` (named customers) before declaring a domain gap.

## 7. Comp is total comp

The evaluator estimates the base band. The rules then add:

- the bonus (8% assumed when the JD mentions one without a figure);
- the employer pension contribution above the 50% legal split (BVG age-band credit on base minus the coordination deduction).

Every assumption is written down. Base and total are reported separately, along with vacation days and whether mobile office is stated. The comp dimension is scored on **total** comp against the target band, never on base alone.

## 8. Language

- The **CV is always in English**, never in a language above the candidate's stated level.
- **Cover letters, recruiter notes and the first-call script** use the JD language:
  - keep them short and consistent with the stated level;
  - state the level once and explicitly (German "B1, B2 in progress");
  - Swiss employers get Swiss spelling ("ss", never "ß").

## 8b. Gaps are spoken, never written

Cover letters, LinkedIn notes, forwardable intros and ATS free-text answers say what the candidate brings. They never volunteer a gap ("I have not worked in…", "would be a new domain for me"), never promise remedies nobody asked for ("I'd take the certification in my first quarter"), and never use the confessional frame "I'd rather name that now than have you find it". That frame works only in person, in answer to a question, so it lives in Block F and the first-call script.

- A direct yes/no screening question gets a short, factual answer from the positive side.
- The only written exception is the candidate's language level, stated once.
- `generate-cover-letter.mjs` refuses a letter that breaks this.
- `evaluation-rules.mjs` flags it in a report's ready-to-paste texts (`outreach_issues`).

## 9. Build checks on the CV

After every AltaCV compile:

- PDF Author, Creator and Producer are the candidate's name, and the Title carries it;
- exactly 2 pages;
- no "– Present" date ranges (an ongoing role reads "since MM/YYYY");
- no text running into the right margin or off the page;
- the photo keeps a right margin.

The single-column ATS CV gets the same checks (at most 2 pages, no photo check), and both builders run the output guards (truthful titles, guarded facts, English CV). A failed check fails the build. Fix the payload, then rebuild.

## 9b. Judge the CV as its readers will

After the build, `cv-judge.mjs` reads the PDF text exactly as an ATS gets it. Blocking findings:
- text-extraction defects (ligatures, icon arrows that vanish);
- the same metric three or more times.

It also flags claim words that `cv.md` never uses (e.g. "live", "decade") and required JD topics that aren't visible.

Then `modes/cv-judge.md` reads that text as five readers:
- the 6-second skim: what sticks?
- the ATS;
- the hiring manager: the "so what?" test on every claim;
- the skeptical interviewer: which three claims get probed, and do they hold?
- the receiver: who they think this is, which details invite a negative inference, and what `cv.md` holds that the CV undersells. Overclaiming and underselling are both failures.

A demo or lab metric is not headline proof: at most once, where its context is stated. Anything blocking means revise and rebuild once; if it still fails, the CV is not used.

## 10. Liveness

An apply control counts when it is any of these:

- a visible apply button or link;
- an anchor styled as a button, or one that leads off-domain to the ATS;
- an apply string in the page text: "Jetzt bewerben", "Apply now", "Bewerben", "Postuler".

An `uncertain` result never lowers legitimacy when the JD text carries an apply string. `check-liveness.mjs` prints which selector or text matched. Only a definitive expired signal closes a posting.

## 11. Calibration

`tests/calibration/` holds synthetic golden cases that run in CI on every PR. `calibration/` (private, gitignored) holds real JDs whose verdict was wrong once.

- Add a case in one command:

  ```bash
  node calibrate.mjs add <name> --jd <file> --decision apply --fit 4.0-5.0 --priority high \
    --report reports/NNN-x.md --cv /tmp/cv-<candidate>-<slug>.json --note "why it was wrong"
  ```

- After a re-run: `node calibrate.mjs snapshot <name> --report reports/<new>.md`.
- `node calibrate.mjs table` prints a before/after table with numbers only, safe for a public PR.
