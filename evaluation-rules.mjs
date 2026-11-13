#!/usr/bin/env node
// @ts-check
/**
 * evaluation-rules.mjs — the deterministic half of an evaluation.
 *
 * The worker (an LLM) reads the JD and the CV and scores the dimensions. Every
 * rule that turns those dimension scores into a decision lives here, in code,
 * so it cannot drift with the model, the provider or the prompt:
 *
 *   fit_score  = CV match + North Star alignment, red flags applied → decision
 *                (>= 4.0 apply · 3.0-3.9 consider · < 3.0 skip)
 *   deal_score = comp + culture + risk → priority (high · medium · low) and the
 *                negotiation block. Deal NEVER changes the decision.
 *   next_action by employment type and channel (direct hire at a company ATS
 *                with a named recruiter: apply, then a short LinkedIn note —
 *                never "email the recruiter to confirm salary/language first").
 *   language gap: soft with mitigation, hard only when the JD states a required
 *                level above the candidate's.
 *   level gap:   detected level below the candidate's → "overqualified /
 *                age-band read" soft gap with mitigation, on every JD.
 *
 * Why split fit from deal: a single global score gated at 4.0 let comp and
 * culture veto good-fit roles (Swiss Life, report 441: fit-strong, scored 3.4
 * "Consider" because the title band looked low) and let agency/process noise
 * into the fit. See docs/evaluation-rules.md.
 *
 * CLI (run by batch-runner.sh after every evaluation):
 *   node evaluation-rules.mjs enforce <report.md> [--record jd-record.json]
 *        [--tsv batch/tracker-additions/<id>.tsv] [--profile config/profile.yml] [--write]
 * Prints {fit_score, deal_score, decision, priority, corrections[]} as JSON.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { buildRecord } from './jd-intake.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

export const THRESHOLDS = Object.freeze({ apply: 4.0, consider: 3.0, priorityHigh: 4.0, priorityMedium: 3.0 });

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo = 1, hi = 5) => Math.min(hi, Math.max(lo, n));
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const mean = (xs) => { const v = xs.filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// ── scores and decision ──────────────────────────────────────────────────────

/**
 * @param {{cv_match?:number|null, north_star?:number|null, red_flags?:number|null}} s
 *   red_flags is a penalty (0 = none), applied to fit only.
 */
export function fitScore(s) {
  const base = mean([num(s.cv_match), num(s.north_star)]);
  if (base === null) return null;
  return round1(clamp(base - Math.abs(num(s.red_flags) || 0)));
}

/** @param {{comp?:number|null, culture?:number|null, risk?:number|null}} s risk: 5 = low risk */
export function dealScore(s) {
  const m = mean([num(s.comp), num(s.culture), num(s.risk)]);
  return m === null ? null : round1(clamp(m));
}

/**
 * @param {number|null} fit
 * @param {string[]} [hardStops]
 * @returns {'apply'|'consider'|'skip'}
 */
export function decide(fit, hardStops = []) {
  if (hardStops.length) return 'skip';
  if (fit === null) return 'consider';
  if (fit >= THRESHOLDS.apply) return 'apply';
  if (fit >= THRESHOLDS.consider) return 'consider';
  return 'skip';
}

/** @returns {'high'|'medium'|'low'} */
export function priorityOf(deal) {
  if (deal === null) return 'medium';
  if (deal >= THRESHOLDS.priorityHigh) return 'high';
  if (deal >= THRESHOLDS.priorityMedium) return 'medium';
  return 'low';
}

/** Legacy `final_decision` for scripts that predate the split. */
export const LEGACY_DECISION = { apply: 'Apply', consider: 'Consider', skip: 'Skip' };

// ── levels ───────────────────────────────────────────────────────────────────

const LEVEL_PATTERNS = [
  [7, /\b(c-level|cto|cio|chief|vp|vice president)\b/i],
  [6, /\b(head of|director|direktor|bereichsleit\w*|abteilungsleit\w*)\b/i],
  [5, /\b(principal|distinguished|staff|lead architect|chief architect|enterprise architect)\b/i],
  [4, /\b(lead|architect|architekt\w*|team ?lead|teamleit\w*|tech(nical)? lead|manager)\b/i],
  [3, /\b(senior|sr\.?|expert|experte|spezialist|specialist)\b/i],
  [2, /\b(mid|professional|engineer|entwickler\w*|developer|consultant|berater\w*|analyst|ingenieur\w*)\b/i],
  [1, /\b(junior|jr\.?|graduate|trainee|associate)\b/i],
  [0, /\b(intern|praktik\w*|werkstudent\w*|apprentice|lehrling)\b/i],
];

