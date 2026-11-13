#!/usr/bin/env node
// @ts-check
/**
 * jd-intake.mjs — turn any job-description input into ONE canonical JD record.
 *
 * Why: a JD reached the evaluator in six different shapes (URL render, pasted
 * text saved to jds/*.md, a browser-printed PDF, a screenshot, a forwarded
 * email, a batch scan row) and each shape was read differently. A `local:jds/`
 * PDF was even copied byte-for-byte into the worker's `.txt` JD file, so a
 * worker without native PDF reading saw binary. Every downstream rule (fit vs
 * deal, next_action by employment type, language rules, comp on total comp)
 * reads from the record this module produces, so the same JD gets the same
 * treatment whatever door it came through.
 *
 * Deterministic and offline: no LLM, no network, no Playwright. Text
 * extraction shells out to pdftotext / tesseract when the input needs them and
 * degrades to "unknown" fields (never a crash) when they are missing.
 *
 * CLI:
 *   node jd-intake.mjs <file|-> [--source url|paste|file|screenshot|email|batch]
 *                      [--url <url>] [--out record.json] [--text-out jd.txt]
 *   `-` reads pasted text from stdin. Prints the record as JSON when --out is absent.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { APPLY_TEXT_PATTERNS } from './liveness-core.mjs';

export const RECORD_VERSION = 1;

export const SOURCE_TYPES = ['url', 'paste', 'file', 'screenshot', 'email', 'batch'];
export const EMPLOYMENT_TYPES = ['direct_hire', 'contract_b2b', 'agency', 'unknown'];
export const CHANNELS = ['company_ats', 'aggregator', 'recruiter', 'referral'];

// ── text extraction ──────────────────────────────────────────────────────────

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.bmp', '.gif']);

function has(cmd) {
  try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** OCR languages actually installed, so tesseract never fails on a missing pack. */
function ocrLangs() {
  try {
    const out = execFileSync('tesseract', ['--list-langs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const have = new Set(out.split('\n').slice(1).map((s) => s.trim()).filter(Boolean));
    const want = ['deu', 'eng', 'fra', 'ita'].filter((l) => have.has(l));
    return want.length ? want.join('+') : 'eng';
  } catch { return 'eng'; }
}

function ocrImage(path) {
  if (!has('tesseract')) return { text: '', warning: 'tesseract not installed; screenshot not OCRed' };
  try {
    const text = execFileSync('tesseract', [path, 'stdout', '-l', ocrLangs()], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 });
    return { text, warning: null };
  } catch (e) { return { text: '', warning: `OCR failed: ${e.message.split('\n')[0]}` }; }
}

function pdfText(path) {
  if (!has('pdftotext')) return { text: '', warning: 'pdftotext not installed; PDF not extracted' };
  let text = '';
  try {
    text = execFileSync('pdftotext', ['-enc', 'UTF-8', path, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 });
  } catch (e) { return { text: '', warning: `pdftotext failed: ${e.message.split('\n')[0]}` }; }
  if (text.replace(/\s/g, '').length >= 200) return { text, warning: null };
  // Image-only PDF (a scanned or "print as image" capture) → OCR each page.
  if (!has('pdftoppm') || !has('tesseract')) return { text, warning: 'PDF has no text layer and OCR tools are missing' };
  const dir = mkdtempSync(join(tmpdir(), 'jd-ocr-'));
  try {
    execFileSync('pdftoppm', ['-r', '200', '-png', path, join(dir, 'p')], { stdio: 'ignore' });
    const pages = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    return { text: pages.map((p) => ocrImage(join(dir, p)).text).join('\n'), warning: 'PDF had no text layer; OCRed' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Minimal ZIP reader (stored + deflate) — enough for word/document.xml. */
function readZipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nlen);
    if (entry === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

export function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/ul|\/ol)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''));
}

function docxText(path) {
  const xml = readZipEntry(readFileSync(path), 'word/document.xml');
  if (!xml) return { text: '', warning: 'not a readable .docx' };
  const s = xml.toString('utf8')
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return { text: decodeEntities(s), warning: null };
}

