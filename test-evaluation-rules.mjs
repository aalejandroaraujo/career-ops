#!/usr/bin/env node
/**
 * test-evaluation-rules.mjs — the deterministic evaluation rules: fit vs deal,
 * decision and priority gates, next_action by employment type and channel,
 * language and level gaps, and report patching.
 *
 * All fixtures are synthetic. Run: node test-evaluation-rules.mjs
 */

import {
  BVG, compScoreFromTotal, domainGapIndustry, profileIndustries, targetBand, totalComp,
  THRESHOLDS, candidateLanguageLevel, decide, dealScore, enforceReport, fitScore, isForbiddenNextAction,
  languageGap, levelGap, levelRank, nextActionPlan, patchTsv, priorityOf, readSummary, requiredLanguageLevel,
} from './evaluation-rules.mjs';

let passed = 0;
let failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const profile = {
  candidate: { level: 'Principal Architect' },
  cover_letter: { language_learning: [{ language: 'German', current_level: 'B1, B2 in progress' }] },
};
const directHire = {
  employment_type: 'direct_hire', channel: 'company_ats', language: 'de', url: 'https://jobs.example.ch/stelle/1',
  contact: { name: 'Erika Muster', role: 'Talent Acquisition Partner' },
  requirements: [
    { text: 'Mehrjährige Erfahrung im Platform Engineering', level: 'required' },
    { text: 'Kenntnisse von OpenShift, Kubernetes, Argo CD und Helm', level: 'nice_to_have' },
  ],
  content_hash: 'abc',
};
const agency = { ...directHire, employment_type: 'agency', channel: 'recruiter', contact: { name: 'Jane Doe', role: 'Recruiter' } };

console.log('\n1. Fit vs Deal');
eq(fitScore({ cv_match: 4.5, north_star: 4.5, red_flags: 0 }), 4.5, 'fit = mean(CV match, North Star)');
eq(fitScore({ cv_match: 4.5, north_star: 4.0, red_flags: -0.3 }), 4.0, 'red flags subtract from fit (sign-insensitive)');
eq(dealScore({ comp: 2.5, culture: 3.5, risk: 3.0 }), 3.0, 'deal = mean(comp, culture, risk)');
eq(decide(THRESHOLDS.apply), 'apply', 'fit 4.0 → apply');
eq(decide(3.9), 'consider', 'fit 3.9 → consider');
eq(decide(3.0), 'consider', 'fit 3.0 → consider');
eq(decide(2.9), 'skip', 'fit 2.9 → skip');
eq(decide(4.8, ['German C1 mandatory']), 'skip', 'any hard stop → skip');
eq([priorityOf(4.2), priorityOf(3.4), priorityOf(2.1)], ['high', 'medium', 'low'], 'deal sets priority');
const lowDeal = fitScore({ cv_match: 4.5, north_star: 4.5 });
eq(decide(lowDeal), 'apply', 'a poor deal (comp below target) never changes an apply decision');

console.log('\n2. Levels and overqualification');
eq(levelRank('Platform Engineer AI (w/m/d)'), 2, 'engineer title → rank 2');
eq(levelRank('Senior Platform Engineer'), 3, 'senior prefix → rank 3');
eq(levelRank('Principal Architect'), 5, 'principal → rank 5');
eq(levelGap('Platform Engineer AI', 'Principal Architect').overqualified, true, 'IC engineer role for a principal → overqualified');
eq(levelGap('Senior Platform Engineer', 'Principal Architect').overqualified, true, 'seniority prefix does not exempt the check');
eq(levelGap('Head of AI', 'Principal Architect').overqualified, false, 'step up → not overqualified');

console.log('\n3. Language');
eq(candidateLanguageLevel(profile, 'de'), 'B1', 'candidate German level from profile');
eq(requiredLanguageLevel({ requirements: [{ text: 'Deutsch C1 zwingend', level: 'required' }] }, 'de'), { level: 'C1', evidence: 'Deutsch C1 zwingend', mandatory: true }, 'explicit "Deutsch C1 zwingend" parsed');
eq(languageGap({ language: 'de', requirements: [{ text: 'Deutsch C1 zwingend, Englisch von Vorteil', level: 'required' }] }, profile).gap, 'hard', 'mandatory level above candidate → hard stop');
eq(languageGap({ language: 'de', requirements: [{ text: 'Sicheres Auftreten in Deutsch mit gängigem Business-Englisch', level: 'required' }] }, profile).gap, 'soft', 'no stated level → soft gap');
eq(languageGap({ language: 'de', requirements: [{ text: 'Verhandlungssichere Deutschkenntnisse', level: 'nice_to_have' }] }, profile).gap, 'soft', 'nice-to-have language level → soft gap');
eq(languageGap({ language: 'de', requirements: [{ text: 'Deutsch B1', level: 'required' }] }, profile).gap, 'soft', 'required level at the candidate level → soft (not hard)');
eq(languageGap({ language: 'en', requirements: [] }, profile).gap, 'none', 'English JD → no language gap');