/** Ordinal level 0-7 from a title or a level word; null when nothing matches. */
export function levelRank(text) {
  const t = String(text || '');
  if (/^\d$/.test(t.trim())) return Number(t.trim());
  for (const [rank, re] of LEVEL_PATTERNS) if (re.test(t)) return rank;
  return null;
}

/**
 * Overqualification applies to EVERY JD, not only titles without a seniority
 * prefix: "Senior Platform Engineer" for a candidate who has run architecture
 * and enablement practices is still a step down and still gets the age-band read.
 */
export function levelGap(detected, candidate) {
  const d = levelRank(detected);
  const c = levelRank(candidate);
  return { detected_rank: d, candidate_rank: c, overqualified: d !== null && c !== null && d < c };
}

export const OVERQUALIFICATION_GAP = 'Overqualified / age-band read: the role sits below the candidate\'s natural level';

// ── language ─────────────────────────────────────────────────────────────────

const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const cefrRank = (l) => (l ? CEFR.indexOf(String(l).toUpperCase()) : -1);

const LANG_NAMES = {
  de: /(deutsch|german|allemand|tedesco)/i,
  fr: /(französisch|franzoesisch|french|français|francais|francese)/i,
  it: /(italienisch|italian|italien|italiano)/i,
  en: /(englisch|english|anglais|inglese)/i,
};

// Words that state a level without a CEFR code. "Verhandlungssicher" and
// "fliessend" are C1 in Swiss HR usage; "sehr gute Kenntnisse" B2.
const LEVEL_WORDS = [
  ['C2', /\b(muttersprach\w*|native|langue maternelle|madrelingua)\b/i],
  ['C1', /\b(verhandlungssicher\w*|fliessend\w*|fließend\w*|stilsicher\w*|business[- ]fluent|fluent|courant|parfaitement)\b/i],
  ['B2', /\b(sehr gute?n? \w*kenntnisse|very good|bonnes connaissances)\b/i],
];

/**
 * The level the JD REQUIRES for a language, or null when it states none.
 * Only explicit statements count: a German-language JD, or "Deutsch" in a
 * skills list, does not by itself require any level. Requirements tagged
 * nice_to_have never produce a required level.
 *
 * @param {{requirements?:{text:string, level:string}[], raw_text?:string}} record
 * @param {'de'|'fr'|'it'|'en'} lang
 * @returns {{level:string, evidence:string, mandatory:boolean}|null}
 */
export function requiredLanguageLevel(record, lang) {
  const lines = (record.requirements?.length
    ? record.requirements.filter((r) => r.level === 'required').map((r) => r.text)
    : String(record.raw_text || '').split('\n'));
  let best = null;
  for (const line of lines) {
    if (!LANG_NAMES[lang].test(line)) continue;
    const code = line.match(/\b([ABC][12])\b/);
    let level = code ? code[1].toUpperCase() : null;
    if (!level) for (const [lv, re] of LEVEL_WORDS) if (re.test(line)) { level = lv; break; }
    if (!level) continue;
    const mandatory = /\b(zwingend|unabdingbar|vorausgesetzt|mandatory|required|must|obligatoire|indispensable|exigé)\b/i.test(line) || !!code;
    if (!best || cefrRank(level) > cefrRank(best.level)) best = { level, evidence: line.trim(), mandatory };
  }
  return best;
}

/** Candidate CEFR level for a language from profile.yml (cover_letter.language_learning). */
export function candidateLanguageLevel(profile, lang) {
  const name = { de: 'german', fr: 'french', it: 'italian', en: 'english' }[lang];
  const list = profile?.cover_letter?.language_learning || profile?.languages || [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (String(entry.language || entry.name || '').toLowerCase() !== name) continue;
    const m = String(entry.current_level || entry.level || '').match(/\b([ABC][12])\b/);
    if (m) return m[1].toUpperCase();
  }
  return lang === 'en' ? 'C2' : null;
}

/**
 * Language gap for a non-English JD. The CV stays in English; the gap is soft
 * with mitigation unless the JD states a required level above the candidate's.
 * @returns {{gap:'none'|'soft'|'hard', language:string, required:string|null, candidate:string|null, evidence:string|null}}
 */