function decodeQuotedPrintable(s) {
  const bytes = Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  return bytes.toString('utf8');
}

/**
 * Parse an RFC 822 message (.eml): headers + the best text body.
 * @returns {{text:string, from:string|null, subject:string|null}}
 */
export function emailText(raw) {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split >= 0 ? raw.slice(0, split) : raw;
  const body = split >= 0 ? raw.slice(split).replace(/^\r?\n\r?\n/, '') : '';
  const header = (name) => head.match(new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, 'im'))?.[1].replace(/\r?\n[ \t]+/g, ' ').trim() || null;
  const from = header('From');
  const subject = header('Subject');
  const ctype = header('Content-Type') || 'text/plain';
  const boundary = ctype.match(/boundary="?([^";]+)"?/i)?.[1];

  const decodePart = (h, b) => {
    let t = b;
    if (/content-transfer-encoding:\s*quoted-printable/i.test(h)) t = decodeQuotedPrintable(t);
    else if (/content-transfer-encoding:\s*base64/i.test(h)) t = Buffer.from(t.replace(/\s/g, ''), 'base64').toString('utf8');
    return /content-type:\s*text\/html/i.test(h) ? htmlToText(t) : t;
  };

  if (!boundary) return { text: decodePart(head, body), from, subject };
  const parts = body.split(`--${boundary}`).map((p) => {
    const i = p.search(/\r?\n\r?\n/);
    return i < 0 ? null : { h: p.slice(0, i), b: p.slice(i).replace(/^\r?\n\r?\n/, '') };
  }).filter(Boolean);
  const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p.h));
  const html = parts.find((p) => /content-type:\s*text\/html/i.test(p.h));
  const pick = plain || html;
  return { text: pick ? decodePart(pick.h, pick.b) : '', from, subject };
}

/**
 * Extract plain text from a file path, by type.
 * @returns {{text:string, kind:string, warning:string|null, email?:{from:string|null, subject:string|null}}}
 */
export function extractFile(path) {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return { kind: 'pdf', ...pdfText(path) };
  if (IMAGE_EXT.has(ext)) return { kind: 'image', ...ocrImage(path) };
  if (ext === '.docx') return { kind: 'docx', ...docxText(path) };
  const raw = readFileSync(path, 'utf8');
  if (ext === '.eml' || /^(Received|Return-Path|From|MIME-Version):/m.test(raw.slice(0, 2000)) && /^Subject:/m.test(raw.slice(0, 4000))) {
    const e = emailText(raw);
    return { kind: 'email', text: e.text, warning: null, email: { from: e.from, subject: e.subject } };
  }
  if (ext === '.html' || ext === '.htm') return { kind: 'html', text: htmlToText(raw), warning: null };
  return { kind: 'text', text: raw, warning: null };
}

// ── normalization ────────────────────────────────────────────────────────────

// Cookie banners and site chrome that page renders and browser-print PDFs drag
// in. Dropped line-by-line so they never reach requirements or language detection.
const BOILERPLATE_LINE = [
  /cookie/i, /datenschutz/i, /privacy (policy|statement)/i, /hinweis schliessen/i,
  /^(drucken|teilen|print|share|folge uns|follow us|mehr erfahren|learn more)$/i,
  /^(job-abo einrichten|zur karriereseite|kontaktformular|rechtliche hinweise.*)$/i,
  /^noch nicht das passende angebot/i, /^skip to (main )?content$/i,
];

/**
 * Canonical text form: same JD, same string, whichever door it came through.
 * Joins soft-wrapped lines (PDF), drops boilerplate, normalizes bullets/spaces.
 */