console.log('\n4. next_action by employment type and channel');
const plan = nextActionPlan(directHire, 'apply');
eq(plan.map((p) => p.kind), ['apply', 'linkedin_note', 'first_call'], 'direct hire at company ATS: apply → LinkedIn note → first call');
ok(/German, under 300 characters/.test(plan[1].step) && /Erika Muster/.test(plan[1].step), 'LinkedIn note names the recruiter, in German, under 300 chars');
ok(!plan.some((p) => /e-?mail/i.test(p.step) && /before/i.test(p.step)), 'no pre-application email step');
const aplan = nextActionPlan(agency, 'apply');
eq(aplan.map((p) => p.kind), ['qualify', 'hold_cv', 'no_free_info', 'first_call'], 'agency: qualify first, hold CV, no free info');
eq(nextActionPlan(directHire, 'skip').map((p) => p.kind), ['none'], 'skip (direct hire) → no action');
eq(nextActionPlan(agency, 'skip').map((p) => p.kind), ['decline'], 'skip (agency) → one-line decline');
const bad = 'Email Erika Muster via the Kontaktformular to confirm (a) working language of the team and (b) the salary band for this title; apply only if the band clears the target';
ok(isForbiddenNextAction(bad, directHire), 'pre-application salary/language email is forbidden for a direct hire');
ok(!isForbiddenNextAction(bad, agency), 'the same question is allowed (qualify-first) for an agency role');
ok(!isForbiddenNextAction('Apply via the ATS, then send a LinkedIn note', directHire), 'normal apply step is not flagged');