export function languageGap(record, profile) {
  const lang = /** @type {'de'|'fr'|'it'|'en'} */ (record.language);
  if (!lang || lang === 'en' || lang === 'unknown' || !LANG_NAMES[lang]) return { gap: 'none', language: lang, required: null, candidate: null, evidence: null };
  const req = requiredLanguageLevel(record, lang);
  const cand = candidateLanguageLevel(profile, lang);
  if (req && req.mandatory && cand && cefrRank(req.level) > cefrRank(cand)) {
    return { gap: 'hard', language: lang, required: req.level, candidate: cand, evidence: req.evidence };
  }
  if (cand && cefrRank(cand) >= cefrRank('C1')) return { gap: 'none', language: lang, required: req?.level || null, candidate: cand, evidence: req?.evidence || null };
  return { gap: 'soft', language: lang, required: req?.level || null, candidate: cand, evidence: req?.evidence || null };
}

// ── domain / industries ──────────────────────────────────────────────────────

/** Industry keys in profile.yml `industries:` and the words that name them in a gap. */
export const INDUSTRY_WORDS = {
  financial_services: /\b(financial[- ]services?|finance|fintech|bank(?:ing)?|insurance|insurer|versicherung\w*|asset management|wealth|pension|reinsurance)\b/i,
  energy_utilities: /\b(energy|utilit(?:y|ies)|grid|power (?:sector|industry)|oil|gas|transmission|energie\w*)\b/i,
  telecom: /\b(telecom\w*|telco|carrier|mobile operator|isp|telekom\w*)\b/i,
  healthtech: /\b(health\w*|medical|medtech|hospital|clinical|pharma\w*|life sciences|gesundheit\w*)\b/i,
  public_sector: /\b(public[- ]sector|government|federal|cantonal|canton|municipal\w*|verwaltung|öffentlich\w*|kanton\w*)\b/i,
  transport: /\b(transport\w*|rail\w*|bahn\w*|logistics|mobility|aviation)\b/i,
  retail: /\b(retail|e-?commerce|consumer goods)\b/i,
  manufacturing: /\b(manufactur\w*|industrial|industrie\w*)\b/i,
  education: /\b(education|edtech|universit\w*|school)\b/i,
};

const DOMAIN_GAP = /\b(no|without|lacks?|missing|absent|not)\b[^.;\n]{0,60}\b(domain|industry|sector|background|experience)\b|\b(domain|industry|sector) gap\b/i;

/**
 * Industries the candidate has evidence in, from profile.yml `industries:`
 * ({key: [named customers or employers]}). Empty lists do not count.
 * @returns {Record<string, string[]>}
 */
export function profileIndustries(profile) {
  const raw = profile?.industries || {};
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const list = Array.isArray(v) ? v : Array.isArray(v?.customers) ? v.customers : [];
    if (list.length) out[k] = list.map(String);
  }
  return out;
}

/** The industry a gap sentence claims is missing, when it is a domain gap. */
export function domainGapIndustry(gap) {
  if (!DOMAIN_GAP.test(gap)) return null;
  for (const [key, re] of Object.entries(INDUSTRY_WORDS)) if (re.test(gap)) return key;
  return null;
}

// ── total compensation ───────────────────────────────────────────────────────

/** BVG coordination deduction (CHF) and age-band retirement credit (share of insured salary). */
export const BVG = { coordination: 26460, credit: (age) => (age >= 55 ? 0.18 : age >= 45 ? 0.15 : age >= 35 ? 0.10 : 0.07) };
export const DEFAULT_BONUS_SHARE = 0.08;