export function normalizeText(text) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '')            // soft hyphen
    .replace(/[   ]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim().replace(/^[•●▪◦‣∙·*\-–«»=©®■□]\s+/, '• '));
  /** @type {string[]} */
  const out = [];
  for (const line of lines) {
    if (!line) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    if (BOILERPLATE_LINE.some((re) => re.test(line))) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── section parsing ──────────────────────────────────────────────────────────

const HEADINGS = {
  responsibilities: /^(?:(?:dein|deine|ihr|ihre|your|the)\s+)?(?:verantwortungsbereich|aufgaben(?:gebiet|bereich)?|tätigkeiten|tasks|responsibilities|role|impact|missions?|vos missions|tes missions|was dich erwartet|das erwartet dich|what you(?:'ll| will) do|herausforderung(?:en)?|aufgabe)\b.{0,30}$/i,
  requirements: /^(?:(?:dein|deine|ihr|ihre|your|votre|ton)\s+)?(?:profil|profile|st(?:ä|a|i|ii)rken|kompetenzen|qualifikation(?:en)?|qualifications|requirements|anforderungen|voraussetzungen|was du mitbringst|das bringst du mit|what you bring|about you|muss-kriterien|soll-kriterien|kann-kriterien|must[- ]haves?|nice[- ]to[- ]haves?|what we(?:'re| are) looking for|who you are)\b.{0,30}$/i,
  benefits: /^(?:(?:deine|ihre|your|unsere|our)\s+)?(?:benefits|vorteile|was wir (?:dir|ihnen) bieten|wir bieten|unser angebot|what we offer|perks|avantages|nous offrons|anstellungsbedingungen.*)$/i,
  contact: /^(?:(?:dein|deine|ihr|ihre|your)\s+)?(?:kontakt|kontaktperson|ansprechperson|ansprechpartner(?:in)?|contact|recruiter)$/i,
  location: /^(?:(?:dein|ihr|your)\s+)?(?:arbeitsort|standort|location|lieu de travail|einsatz(?:ort)?)$/i,
  stop: /^(?:über uns|about us|über .{2,40}|à propos.*|wer wir sind|who we are|unternehmen|company)$/i,
};

/** Short marketing taglines ("Potenziale leben") are layout, not content. */
const isContentLine = (l) => l.length >= 8 && l.split(/\s+/).length >= 4;

const NICE_TO_HAVE = /\b(von vorteil|wünschenswert|idealerweise|ideally|nice[- ]to[- ]have|a plus|is a bonus|bonus points|preferred|soll-kriter|kann-kriter|un atout|apprécié|souhaité|optional)\b/i;

/** Umlaut/OCR-tolerant fold: "Deine Stärken", "Deine Starken" and OCR's "Deine Stiirken" all match. */
function foldChars(s) {
  return s.replace(/[äàâÄ]/g, 'a').replace(/[öôÖ]/g, 'o').replace(/[üûÜ]/g, 'u').replace(/ß/g, 'ss').replace(/[éèê]/g, 'e');
}
const fold = (line) => foldChars(line.replace(/ii/g, 'ü'));
const FOLDED_HEADINGS = Object.fromEntries(Object.entries(HEADINGS).map(([k, re]) => [k, new RegExp(foldChars(re.source), 'i')]));

function classifyHeading(line) {
  if (line.length > 60 || line.startsWith('• ')) return null;
  const folded = fold(line);
  for (const key of ['responsibilities', 'requirements', 'benefits', 'contact', 'location', 'stop']) {
    if (HEADINGS[key].test(line) || FOLDED_HEADINGS[key].test(folded)) return key;
  }
  return null;
}

/** Split normalized text into heading-labelled buckets of item lines. */
export function sections(text) {
  /** @type {Record<string, {heading:string, items:string[]}[]>} */
  const out = { responsibilities: [], requirements: [], benefits: [], contact: [], location: [], preamble: [] };
  let cur = { key: 'preamble', heading: '', items: /** @type {string[]} */ ([]) };
  const flush = () => { if (cur.items.length || cur.key !== 'preamble') (out[cur.key] ||= []).push({ heading: cur.heading, items: cur.items }); };
  for (const line of text.split('\n')) {
    if (!line) continue;
    const key = classifyHeading(line);
    if (key) {
      flush();
      cur = { key: key === 'stop' ? 'preamble' : key, heading: line, items: [] };
      continue;
    }
    cur.items.push(line.replace(/^• /, ''));
  }
  flush();
  return out;
}

// ── field extraction ─────────────────────────────────────────────────────────

const LANG_WORDS = {
  de: ['und', 'der', 'die', 'das', 'mit', 'für', 'du', 'dich', 'wir', 'ist', 'von', 'oder', 'ein', 'eine', 'deine', 'sowie', 'bei', 'auf', 'zu'],
  en: ['and', 'the', 'with', 'for', 'you', 'we', 'our', 'is', 'of', 'or', 'a', 'to', 'your', 'in', 'as', 'will', 'are', 'on'],
  fr: ['et', 'le', 'la', 'les', 'avec', 'pour', 'vous', 'nous', 'est', 'de', 'des', 'du', 'une', 'un', 'votre', 'sur', 'dans'],
  it: ['e', 'il', 'la', 'con', 'per', 'tu', 'noi', 'è', 'di', 'del', 'della', 'una', 'un', 'tuo', 'nel', 'che'],
};

export function detectLanguage(text) {
  const words = String(text).toLowerCase().match(/[a-zàâçéèêëîïôûùüÿñæœäöß]+/g) || [];
  /** @type {Record<string, number>} */
  const score = { de: 0, en: 0, fr: 0, it: 0 };
  const sets = Object.fromEntries(Object.entries(LANG_WORDS).map(([k, v]) => [k, new Set(v)]));
  for (const w of words) for (const k of Object.keys(sets)) if (sets[k].has(w)) score[k]++;
  const [best, n] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return n >= 5 ? best : 'unknown';
}

const AGGREGATOR_HOSTS = /(^|\.)(linkedin\.com|indeed\.\w+|jobs\.ch|jobup\.ch|jobscout24\.ch|stepstone\.\w+|glassdoor\.\w+|ictjobs\.ch|swissdevjobs\.ch|devitjobs\.\w+|monster\.\w+|xing\.com|welcometothejungle\.com|jobsuchmaschine\.ch|careerjet\.\w+|ziprecruiter\.com|wellfound\.com|otta\.com|himalayas\.app|remoteok\.com|weworkremotely\.com)$/i;
const ATS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.com|smartrecruiters\.com|successfactors\.\w+|recruitee\.com|personio\.\w+|bamboohr\.com|teamtailor\.com|jobs\.lever\.co|icims\.com|taleo\.net|join\.com|softgarden\.io|prospective\.ch|refline\.ch|umantis\.com|dvinci\.de|onlyfy\.jobs|rexx-systems\.com)$/i;

const AGENCY_NAMES = /\b(randstad|adecco|manpower|hays|michael page|page personnel|robert half|kelly services|gulp|experis|computer futures|progressive recruitment|harvey nash|modis|akkodis|coopers group|swisslinx|rockstar recruiting|red global|ekkiden|webconia|ghr|yellowshark|nemensis|mason frank|nigel frank|jefferson frank|frank recruitment)\b/i;

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function detectEmploymentType(text) {
  if (/\b(personalverleih|arbeitnehmerüberlassung|temporär(?:stelle|einsatz)?|temporary assignment|staff leasing|via (?:our|unseren) (?:client|kunden))\b/i.test(text)) return 'agency';
  if (/\b(freelance|freelancer|contractor|b2b|day rate|tagessatz|stundensatz|hourly rate|per hour|\/h\b|auftragsbasis|selbständig|self-employed|ltd company|outside ir35|inside ir35|contract role|contract position|mandat)\b/i.test(text)) return 'contract_b2b';
  if (/\b(festanstellung|unbefristet|permanent|full[- ]time employee|employee benefits|pensionskasse|bvg|vorsorge und sozialleistungen|cdi\b|pensum)\b/i.test(text)) return 'direct_hire';
  if (/\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%/.test(text)) return 'direct_hire'; // Swiss Pensum = employment
  // A single Pensum next to the gender marker ("(w/m/d) 100%"), or an in-house
  // Talent Acquisition / HR contact, is a company hiring for itself.
  if (/\((?:w\/m\/d|m\/w\/d|m\/f\/d|f\/m\/d|h\/f|f\/h)\)[^\n]{0,20}\b\d{2,3}\s*%/i.test(text)) return 'direct_hire';
  if (/\b(talent acquisition (?:partner|specialist|manager)|hr business partner|recruiting partner)\b/i.test(text)) return 'direct_hire';
  return 'unknown';
}

/**
 * @param {{url:string|null, text:string, sourceType:string, emailFrom?:string|null}} p
 */
export function detectChannel({ url, text, sourceType, emailFrom }) {
  if (/\b(referr(?:al|ed)|empfehlung|empfohlen)\b/i.test(text) && /\b(referred by|referral from|empfohlen von|referral via)\b/i.test(text)) return 'referral';
  if (sourceType === 'email' || /\bvia recruiter\b|\brecruiter\b.{0,40}\b(linkedin|message|nachricht)\b/i.test(text) || AGENCY_NAMES.test(text) || AGENCY_NAMES.test(emailFrom || '')) {
    if (!/\b(talent acquisition partner|talent acquisition)\b/i.test(text) || sourceType === 'email') return 'recruiter';
  }
  const host = hostOf(url || '');
  if (host && AGGREGATOR_HOSTS.test(host)) return 'aggregator';
  if (host && (ATS_HOSTS.test(host) || /^(jobs|careers?|karriere|stellen)\./i.test(host) || /\/(careers?|jobs|karriere|stellen|offene-stellen)\b/i.test(url || ''))) return 'company_ats';
  if (sourceType === 'batch' || sourceType === 'url') return host ? 'company_ats' : 'aggregator';
  return /\bvia recruiter\b/i.test(text) ? 'recruiter' : 'company_ats';
}

function detectWorkload(text) {
  const m = text.match(/\b(\d{2,3})\s*(?:%\s*)?[-–]\s*(\d{2,3})\s*%/) || text.match(/\b(\d{2,3})\s*%(?=\s*(?:pensum|workload|$|\)|,|\s))/im);
  if (!m) return /\b(full[- ]time|vollzeit|temps plein)\b/i.test(text) ? '100%' : null;
  return m[2] ? `${m[1]}-${m[2]}%` : `${m[1]}%`;
}

const PERSON_NAME = /^[A-ZÄÖÜÉÈ][a-zäöüéèàçß'\-]+(?:\s+(?:von|van|de|del|da)?\s*[A-ZÄÖÜÉÈ][a-zäöüéèàçß'\-]+){1,2}$/;

/**
 * @param {Record<string, {heading:string, items:string[]}[]>} secs
 * @param {string} text
 * @param {{from:string|null}|null} email
 */
function detectContact(secs, text, email) {
  const items = secs.contact.flatMap((s) => s.items);
  const roleWords = /\b(talent|acquisition|partner|recruit\w*|manager|team|hr|human|resources|people|kontakt\w*|contact)\b/i;
  const name = items.find((l) => PERSON_NAME.test(l) && !roleWords.test(l))
    || text.match(/\b(?:via recruiter|recruiter|from|von)\s+([A-ZÄÖÜ][a-zäöüé]+\s+[A-ZÄÖÜ][a-zäöüé]+)/)?.[1]
    || email?.from?.replace(/<.*>/, '').replace(/"/g, '').trim()
    || null;
  const role = items.find((l) => /\b(talent acquisition|recruit|hr\b|human resources|personal|people partner|hiring manager)/i.test(l))
    || (/\bvia recruiter\b/i.test(text) ? 'Recruiter' : null);
  const channel = /\blinkedin\b/i.test(text) && /\b(via recruiter|message|nachricht)\b/i.test(text) ? 'linkedin'
    : email ? 'email'
      : items.some((l) => /kontaktformular|contact form/i.test(l)) || name ? 'ats_contact_form' : null;
  return { name: name || null, role: role || null, channel };
}

function detectBenefits(secs, text) {
  const pool = [...secs.benefits.flatMap((s) => [s.heading, ...s.items]), ...text.split('\n')].join('\n');
  const pct = (re) => { const m = pool.match(re); return m ? Number(m[1].replace(',', '.')) : null; };
  const bonus = pool.match(/\b(bonus|erfolgsbeteiligung|variable[rn]? (?:vergütung|lohnanteil)|variable pay|13\.\s*monatslohn|13th (?:month )?salary|incentive)\b[^\n]{0,80}/i)?.[0].trim() || null;
  const pensionShare = pct(/(?:arbeitgeber|employer)[^\n%]{0,60}?(\d{2}(?:[.,]\d)?)\s*%[^\n]{0,40}(?:pensionskasse|bvg|vorsorge|pension)/i)
    ?? pct(/(?:pensionskasse|bvg|vorsorge|pension)[^\n%]{0,60}?(\d{2}(?:[.,]\d)?)\s*%[^\n]{0,30}(?:arbeitgeber|employer)/i)
    ?? (/(?:überobligatorisch|grosszügige pensionskasse|attractive pension|überdurchschnittliche (?:pensionskasse|vorsorge))/i.test(pool) ? 'above_legal_unquantified' : null);
  const vac = pool.match(/\b(\d{2})\s*(?:tage|days|jours)\s*(?:ferien|urlaub|vacation|holidays?|congés)/i)
    || pool.match(/\b(?:ferien|urlaub|vacation|holidays?)[^\n\d]{0,25}(\d{2})\s*(?:tage|days|jours)/i);
  const weeks = pool.match(/\b(\d)\s*(?:wochen|weeks|semaines)\s*(?:ferien|urlaub|vacation|congés)/i);
  const vacation_days = vac ? Number(vac[1]) : weeks ? Number(weeks[1]) * 5 : null;
  const mobile = /\b(mobile[s]? (?:office|arbeiten)|home[- ]?office|homeoffice|remote(?:[- ]work| arbeiten)?|hybrid(?:es)? arbeiten|work smart|télétravail|ortsunabhängig)\b/i.exec(pool);
  const other = secs.benefits.flatMap((s) => s.items)
    .filter((l) => l.length <= 80 && !/^(?:mehr erfahren|learn more)$/i.test(l));
  return {
    bonus,
    pension_employer_share: pensionShare,
    vacation_days,
    mobile_office: mobile ? mobile[0] : null,
    other: [...new Set(other)].slice(0, 20),
  };
}

function detectLocation(secs, text) {
  const items = secs.location.flatMap((s) => s.items);
  const city = /\b(Zürich|Zurich|Bern|Basel|Genève|Geneva|Lausanne|Luzern|Lucerne|Winterthur|Zug|St\.? Gallen|Baden|Aarau|Olten|Lugano|Schaffhausen|Chur|Fribourg|Neuchâtel|Sion|Thun|Biel|Remote|Hybrid)\b/i;
  const item = items.find((l) => city.test(l) || /\b\d{4}\s+\p{Lu}/u.test(l));
  if (item) return item;
  const m = text.match(/\b(\d{4})\s+(Zürich|Zurich|Bern|Basel|Genève|Geneva|Lausanne|Luzern|Lucerne|Winterthur|Zug|St\.? Gallen|Baden|Aarau|Olten|Lugano|Schaffhausen|Chur|Fribourg|Neuchâtel|Sion|Thun|Biel)\b/)
    || text.match(/\b(Zürich|Zurich|Bern|Basel|Genève|Geneva|Lausanne|Luzern|Winterthur|Zug|St\.? Gallen|Lugano|Remote|Hybrid)\b/);
  return m ? m[0] : null;
}

const TITLE_SIGNAL = /\((?:w\/m\/d|m\/w\/d|m\/f\/d|f\/m\/d|all genders|h\/f|f\/h|m\/w)\)|\b\d{2,3}\s*[-–]\s*\d{2,3}\s*%|\b(engineer|entwickler\S*|developer|architect\S*|architekt\S*|manager\S*|consultant|berater\S*|specialist|spezialist\S*|lead|analyst|scientist|owner|director|head of|ingénieur|ingenieur\S*|administrator|designer|expert\S*)\b/i;

function stripTitleNoise(t) {
  return t.replace(/^#+\s*/, '').replace(/^\[[^\]]+\]\s*/, '').replace(/\s+[-–—|]\s+(?:jobs?|karriere|careers?)\b.*$/i, '').trim();
}

/**
 * @param {string} text normalized
 * @param {{hintTitle?:string|null, hintCompany?:string|null, url?:string|null}} hints
 */
function detectTitleCompany(text, hints) {
  const lines = text.split('\n').filter(Boolean);
  // Saved paste header: "# Role — Company" (tracker-routes saveJdText).
  const h1 = lines.find((l) => /^#\s/.test(l));
  let title = hints.hintTitle || null;
  let company = hints.hintCompany || null;
  if (h1 && (!title || !company)) {
    const [t, c] = h1.replace(/^#\s*/, '').split(/\s+[—–]\s+/);
    title ||= stripTitleNoise(t || '');
    company ||= c ? c.replace(/\s*\(.*$/, '').trim() : null;
  }
  if (!title) {
    const candidate = (l) => !classifyHeading(l) && l.length >= 6 && l.length <= 140 && !/^(stellenprofil|benefits|kontakt|über uns|source:)/i.test(l);
    // Page renders and print-PDFs lead with nav words ("Karriere", "Jobs"); prefer
    // the first early line that actually looks like a job title.
    const first = lines.slice(0, 15).find((l) => candidate(l) && TITLE_SIGNAL.test(l))
      || lines.find((l) => candidate(l) && l.split(/\s+/).length >= 2);
    if (first) {
      const [t, c] = first.split(/\s+[-–—]\s+(?=[A-ZÄÖÜ])/);
      title = stripTitleNoise(t);
      if (!company && c) company = c.trim();
    }
  }
  if (!company) {
    const m = text.match(/\b([A-ZÄÖÜ][\w&.\- ]{1,40}?\s(?:AG|SA|GmbH|Ltd|Inc\.?|S\.A\.|SE|plc|LLC|Sàrl))\b/);
    company = m ? m[1].trim() : null;
  }
  return { title: title || null, company: company || null };
}

function splitRequirements(secs) {
  /** @type {{text:string, level:'required'|'nice_to_have'}[]} */
  const reqs = [];
  for (const s of secs.requirements) {
    const sectionNice = /soll-kriter|kann-kriter|nice[- ]to[- ]have|von vorteil|wünschenswert|preferred|bonus/i.test(s.heading);
    for (const item of s.items) {
      if (!isContentLine(item)) continue;
      reqs.push({ text: item, level: sectionNice || NICE_TO_HAVE.test(item) ? 'nice_to_have' : 'required' });
    }
  }
  return reqs;
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Build the canonical JD record.
 *
 * @param {{text:string, sourceType?:string, url?:string|null, email?:{from:string|null, subject:string|null}|null,
 *          hintTitle?:string|null, hintCompany?:string|null, warnings?:string[]}} input
 */
export function buildRecord(input) {
  const sourceType = SOURCE_TYPES.includes(input.sourceType || '') ? /** @type {string} */ (input.sourceType) : 'paste';
  const url = input.url && /^https?:\/\//.test(input.url) ? input.url : null;
  const raw = String(input.text || '');
  const text = normalizeText(raw);
  // "Source:" header lines from saved pastes describe the capture, not the job.
  const sourceLine = text.match(/^Source:\s*(.+)$/m)?.[1] || '';
  const body = text.replace(/^Source:.*$/m, '');
  const secs = sections(body);
  const { title, company } = detectTitleCompany(body, { hintTitle: input.hintTitle, hintCompany: input.hintCompany, url });
  const requirements = splitRequirements(secs);
  const responsibilities = secs.responsibilities.flatMap((s) => s.items).filter(isContentLine);
  const channelText = `${body}\n${sourceLine}`;

  const record = {
    record_version: RECORD_VERSION,
    source_type: sourceType,
    url,
    company,
    title,
    language: detectLanguage([...responsibilities, ...requirements.map((r) => r.text)].join(' ') || body),
    location: detectLocation(secs, body),
    workload: detectWorkload(`${title || ''}\n${body}`),
    employment_type: detectEmploymentType(body),
    channel: detectChannel({ url, text: channelText, sourceType, emailFrom: input.email?.from }),
    responsibilities,
    requirements,
    benefits: detectBenefits(secs, body),
    contact: detectContact(secs, channelText, input.email || null),
    apply_control_present: APPLY_TEXT_PATTERNS.some((re) => re.test(body)),
    raw_text: text,
    content_hash: '',
    warnings: input.warnings || [],
  };
  record.content_hash = contentHash(record);
  return record;
}

/**
 * Hash of the fields that drive scoring. Source metadata (source_type, url,
 * raw_text, warnings) is excluded on purpose: the same JD delivered as a URL, a
 * paste or a PDF must hash the same, and the calibration tests assert it.
 */
export function contentHash(rec) {
  const core = {
    company: rec.company, title: rec.title, language: rec.language, location: rec.location,
    workload: rec.workload, employment_type: rec.employment_type,
    responsibilities: rec.responsibilities, requirements: rec.requirements, benefits: rec.benefits,
  };
  return createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 16);
}

/**
 * Intake from a file path (or `-` for stdin text).
 * @param {string} path
 * @param {{sourceType?:string, url?:string|null, hintTitle?:string|null, hintCompany?:string|null}} [opts]
 */
export function intakeFile(path, opts = {}) {
  if (path === '-') {
    return buildRecord({ text: readFileSync(0, 'utf8'), sourceType: opts.sourceType || 'paste', url: opts.url, hintTitle: opts.hintTitle, hintCompany: opts.hintCompany });
  }
  if (!existsSync(path)) throw new Error(`JD file not found: ${path}`);
  const ex = extractFile(path);
  const sourceType = opts.sourceType
    || (ex.kind === 'image' ? 'screenshot' : ex.kind === 'email' ? 'email' : 'file');
  // A filed capture often records where it came from; recover the URL so the
  // channel is judged the same as if the URL had been submitted directly.
  const recovered = opts.url || ex.text.match(/^Source:\s*(https?:\/\/\S+)/m)?.[1] || null;
  return buildRecord({
    text: ex.kind === 'email' && ex.email?.subject ? `${ex.email.subject}\n\n${ex.text}` : ex.text,
    sourceType,
    url: recovered,
    email: ex.email || null,
    hintTitle: opts.hintTitle,
    hintCompany: opts.hintCompany,
    warnings: ex.warning ? [ex.warning] : [],
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function argOf(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const input = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (!input || args.includes('--help')) {
    console.error('Usage: node jd-intake.mjs <file|-> [--source url|paste|file|screenshot|email|batch] [--url <url>] [--out record.json] [--text-out jd.txt]');
    process.exit(input ? 0 : 2);
  }
  const source = argOf(args, '--source');
  if (source && !SOURCE_TYPES.includes(source)) {
    console.error(`--source must be one of ${SOURCE_TYPES.join(', ')}`);
    process.exit(2);
  }
  const rec = intakeFile(input, { sourceType: source, url: argOf(args, '--url') || null });
  const out = argOf(args, '--out');
  const textOut = argOf(args, '--text-out');
  if (textOut) writeFileSync(textOut, rec.raw_text + '\n');
  if (out) {
    writeFileSync(out, JSON.stringify(rec, null, 2) + '\n');
    console.error(`[jd-intake] ${rec.source_type} → ${out} (${rec.title || '?'} @ ${rec.company || '?'}, ${rec.language}, ${rec.employment_type}/${rec.channel}, ${rec.requirements.length} reqs, hash ${rec.content_hash})`);
  } else {
    process.stdout.write(JSON.stringify(rec, null, 2) + '\n');
  }
  if (rec.raw_text.length < 200) {
    console.error('[jd-intake] extracted text is under 200 chars — treat the JD as missing');
    process.exit(3);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(`[jd-intake] ${e.message}`); process.exit(1); });
}