console.log('\n5. Report enforcement');
const report = `# Evaluation: Acme — Platform Engineer AI

**Date:** 2026-11-13
**Score:** 3.4/5
**Legitimacy:** High Confidence
**URL:** https://jobs.example.ch/stelle/1

---

## Machine Summary

\`\`\`yaml
company: "Acme"
role: "Platform Engineer AI"
score: 3.4
final_decision: "Consider"
level:
  detected: "Platform Engineer"
  candidate: "Principal Architect"
hard_stops:
  - "OpenShift, Kubernetes, Argo CD and Helm are absent from cv.md"
soft_gaps:
  - "German B1 against a German JD"
next_action: "${bad}"
\`\`\`

## A) Role Summary
text

#### Global Score

| Dimension | Score |
|-----------|-------|
| CV Match | **4.5/5** |
| North Star alignment | **4.5/5** |
| Comp | 2.5/5 |
| Cultural signals | 3.5/5 |
| Risk | 3.0/5 |
| Red flags | **-0.0** |
`;
const { md: out, result } = enforceReport(report, { record: directHire, profile });
eq([result.fit_score, result.decision, result.deal_score, result.priority], [4.5, 'apply', 3.0, 'medium'], 'fit 4.5 → apply; deal 3.0 → medium priority');
const sum = readSummary(out);
eq(sum.hard_stops, [], 'hard stop naming only nice-to-have tech is demoted');
ok(sum.soft_gaps.some((g) => /demoted from hard stop/.test(g)), 'demoted stop kept as a soft gap');
ok(sum.soft_gaps.some((g) => /Overqualified/.test(g)), 'overqualification soft gap added');
eq(sum.level.overqualified, true, 'level.overqualified recorded');
ok(Array.isArray(sum.next_action) && /^Apply via the company ATS/.test(sum.next_action[0]), 'forbidden next_action replaced by the apply-first checklist');
eq([sum.score, sum.fit_score, sum.final_decision, sum.employment_type, sum.channel], [4.5, 4.5, 'Apply', 'direct_hire', 'company_ats'], 'legacy score/final_decision mirror fit/decision; record fields copied');
ok(/^\*\*Score:\*\* 4\.5\/5 \(fit\) · \*\*Deal:\*\* 3\.0\/5 · \*\*Decision:\*\* APPLY · \*\*Priority:\*\* MEDIUM$/m.test(out), 'header Score line rewritten');
ok(/## Fit vs Deal[\s\S]*Decision: APPLY[\s\S]*Priority: MEDIUM/.test(out), 'Fit vs Deal box inserted');
ok(result.corrections.length >= 3, `corrections reported (${result.corrections.length})`);
const again = enforceReport(out, { record: directHire, profile });
eq(again.md, out, 'enforcement is idempotent');
eq(again.result.corrections.filter((c) => !/^overqualification/.test(c)), [], 'second pass has nothing left to correct');
const noSummary = enforceReport('# x\nno summary', {});
ok(noSummary.result.corrections[0].startsWith('no parseable'), 'report without a Machine Summary is left alone');

console.log('\n6. Tracker line');
eq(patchTsv('7\t2026-11-13\tAcme\tPlatform Engineer AI\tEvaluated\t3.4/5\t✅\t[441](reports/441-acme-2026-11-13.md)\tCONSIDER — strong fit\n', { fit: 4.5, decision: 'apply', priority: 'medium' }),
  '7\t2026-11-13\tAcme\tPlatform Engineer AI\tEvaluated\t4.5/5\t✅\t[441](reports/441-acme-2026-11-13.md)\tAPPLY MEDIUM — strong fit\n', 'score = fit, notes tagged with decision + priority');
eq(patchTsv('7\td\tA\tR\tEvaluated\t2.1/5\t❌\t[1](r)\tweak\n', { fit: 2.1, decision: 'skip', priority: 'low' }).split('\t')[4], 'SKIP', 'skip decision → SKIP status');

console.log('\n7. Industries and domain gaps');
const indProfile = { ...profile, industries: { financial_services: ['Example Insurance AG', 'Example Bank'], energy_utilities: [], telecom: { customers: ['Example Telco'] } } };
eq(Object.keys(profileIndustries(indProfile)), ['financial_services', 'telecom'], 'industries with named customers count; empty lists do not');
eq(domainGapIndustry('No financial-services domain experience in cv.md'), 'financial_services', 'domain gap sentence → industry key');
eq(domainGapIndustry('No insurance industry background'), 'financial_services', 'insurance maps to financial_services');
eq(domainGapIndustry('German B1 against a German JD'), null, 'non-domain gap → null');
const domReport = report.replace('  - "German B1 against a German JD"', '  - "German B1 against a German JD"\n  - "No financial-services domain experience"');
const dom = enforceReport(domReport, { record: directHire, profile: indProfile });
ok(!readSummary(dom.md).soft_gaps.some((g) => /financial-services domain/.test(g)), 'domain gap removed when profile.industries lists the industry');
ok(dom.result.corrections.some((c) => /industries\.financial_services/.test(c)), 'removal recorded as a correction');

console.log('\n8. Total compensation');
const tc = totalComp({ min: 115000, max: 135000 }, { bonus: 'Leistungsabhängiger Bonus', pension_employer_share: 60, vacation_days: 25, mobile_office: 'Mobile Office' }, { age: 50 });
eq(tc.bonus_estimate, { min: 9200, max: 10800 }, 'unquantified bonus assumed at 8% of base');
eq(tc.pension_delta.min, Math.round(0.1 * 0.15 * (115000 - BVG.coordination)), 'pension delta = (60%-50%) × 15% × (base − coordination)');
eq(tc.total, { min: 115000 + 9200 + tc.pension_delta.min, max: 135000 + 10800 + tc.pension_delta.max }, 'total = base + bonus + pension delta');
eq(tc.mobile_office, 'yes', 'mobile office stated');
eq(tc.assumptions.length, 2, 'every inferred number is listed as an assumption');
eq(totalComp({ min: 100000, max: 100000 }, {}, { age: 40 }).total, { min: 100000, max: 100000 }, 'no benefits → total = base');
eq(targetBand({ compensation: { target_range: 'CHF 150K–230K total (FTE)' } }), { min: 150000, max: 230000, basis: 'total' }, 'target band parsed from profile');
const band = { min: 150000, max: 230000 };
eq([compScoreFromTotal({ min: 240000, max: 260000 }, band), compScoreFromTotal({ min: 195000, max: 215000 }, band), compScoreFromTotal({ min: 150000, max: 170000 }, band), compScoreFromTotal({ min: 130000, max: 145000 }, band)], [5, 4.5, 3.5, 2.5], 'comp scored on total vs band');
const compReport = report.replace('next_action:', 'comp:\n  base_min: 115000\n  base_max: 135000\nnext_action:').replace('| Comp | 2.5/5 |', '| Comp | 3.5/5 |');
const ce = enforceReport(compReport, { record: { ...directHire, benefits: { bonus: 'Bonus', pension_employer_share: 60 } }, profile: { ...profile, compensation: { target_range: 'CHF 150K–230K total (FTE)' }, candidate: { ...profile.candidate, birthyear: 1976 } } });
const cs = readSummary(ce.md);
ok(cs.comp.total_min > cs.comp.base_min && cs.comp.target_min === 150000, 'summary carries base and total separately, with the target band');
ok(ce.result.corrections.some((c) => /scored on total comp/.test(c)), 'comp dimension re-scored on total, not base');
eq(ce.result.decision, 'apply', 'comp never changes the decision');

console.log('\n9. Non-gaps');
const ng = enforceReport(report.replace('  - "German B1 against a German JD"', '  - "German B1 against a German JD"\n  - "Overqualified / age-band read: not applicable here"'), { record: directHire, profile: { ...profile, candidate: { level: 'Engineer' } } });
ok(!readSummary(ng.md).soft_gaps.some((g) => /not applicable/.test(g)), 'a soft gap that says "not applicable" is removed');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
