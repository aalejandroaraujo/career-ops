#!/usr/bin/env node
/**
 * test-jd-intake.mjs — the canonical JD record is the same whichever door the
 * JD came through, and its classifications drive the evaluation rules.
 *
 * The fixture is a fictional posting (test-fixtures/jd-intake/) rendered as
 * paste (.md), page HTML, browser-print PDF and screenshot PNG; .docx and .eml
 * forms are built here at runtime. PDF and OCR checks skip with a note when
 * pdftotext / tesseract are not installed.
 *
 * Run: node test-jd-intake.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  buildRecord, contentHash, detectChannel, detectEmploymentType, detectLanguage, intakeFile, normalizeText,
} from './jd-intake.mjs';

let passed = 0;
let failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
const has = (cmd) => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };

const FIX = 'test-fixtures/jd-intake/acme-platform-engineer';
const tmp = mkdtempSync(join(tmpdir(), 'jd-intake-'));

// ── build a .docx (stored+deflate zip) from the paste text ───────────────────
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8'); const comp = deflateRawSync(data); const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp); centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const paste = readFileSync(`${FIX}.md`, 'utf8');
const docXml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${
  paste.split('\n').map((l) => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;
writeFileSync(join(tmp, 'jd.docx'), zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': docXml }));

// ── build a forwarded email (.eml, quoted-printable) ─────────────────────────
const qp = Buffer.from(paste, 'utf8').toString('latin1').replace(/[^\x20-\x7e\n]|=/g, (c) => `=${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
writeFileSync(join(tmp, 'jd.eml'), [
  'From: "Erika Muster" <erika.muster@example.com>',
  'Subject: Platform Engineer AI (w/m/d) 80-100% - Acme Versicherungen AG',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  qp,
].join('\r\n'));

console.log('\n1. Same JD, every input form → same canonical record');
const fromPaste = buildRecord({ text: paste, sourceType: 'paste' });
const fromHtml = intakeFile(`${FIX}.html`, { sourceType: 'url', url: 'https://jobs.acme.example/offene-stellen/platform-engineer-ai' });
const fromDocx = intakeFile(join(tmp, 'jd.docx'));
const fromEml = intakeFile(join(tmp, 'jd.eml'));
eq(fromHtml.content_hash, fromPaste.content_hash, 'URL render hashes the same as the paste');
eq(fromDocx.content_hash, fromPaste.content_hash, '.docx hashes the same as the paste');
eq(fromEml.content_hash, fromPaste.content_hash, 'forwarded .eml hashes the same as the paste');
eq([fromHtml.source_type, fromDocx.source_type, fromEml.source_type], ['url', 'file', 'email'], 'source_type records the door');
if (has('pdftotext')) {
  const fromPdf = intakeFile(`${FIX}.pdf`);
  eq(fromPdf.content_hash, fromPaste.content_hash, 'browser-print PDF hashes the same as the paste');
  ok(!/%PDF|\u0000/.test(fromPdf.raw_text), 'PDF intake yields text, never PDF bytes');
} else console.log('  ⚠️  pdftotext not installed — PDF equivalence skipped');
if (has('tesseract')) {
  const fromPng = intakeFile(`${FIX}.png`);
  eq(fromPng.source_type, 'screenshot', 'image input is a screenshot');
  eq([fromPng.title, fromPng.company, fromPng.workload, fromPng.employment_type], [fromPaste.title, fromPaste.company, fromPaste.workload, fromPaste.employment_type], 'OCRed screenshot recovers title/company/workload/employment type');
  eq(fromPng.requirements.map((r) => r.level), fromPaste.requirements.map((r) => r.level), 'OCRed screenshot keeps the required / nice-to-have split');
} else console.log('  ⚠️  tesseract not installed — screenshot OCR skipped');

console.log('\n2. Record fields');
eq(fromPaste.title, 'Platform Engineer AI (w/m/d) 80-100%', 'title from first title-like line');
eq(fromPaste.company, 'Acme Versicherungen AG', 'company from the title line');
eq(fromPaste.language, 'de', 'language detected from content');
eq(fromPaste.workload, '80-100%', 'workload (Pensum)');
eq(fromPaste.location, 'Musterstrasse 1, 8000 Zürich', 'location from Arbeitsort');
eq(fromPaste.employment_type, 'direct_hire', 'Pensum + Pensionskasse → direct hire');
eq(fromHtml.channel, 'company_ats', 'company careers host → company_ats');
eq(fromEml.channel, 'recruiter', 'forwarded email → recruiter channel');
eq(fromPaste.requirements.map((r) => r.level), ['required', 'required', 'nice_to_have'], '"von Vorteil" → nice_to_have');
eq(fromPaste.responsibilities.length, 3, 'responsibilities parsed');
eq(fromPaste.benefits.vacation_days, 25, 'vacation days');
eq(fromPaste.benefits.pension_employer_share, 60, 'pension employer share %');
ok(/bonus/i.test(fromPaste.benefits.bonus || ''), 'bonus detected');
ok(/mobile office/i.test(fromPaste.benefits.mobile_office || ''), 'mobile office detected');
eq(fromPaste.contact, { name: 'Erika Muster', role: 'Talent Acquisition Partner', channel: 'ats_contact_form' }, 'named contact with role');
eq(fromPaste.apply_control_present, true, '"Jetzt bewerben" → apply_control_present');
ok(!/cookie/i.test(fromHtml.raw_text), 'cookie banner stripped from page text');

console.log('\n3. Classifiers');
eq(detectEmploymentType('Delivery Model: Personalverleih. Einsatz ab sofort.'), 'agency', 'Personalverleih → agency');
eq(detectEmploymentType('Freelance contract, day rate CHF 1200, outside IR35'), 'contract_b2b', 'day rate → contract_b2b');
eq(detectEmploymentType('Wir bieten eine Festanstellung mit attraktiver Pensionskasse.'), 'direct_hire', 'Festanstellung → direct_hire');
eq(detectEmploymentType('We build tools.'), 'unknown', 'no signal → unknown');
eq(detectChannel({ url: 'https://www.linkedin.com/jobs/view/1', text: '', sourceType: 'url' }), 'aggregator', 'linkedin job page → aggregator');
eq(detectChannel({ url: 'https://boards.greenhouse.io/acme/jobs/1', text: '', sourceType: 'url' }), 'company_ats', 'greenhouse → company_ats');
eq(detectChannel({ url: null, text: 'Role at SBB (via recruiter Jane Doe, LinkedIn message)', sourceType: 'file' }), 'recruiter', '"via recruiter" capture → recruiter');
eq(detectChannel({ url: null, text: 'I was referred by Max Muster, who works there.', sourceType: 'paste' }), 'referral', 'referred by → referral');
eq(detectLanguage('We are looking for an engineer who will own the platform and work with our teams in the cloud.'), 'en', 'English detected');
eq(detectLanguage('Nous recherchons un ingénieur pour la plateforme avec une équipe dans le cloud et des clients.'), 'fr', 'French detected');

console.log('\n4. Muss/Soll sections');
const mussSoll = buildRecord({
  text: 'Platform Architect (m/w/d)\n\nMuss-Kriterien mit Nachweis\n• Mindestens 5 Jahre Erfahrung in Softwarearchitektur und Plattformen\n\nSoll-Kriterien\n• Kenntnisse von OpenShift, Kubernetes und Argo CD\n\nDelivery Model: Personalverleih',
  sourceType: 'paste',
});
eq(mussSoll.requirements.map((r) => r.level), ['required', 'nice_to_have'], 'Soll-Kriterien are nice_to_have, never hard requirements');
eq(mussSoll.employment_type, 'agency', 'Personalverleih capture → agency');

console.log('\n5. Hash stability');
const reordered = { ...fromPaste, source_type: 'batch', url: 'https://x.example', raw_text: 'different', warnings: ['w'] };
eq(contentHash(reordered), fromPaste.content_hash, 'source metadata does not change the content hash');
eq(normalizeText('a b\r\n\r\n\r\n• c'), 'a b\n\n• c', 'normalization collapses spaces and blank runs');

console.log('\n6. CLI');
const out = join(tmp, 'rec.json'); const txt = join(tmp, 'jd.txt');
execFileSync(process.execPath, ['jd-intake.mjs', `${FIX}.md`, '--out', out, '--text-out', txt], { stdio: 'pipe' });
const cliRec = JSON.parse(readFileSync(out, 'utf8'));
eq(cliRec.content_hash, fromPaste.content_hash, 'CLI writes the same record');
ok(readFileSync(txt, 'utf8').startsWith('Platform Engineer AI'), 'CLI --text-out writes normalized text');
let thin = 0;
try { execFileSync(process.execPath, ['jd-intake.mjs', '-'], { input: 'too short', stdio: 'pipe' }); } catch (e) { thin = e.status; }
eq(thin, 3, 'under-200-char JD exits 3 so the worker treats the JD as missing');

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