const kchf = (s) => {
  const m = String(s || '').replace(/['’\s]/g, '').match(/(\d{2,3})(?:[.,](\d))?\s*K?/i);
  if (!m) return null;
  const n = Number(`${m[1]}${m[2] ? `.${m[2]}` : ''}`);
  return n < 1000 ? n * 1000 : n;
};

/** Target band from profile.yml compensation.target_range ("CHF 120K–180K total ..."). */
export function targetBand(profile) {
  const raw = String(profile?.compensation?.target_range || '');
  const m = raw.match(/(\d{2,3}(?:[.,]\d)?)\s*K?\s*[–—-]\s*(\d{2,3}(?:[.,]\d)?)\s*K/i);
  return m ? { min: kchf(m[1]), max: kchf(m[2]), basis: /total/i.test(raw) ? 'total' : 'base' } : null;
}

/**
 * Total compensation estimate: base + bonus + employer pension contribution
 * above the 50% legal split. Every number that is not in the JD is an
 * assumption and is listed as one.
 *
 * @param {{min:number, max:number}} base CHF, annual, 100%
 * @param {{bonus?:string|null, pension_employer_share?:number|string|null, vacation_days?:number|null, mobile_office?:string|null}} benefits
 * @param {{age?:number|null}} [opts]
 */
export function totalComp(base, benefits = {}, opts = {}) {
  const assumptions = [];
  const age = opts.age ?? null;
  let bonusShare = 0;
  if (benefits.bonus) {
    const pct = String(benefits.bonus).match(/(\d{1,2})\s*%/);
    bonusShare = pct ? Number(pct[1]) / 100 : DEFAULT_BONUS_SHARE;
    if (!pct) assumptions.push(`bonus stated without a figure; assumed ${Math.round(DEFAULT_BONUS_SHARE * 100)}% of base`);
  }
  let share = null;
  if (typeof benefits.pension_employer_share === 'number') share = benefits.pension_employer_share / 100;
  else if (benefits.pension_employer_share === 'above_legal_unquantified') { share = 0.6; assumptions.push('pension described as above the legal minimum without a figure; assumed 60% employer share'); }
  const credit = BVG.credit(age ?? 50);
  if (age === null) assumptions.push('candidate age unknown; BVG credit for age 45-54 (15%) assumed');
  const pensionDelta = (b) => (share !== null && share > 0.5 ? (share - 0.5) * credit * Math.max(0, b - BVG.coordination) : 0);
  if (share !== null && share > 0.5) assumptions.push(`pension delta = (${Math.round(share * 100)}% − 50%) × ${Math.round(credit * 100)}% credit × (base − CHF ${BVG.coordination} coordination deduction)`);
  const tot = (b) => Math.round(b * (1 + bonusShare) + pensionDelta(b));
  return {
    base: { min: base.min, max: base.max },
    bonus_estimate: { min: Math.round(base.min * bonusShare), max: Math.round(base.max * bonusShare) },
    pension_delta: { min: Math.round(pensionDelta(base.min)), max: Math.round(pensionDelta(base.max)) },
    total: { min: tot(base.min), max: tot(base.max) },
    vacation_days: benefits.vacation_days ?? null,
    mobile_office: benefits.mobile_office ? 'yes' : 'not stated',
    assumptions,
  };
}

/**
 * Comp dimension from TOTAL compensation against the target band. Base alone
 * is never the sole basis.
 */
export function compScoreFromTotal(total, band) {
  if (!total || !band) return null;
  const mid = (total.min + total.max) / 2;
  if (mid >= band.max) return 5;
  if (mid >= (band.min + band.max) / 2) return 4.5;
  if (mid >= band.min) return 3.5;
  if (mid >= band.min * 0.9) return 2.5;
  if (mid >= band.min * 0.8) return 2;
  return 1.5;
}

// ── next_action ──────────────────────────────────────────────────────────────

/**
 * Pre-application emails to "confirm" salary band or working language turn a
 * direct-hire ATS application into a recruiter negotiation before there is
 * anything to negotiate. Those questions belong in the first-call script.
 */
export const FORBIDDEN_PREAPPLY = /\b(e-?mail|write to|message|contact|ask|ping|reach out to|call)\b[^\n]{0,160}?\b(salary|band|comp(?:ensation)?|pay range|working language|language|english|german|deutsch)\b[^\n]{0,200}?\b(before (?:apply|applying|submitting|you apply)|prior to (?:apply|applying)|apply only if|only apply if|then apply|and only then)/i;

/** Pre-application emails are only wrong for a direct hire; agency/B2B roles must be qualified first. */
export function isForbiddenNextAction(text, record) {
  if (!record || record.employment_type === 'agency' || record.employment_type === 'contract_b2b') return false;
  return FORBIDDEN_PREAPPLY.test(String(text || ''));
}

const LANG_LABEL = { de: 'German', fr: 'French', it: 'Italian', en: 'English' };

/**
 * Ordered next_action checklist, by decision, employment type and channel.
 * Each step names the ready-to-paste text the report must provide.
 *
 * @param {{employment_type?:string, channel?:string, language?:string, url?:string|null, contact?:{name?:string|null, role?:string|null}}} record
 * @param {'apply'|'consider'|'skip'} decision
 * @returns {{kind:string, step:string, text:string|null}[]}
 */
export function nextActionPlan(record, decision) {
  const lang = LANG_LABEL[record.language || 'en'] || 'English';
  const name = record.contact?.name || null;
  const et = record.employment_type || 'unknown';

  if (decision === 'skip') {
    if (et === 'agency' || et === 'contract_b2b') {
      return [{ kind: 'decline', step: `Reply to the recruiter: decline this mandate in one line and ask to be matched to roles closer to the target archetypes`, text: 'recruiter_reply' }];
    }
    return [{ kind: 'none', step: 'Do not apply. No further action.', text: null }];
  }

  if (et === 'contract_b2b' || et === 'agency') {
    return [
      { kind: 'qualify', step: `Qualify the role with the recruiter before sending a CV: ask whether it is B2B/contract or direct hire, the rate or band, and the end client's working language`, text: 'qualify_message' },
      { kind: 'hold_cv', step: 'Do not send the CV until the role is qualified (end client, engagement type, rate)', text: null },
      { kind: 'no_free_info', step: 'Share no information about other commitments, availability dates or rates beyond what the qualification needs', text: null },
      { kind: 'first_call', step: 'First call: use the first-call script (rate, B2B vs direct hire, language) in Block F', text: 'first_call_script' },
    ];
  }

  /** @type {{kind:string, step:string, text:string|null}[]} */
  const steps = [];
  const via = record.channel === 'company_ats' ? 'the company ATS' : record.channel === 'referral' ? 'the referral path' : 'the posting';
  steps.push({ kind: 'apply', step: `Apply via ${via}${record.url ? ` (${record.url})` : ''} with the tailored CV, the cover letter and the ATS form answers`, text: 'ats_answers+cover_letter' });
  if (name) {
    steps.push({ kind: 'linkedin_note', step: `After applying: LinkedIn connection note to ${name}${record.contact?.role ? ` (${record.contact.role})` : ''}, in ${lang}, under 300 characters`, text: 'linkedin_note' });
  }
  steps.push({ kind: 'first_call', step: 'First call: salary band and working-language questions go in the first-call script (verbatim lines in Block F), never in a pre-application email', text: 'first_call_script' });
  return steps;
}

// ── report patching ──────────────────────────────────────────────────────────

const SUMMARY_RE = /(## Machine Summary\s*\n+```ya?ml\n)([\s\S]*?)(\n```)/;

export function readSummary(md) {
  const m = md.match(SUMMARY_RE);
  if (!m) return null;
  try { return /** @type {Record<string, any>} */ (yaml.load(m[2])) || {}; } catch { return null; }
}

/** Never fold long strings: report-meta and ingest-server read scalars line by line. */
export function writeSummary(md, summary) {
  const body = yaml.dump(summary, { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false }).trimEnd();
  return md.replace(SUMMARY_RE, (_, a, _b, c) => `${a}${body}${c}`);
}

/** Read the dimension table ("| CV Match | 4.5/5 |") when the summary has no `scores:` map. */
export function scoresFromTable(md) {
  // Cells may be bold ("| CV Match | **4.5/5** |").
  const pick = (label, penalty = false) => {
    const re = new RegExp(`\\|\\s*\\**\\s*${label}[^|]*\\|\\s*\\**\\s*${penalty ? '[-−]?\\s*' : ''}([\\d.]+)${penalty ? '' : '\\s*\\/\\s*5'}`, 'i');
    const m = md.match(re); return m ? Number(m[1]) : null;
  };
  return {
    cv_match: pick('CV Match'),
    north_star: pick('North Star'),
    comp: pick('Comp(?!any)'),
    culture: pick('Cultur'),
    risk: pick('Risk'),
    red_flags: pick('Red flags?', true),
  };
}

export function fitDealBox({ fit, deal, decision, priority, scores }) {
  const f = (v) => (v === null || v === undefined ? 'n/a' : `${Number(v).toFixed(1)}/5`);
  const rf = num(scores.red_flags) ? ` − ${Math.abs(num(scores.red_flags)).toFixed(1)} red flags` : '';
  return [
    '## Fit vs Deal',
    '',
    '| | Score | Inputs | Drives |',
    '|---|---|---|---|',
    `| **Fit** | **${f(fit)}** | CV match ${f(scores.cv_match)} · North Star ${f(scores.north_star)}${rf} | **Decision: ${decision.toUpperCase()}** (≥4.0 apply · 3.0-3.9 consider · <3.0 skip) |`,
    `| **Deal** | **${f(deal)}** | Comp ${f(scores.comp)} · Culture ${f(scores.culture)} · Risk ${f(scores.risk)} | **Priority: ${priority.toUpperCase()}** + negotiation (never the decision) |`,
    '',
  ].join('\n');
}

const BOX_RE = /## Fit vs Deal\n[\s\S]*?(?=\n## |\n---\n|$)/;

/**
 * Recompute every rule-owned field of a report and patch it in place.
 *
 * @param {string} md report markdown
 * @param {{record?:any, profile?:any}} [ctx]
 * @returns {{md:string, result:{fit_score:number|null, deal_score:number|null, decision:string, priority:string, corrections:string[]}}}
 */
export function enforceReport(md, ctx = {}) {
  const corrections = [];
  const summary = readSummary(md);
  if (!summary) return { md, result: { fit_score: null, deal_score: null, decision: 'consider', priority: 'medium', corrections: ['no parseable Machine Summary — nothing enforced'] } };
  const record = ctx.record || null;
  const profile = ctx.profile || null;

  const table = scoresFromTable(md);
  const scores = { ...table, ...(summary.scores || {}) };
  for (const k of Object.keys(table)) if (scores[k] === null || scores[k] === undefined) scores[k] = table[k];

  // Hard stops: nice_to_have requirements and soft language gaps cannot be hard.
  let hardStops = Array.isArray(summary.hard_stops) ? [...summary.hard_stops] : [];
  const softGaps = Array.isArray(summary.soft_gaps) ? [...summary.soft_gaps] : [];
  if (record?.requirements?.length) {
    const nice = record.requirements.filter((r) => r.level === 'nice_to_have');
    const demoted = hardStops.filter((h) => nice.some((n) => overlap(h, n.text) >= 0.5 || namesNiceOnlyTerms(h, record)));
    for (const h of demoted) { hardStops = hardStops.filter((x) => x !== h); softGaps.push(`${h} (nice-to-have in the JD, demoted from hard stop)`); corrections.push(`hard stop demoted (JD lists it as nice-to-have): ${h.slice(0, 80)}`); }
  }
  if (record && profile) {
    const lg = languageGap(record, profile);
    const langStops = hardStops.filter((h) => /\b(german|deutsch|french|französisch|français|italian|language|sprach)/i.test(h));
    if (lg.gap !== 'hard' && langStops.length) {
      for (const h of langStops) { hardStops = hardStops.filter((x) => x !== h); softGaps.push(`${h} (soft: no required level above ${lg.candidate || 'the candidate level'} stated)`); }
      corrections.push(`language hard stop demoted to soft gap: the JD states no required ${LANG_LABEL[lg.language] || lg.language} level above ${lg.candidate}`);
    }
    if (lg.gap === 'hard' && !langStops.length) {
      hardStops.push(`${LANG_LABEL[lg.language]} ${lg.required} required ("${lg.evidence}"), candidate is ${lg.candidate}`);
      corrections.push(`language hard stop added: JD requires ${lg.required}, candidate ${lg.candidate}`);
    }
    summary.language_gap = lg.gap;
  }

  // Domain gaps: consult profile.yml industries before declaring one.
  const industries = profileIndustries(profile);
  for (const list of [hardStops, softGaps]) {
    for (const g of [...list]) {
      const key = domainGapIndustry(String(g));
      if (key && industries[key]) {
        list.splice(list.indexOf(g), 1);
        corrections.push(`domain gap removed: profile.yml industries.${key} lists ${industries[key].slice(0, 3).join(', ')}`);
      }
    }
  }

  // Comp on TOTAL compensation (base + bonus + pension delta), never base alone.
  const comp = summary.comp || {};
  const baseMin = num(comp.base_min); const baseMax = num(comp.base_max) ?? baseMin;
  if (baseMin !== null) {
    const birth = num(profile?.candidate?.birthyear);
    const tc = totalComp({ min: baseMin, max: baseMax }, record?.benefits || comp.benefits || {}, { age: birth ? new Date().getFullYear() - birth : null });
    const band = targetBand(profile);
    const derived = compScoreFromTotal(tc.total, band);
    summary.comp = { ...comp, base_min: baseMin, base_max: baseMax, total_min: tc.total.min, total_max: tc.total.max, bonus_estimate: tc.bonus_estimate, pension_delta: tc.pension_delta, mobile_office: tc.mobile_office, assumptions: tc.assumptions, ...(band ? { target_min: band.min, target_max: band.max } : {}) };
    if (derived !== null && num(scores.comp) !== derived) {
      corrections.push(`comp ${scores.comp ?? 'n/a'} → ${derived} (scored on total comp CHF ${Math.round(tc.total.min / 1000)}-${Math.round(tc.total.max / 1000)}K vs target ${band ? `${band.min / 1000}-${band.max / 1000}K` : 'n/a'}, not base alone)`);
      scores.comp = derived;
    }
  }

  // A gap entry that says it does not apply is not a gap.
  for (const g of [...softGaps]) {
    if (/\b(not applicable|does not apply|n\/a)\b/i.test(String(g))) { softGaps.splice(softGaps.indexOf(g), 1); corrections.push(`non-gap removed from soft_gaps: ${String(g).slice(0, 60)}`); }
  }

  const level = summary.level || {};
  const lgap = levelGap(level.detected, level.candidate || profile?.candidate?.level);
  if (lgap.overqualified && !softGaps.some((g) => /overqualif/i.test(g))) {
    softGaps.push(OVERQUALIFICATION_GAP);
    corrections.push('overqualification soft gap added (detected level below candidate level)');
  }
  if (Object.keys(level).length || lgap.overqualified) summary.level = { ...level, overqualified: lgap.overqualified };

  const fit = fitScore(scores);
  const deal = dealScore(scores);
  const decision = decide(fit, hardStops);
  const priority = priorityOf(deal);

  if (summary.fit_score !== undefined && num(summary.fit_score) !== fit) corrections.push(`fit_score ${summary.fit_score} → ${fit} (recomputed from dimensions)`);
  if (summary.decision && String(summary.decision).toLowerCase() !== decision) corrections.push(`decision ${summary.decision} → ${decision}`);

  // next_action: an ordered checklist. Forbidden pre-application emails (direct
  // hire) are replaced by the rule plan; a single string becomes a one-item list.
  const plan = record ? nextActionPlan(record, decision) : null;
  if (typeof summary.next_action === 'string') summary.next_action = [summary.next_action];
  const naText = JSON.stringify(summary.next_action || '');
  if (plan && (isForbiddenNextAction(naText, record) || !summary.next_action?.length)) {
    if (summary.next_action?.length) corrections.push('next_action rewritten: a pre-application email to the recruiter about salary band or working language is not allowed for a direct hire; those questions go in the first-call script');
    summary.next_action = plan.map((p) => p.step);
  } else if (plan && record.employment_type === 'direct_hire' && record.channel === 'company_ats' && decision !== 'skip' && !/\bapply\b/i.test(String(summary.next_action[0] || ''))) {
    summary.next_action = plan.map((p) => p.step);
    corrections.push('next_action reordered: a direct hire at a company ATS starts with the application');
  } else if (plan && decision === 'skip' && summary.next_action?.length && /\bapply\b/i.test(String(summary.next_action[0]))) {
    summary.next_action = plan.map((p) => p.step);
    corrections.push('next_action replaced: decision is skip');
  }

  Object.assign(summary, {
    score: fit,
    fit_score: fit,
    deal_score: deal,
    decision,
    priority,
    final_decision: LEGACY_DECISION[decision],
    scores,
    hard_stops: hardStops,
    soft_gaps: [...new Set(softGaps)],
  });
  if (record) Object.assign(summary, { employment_type: record.employment_type, channel: record.channel, language: record.language, jd_content_hash: record.content_hash });

  let out = writeSummary(md, summary);
  out = out.replace(/^\*\*Score:\*\*.*$/m, `**Score:** ${fit === null ? 'n/a' : `${fit.toFixed(1)}/5`} (fit) · **Deal:** ${deal === null ? 'n/a' : `${deal.toFixed(1)}/5`} · **Decision:** ${decision.toUpperCase()} · **Priority:** ${priority.toUpperCase()}`);
  const box = fitDealBox({ fit, deal, decision, priority, scores });
  if (BOX_RE.test(out)) out = out.replace(BOX_RE, box);
  else out = out.replace(/(\n---\n)/, `$1\n${box}`);

  return { md: out, result: { fit_score: fit, deal_score: deal, decision, priority, corrections } };
}

/** Token overlap of two phrases (share of the shorter phrase's significant words). */
function overlap(a, b) {
  const words = (s) => new Set(String(s).toLowerCase().match(/[a-zäöüéèà0-9/+#.-]{4,}/g) || []);
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

const NON_TECH = new Set(['the', 'jd', 'cv', 'muss', 'soll', 'kriterium', 'kriterien', 'and', 'or', 'mit', 'nachweis', 'role', 'one', 'not', 'is', 'of', 'on', 'a', 'an', 'at', 'in', 'to']);

/**
 * A hard stop whose technologies the JD lists only as nice-to-have (e.g.
 * OpenShift, Kubernetes, Argo CD under SBB's Soll-Kriterien): of the stop's
 * capitalised terms that appear in the JD requirements at all, a majority
 * (and at least two) appear only in nice_to_have items.
 */
function namesNiceOnlyTerms(stop, record) {
  const terms = [...new Set((String(stop).match(/\b[A-Za-z][A-Za-z0-9+#]*[A-Z][A-Za-z0-9+#]*\b|\b[A-Z][a-z][A-Za-z0-9+#]+\b/g) || [])
    .map((t) => t.toLowerCase()).filter((t) => t.length >= 2 && !NON_TECH.has(t)))];
  const words = (level) => new Set(record.requirements.filter((r) => r.level === level).flatMap((r) => r.text.toLowerCase().match(/[a-z0-9+#]+/g) || []));
  const nice = words('nice_to_have');
  const req = words('required');
  const inJd = terms.filter((t) => nice.has(t) || req.has(t));
  const niceOnly = inJd.filter((t) => nice.has(t) && !req.has(t));
  return niceOnly.length >= 2 && niceOnly.length / inJd.length > 0.5;
}

/** Patch a tracker-additions TSV line: score = fit, status/notes follow the decision. */
export function patchTsv(line, { fit, decision, priority }) {
  const cols = line.replace(/\n$/, '').split('\t');
  if (cols.length < 9) return line;
  if (fit !== null) cols[5] = `${fit.toFixed(1)}/5`;
  if (cols[4] === 'Evaluated' || cols[4] === 'SKIP') cols[4] = decision === 'skip' ? 'SKIP' : 'Evaluated';
  const tag = `${decision.toUpperCase()} ${priority.toUpperCase()}`;
  cols[8] = /^(APPLY|CONSIDER|SKIP)\b/.test(cols[8]) ? cols[8].replace(/^(APPLY|CONSIDER|SKIP)(\s+(HIGH|MEDIUM|LOW)\b)?/, tag) : `${tag}: ${cols[8]}`;
  return `${cols.join('\t')}\n`;
}

/**
 * Enforce on a report file in place, building the JD record from raw text when
 * no record file exists (gemini-eval / ollama-eval). Never throws: a report
 * that cannot be enforced is left as written.
 * @param {string} reportPath
 * @param {{jdText?:string, url?:string|null, record?:any, profilePath?:string}} [opts]
 */
export function enforceFile(reportPath, opts = {}) {
  try {
    const record = opts.record || (opts.jdText ? buildRecord({ text: opts.jdText, sourceType: opts.url ? 'url' : 'paste', url: opts.url || null }) : null);
    const profilePath = opts.profilePath || join(ROOT, 'config/profile.yml');
    const profile = existsSync(profilePath) ? yaml.load(readFileSync(profilePath, 'utf8')) : null;
    const md = readFileSync(reportPath, 'utf8');
    const { md: out, result } = enforceReport(md, { record, profile });
    if (out !== md) writeFileSync(reportPath, out);
    return result;
  } catch (e) {
    return { fit_score: null, deal_score: null, decision: 'consider', priority: 'medium', corrections: [`enforce failed: ${e.message}`] };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function argOf(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; }

function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (cmd !== 'enforce' || !file) {
    console.error('Usage: node evaluation-rules.mjs enforce <report.md> [--record rec.json] [--tsv file.tsv] [--profile config/profile.yml] [--write]');
    process.exit(2);
  }
  const recPath = argOf(rest, '--record');
  const tsvPath = argOf(rest, '--tsv');
  const profilePath = argOf(rest, '--profile') || join(ROOT, 'config/profile.yml');
  const record = recPath && existsSync(recPath) ? JSON.parse(readFileSync(recPath, 'utf8')) : null;
  const profile = existsSync(profilePath) ? yaml.load(readFileSync(profilePath, 'utf8')) : null;
  const md = readFileSync(file, 'utf8');
  const { md: out, result } = enforceReport(md, { record, profile });
  if (rest.includes('--write')) {
    if (out !== md) writeFileSync(file, out);
    if (tsvPath && existsSync(tsvPath)) writeFileSync(tsvPath, patchTsv(readFileSync(tsvPath, 'utf8'), { fit: result.fit_score, decision: result.decision, priority: result.priority }));
  }
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
