#!/usr/bin/env node

/**
 * build-cv-altacv.mjs — merge a CV JSON payload into the AltaCV template.
 *
 * Sibling of build-cv-latex.mjs (which serves the classic single-column
 * template). This one targets templates/cv-altacv.tex — a two-column,
 * photo-bearing AltaCV layout (Swiss/European style, the project default).
 *
 * Usage:
 *   node build-cv-altacv.mjs <input.json> <output.tex>
 *   node build-cv-altacv.mjs --test
 *
 * The photo (if any) is copied next to <output.tex> so the LaTeX compile finds
 * it. Then run generate-latex.mjs on the produced .tex to validate + compile.
 *
 * Payload schema — see modes/latex.md. Everything is LaTeX-escaped here; the
 * caller passes plain text and never needs to escape.
 */

import { readFile, writeFile, stat, copyFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, basename, extname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, 'templates', 'cv-altacv.tex');
const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/g;

// Icons we allow in \cvachievement / \cvsection markers. Anything else falls
// back to a safe default so a bad/injected icon name can't emit arbitrary TeX.
const SAFE_ICON_RE = /^\\?fa[A-Za-z0-9]+(\[[a-z]+\])?$/;

function escapeLatex(text) {
  if (typeof text !== 'string') return '';
  const out = [];
  for (const ch of text) {
    switch (ch) {
      case '\\': out.push('\\textbackslash{}'); break;
      case '{': case '}': out.push('\\' + ch); break;
      case '^': out.push('\\textasciicircum{}'); break;
      case '~': out.push('\\textasciitilde{}'); break;
      case '_': out.push('\\_'); break;
      case '&': out.push('\\&'); break;
      case '%': out.push('\\%'); break;
      case '$': out.push('\\$'); break;
      case '#': out.push('\\#'); break;
      case '±': out.push('$\\pm$'); break;
      case '→': out.push('{\\,\\faLongArrowAltRight\\,}'); break;
      default: out.push(ch);
    }
  }
  return out.join('');
}

function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  url = url.trim();
  if (!url) return '';
  const allowedSchemes = ['mailto:', 'http:', 'https:'];
  const hasScheme = allowedSchemes.some(s => url.toLowerCase().startsWith(s));
  if (!hasScheme) {
    if (url.includes('@') && !url.includes('/')) url = 'mailto:' + url;
    else url = 'https://' + url;
  }
  return url.replace(/[{}%$#\\~^]/g, '');
}

function icon(name, fallback) {
  const raw = typeof name === 'string' ? name.trim() : '';
  if (raw && SAFE_ICON_RE.test(raw)) return raw.startsWith('\\') ? raw : '\\' + raw;
  return fallback;
}

// company/institution optionally wrapped in a clickable link
function linked(label, url) {
  const text = escapeLatex(label);
  const href = sanitizeUrl(url || '');
  return href ? `\\href{${href}}{${text}}` : text;
}

// Replace "Present"/"present" in a date range with the current MM/YYYY at
// generation time (e.g. "02/2026 - Present" → "02/2026 - 07/2026").
function resolvePresent(dates) {
  if (typeof dates !== 'string') return dates ? String(dates) : '';
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return dates.replace(/present/gi, `${mm}/${now.getFullYear()}`);
}

// ── section builders ─────────────────────────────────────────────────────────

function buildPersonalInfo(p) {
  if (!p || typeof p !== 'object') return '';
  const lines = [];
  if (p.phone) lines.push(`  \\phone{${escapeLatex(p.phone)}}`);
  if (p.email) lines.push(`  \\email{${escapeLatex(p.email)}}`);
  if (p.location) lines.push(`  \\location{${escapeLatex(p.location)}}`);
  if (p.linkedin) lines.push(`  \\linkedin{${escapeLatex(p.linkedin)}}`);
  if (p.github) lines.push(`  \\github{${escapeLatex(p.github)}}`);
  if (p.homepage) lines.push(`  \\homepage{${escapeLatex(p.homepage)}}`);
  if (p.birthyear) lines.push(`  \\printinfo{\\faBirthdayCake}{${escapeLatex(String(p.birthyear))}}`);
  if (p.marital) lines.push(`  \\printinfo{\\faRing}{${escapeLatex(p.marital)}}`);
  if (p.permit) lines.push(`  \\printinfo{\\faIdCard}{${escapeLatex(p.permit)}}`);
  // Non-standard fields via \printinfo so we don't depend on custom macros.
  const citizenships = Array.isArray(p.citizenship) ? p.citizenship : (p.citizenship ? [p.citizenship] : []);
  for (const c of citizenships) {
    if (c) lines.push(`  \\printinfo{\\faIdCard}{${escapeLatex(c)}}`);
  }
  return lines.join('\n');
}

function buildExperience(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries.filter(Boolean).map(e => {
    const bullets = (Array.isArray(e.bullets) ? e.bullets : [])
      .map(b => `\\item ${escapeLatex(b)}`).join('\n');
    const items = bullets ? `\\begin{itemize}\n${bullets}\n\\end{itemize}` : '';
    return `\\cvevent{\\textbf{${escapeLatex(e.role)}}}{${linked(e.company, e.company_url)}}{${escapeLatex(resolvePresent(e.dates))}}{${escapeLatex(e.location)}}\n${items}`;
  }).join('\n\n\\divider\n\n');
}

function buildAchievements(entries, defaultIcon = '\\faGem') {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries.filter(Boolean).map(a =>
    `\\cvachievement{${icon(a.icon, defaultIcon)}}{${escapeLatex(a.title)}}{${escapeLatex(a.detail || '')}}`
  ).join('\n\n\\divider\n\n');
}

function buildSkillTags(tags) {
  // Accept a flat array of strings, or an array of arrays (groups separated by a divider).
  if (!Array.isArray(tags) || tags.length === 0) return '';
  const groups = Array.isArray(tags[0]) ? tags : [tags];
  return groups.map(group =>
    (Array.isArray(group) ? group : [group])
      .filter(Boolean).map(t => `\\cvtag{${escapeLatex(t)}}`).join('\n')
  ).join('\n\\divider\\smallskip\n');
}

function buildEducation(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries.filter(Boolean).map(e =>
    `\\cvevent{${escapeLatex(e.degree)}}{${linked(e.institution, e.institution_url)}}{${escapeLatex(e.dates)}}{${escapeLatex(e.location || '')}}`
  ).join('\n\n\\divider\n\n');
}

function buildLanguages(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries.filter(Boolean).map(l => {
    let lvl = Number(l.level);
    if (!Number.isFinite(lvl)) lvl = 3;
    lvl = Math.max(0, Math.min(5, Math.round(lvl)));
    // \cvskillnum renders the circles AND the numeric level after them.
    return `\\cvskillnum{${escapeLatex(l.name)}}{${lvl}}`;
  }).join('\n\\divider\n');
}

// Compact certification list — one \cvcert line each (small marker), so many
// certs fit. Appends " — {detail}" when a detail (e.g. "in progress") is given.
function buildCertifications(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  return entries.filter(Boolean).map(c => {
    const detail = c.detail ? ` --- ${escapeLatex(c.detail)}` : '';
    return `\\cvcert{${escapeLatex(c.title)}${detail}}`;
  }).join('\n');
}

// Compact, bulletless list of older roles under its own section — emitted only
// when there are entries, so an empty section header never appears.
function buildPreviousExperience(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const rows = entries.filter(Boolean).map(e =>
    `\\cvevent{${escapeLatex(e.role)}}{${linked(e.company, e.company_url)}}{${escapeLatex(resolvePresent(e.dates))}}{${escapeLatex(e.location || '')}}`
  ).join('\n\n\\divider\n\n');
  return `\\cvsection{Previous Relevant Experience}\n${rows}`;
}

// Resolve + copy the photo next to the output .tex; return the \photoR block.
async function buildPhotoBlock(payload, outDir) {
  let src = typeof payload.photo === 'string' ? payload.photo.trim() : '';
  let found = null;
  if (src) {
    if (existsSync(resolve(src))) found = resolve(src);
  } else {
    // Case-insensitive scan of assets/ for a headshot image (users drop
    // "Headshot.png", "headshot.jpg", etc. — don't fail on capitalization).
    const assetsDir = resolve(__dirname, 'assets');
    if (existsSync(assetsDir)) {
      const { readdirSync } = await import('fs');
      const hit = readdirSync(assetsDir).find(f => /^headshot\.(jpe?g|png)$/i.test(f));
      if (hit) found = join(assetsDir, hit);
    }
  }
  if (!found) return { block: '', photoUsed: null };
  const stem = basename(found, extname(found)).replace(/[^A-Za-z0-9._-]/g, '');
  const destName = stem + extname(found);
  await copyFile(found, join(outDir, destName));
  return { block: `\\photoR{4.4cm}{${stem}}`, photoUsed: found };
}

function buildSubstitutions(payload, photoBlock) {
  // skills: prefer skill_tags; else flatten classic skills[].items into tags.
  let tags = payload.skill_tags;
  if (!tags && Array.isArray(payload.skills)) {
    tags = payload.skills.flatMap(c => {
      if (!c) return [];
      if (Array.isArray(c.items)) return c.items;
      return typeof c.items === 'string' ? c.items.split(',').map(s => s.trim()) : [];
    }).filter(Boolean);
  }
  return {
    NAME: escapeLatex(payload.name || ''),
    TAGLINE: escapeLatex(payload.tagline || ''),
    PHOTO_BLOCK: photoBlock,
    PERSONAL_INFO: buildPersonalInfo(payload.personal),
    SUMMARY: escapeLatex(payload.summary || ''),
    EXPERIENCE: buildExperience(payload.experience),
    PREVIOUS_EXPERIENCE: buildPreviousExperience(payload.previous_experience),
    KEY_ACHIEVEMENTS: buildAchievements(payload.achievements, '\\faGem'),
    SKILLS: buildSkillTags(tags),
    EDUCATION: buildEducation(payload.education),
    CERTIFICATIONS: buildCertifications(payload.certifications),
    LANGUAGES: buildLanguages(payload.languages),
  };
}

async function render(payload, absOutput) {
  const outDir = dirname(absOutput);
  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
  if (!existsSync(TEMPLATE_PATH)) throw new Error(`Template not found: ${TEMPLATE_PATH}`);

  const { block, photoUsed } = await buildPhotoBlock(payload, outDir);
  let template = await readFile(TEMPLATE_PATH, 'utf-8');
  const subs = buildSubstitutions(payload, block);
  for (const [key, value] of Object.entries(subs)) {
    template = template.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  const unresolved = template.match(PLACEHOLDER_RE);
  if (unresolved) throw new Error(`Unresolved placeholders: ${[...new Set(unresolved)].join(', ')}`);

  await writeFile(absOutput, template, 'utf-8');
  const info = await stat(absOutput);
  return {
    file: basename(absOutput),
    path: absOutput,
    sizeKB: parseFloat((info.size / 1024).toFixed(1)),
    photo: photoUsed ? basename(photoUsed) : null,
    counts: {
      experienceEntries: (payload.experience || []).length,
      previousExperience: (payload.previous_experience || []).length,
      achievements: (payload.achievements || []).length,
      certifications: (payload.certifications || []).length,
      languages: (payload.languages || []).length,
      educationEntries: (payload.education || []).length,
    },
    valid: true,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    console.error('Usage:\n  node build-cv-altacv.mjs <input.json> <output.tex>\n  node build-cv-altacv.mjs --test');
    process.exit(1);
  }
  if (args.includes('--test')) { await runSelfTest(); return; }

  const [inputPath, outputPath] = args;
  if (!inputPath || !outputPath) {
    console.error('Usage: node build-cv-altacv.mjs <input.json> <output.tex>');
    process.exit(1);
  }
  const absInput = resolve(inputPath);
  if (!existsSync(absInput)) { console.error(`Input file not found: ${absInput}`); process.exit(1); }

  let payload;
  try { payload = JSON.parse(await readFile(absInput, 'utf-8')); }
  catch (err) { console.error(`Failed to parse input JSON: ${err.message}`); process.exit(1); }

  try {
    const report = await render(payload, resolve(outputPath));
    if (!report.photo) report.warning = 'No photo found (looked for payload.photo or assets/headshot.{jpg,jpeg,png}). Compiled without a photo.';
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

async function runSelfTest() {
  const sample = {
    name: 'Test Candidate',
    tagline: 'Senior Backend Engineer',
    personal: {
      phone: '+41 76 000 00 00', email: 'test@example.com',
      location: 'Zurich, Switzerland', linkedin: 'test-candidate',
      github: 'testcandidate', citizenship: ['Switzerland (C permit)'],
    },
    summary: 'Engineer with a focus on distributed systems & clean architecture (100% uptime).',
    experience: [{
      role: 'Senior Engineer', company: 'ACME AG', company_url: 'https://example.com',
      dates: '2020 - Present', location: 'Zurich, CH',
      bullets: ['Built scalable microservices with Java & Spring Boot', 'Cut deploy time 60%'],
    }],
    achievements: [{ icon: 'faGem', title: 'Refactored core engine', detail: 'Layered architecture' }],
    skill_tags: [['Java', 'Spring Boot', 'Docker'], ['Kubernetes', 'Terraform']],
    education: [{ degree: 'BSc Computer Science', institution: 'Some University', dates: '2014 - 2018', location: '' }],
    certifications: [{ title: 'Oracle Cloud Architect Associate', detail: '' }],
    languages: [{ name: 'English', level: 5 }, { name: 'German', level: 3 }],
    previous_experience: [
      { role: 'Project Manager', company: 'OldCo', dates: '2010 - 2011', location: 'Spain' },
      { role: 'Engineer', company: 'Earlier AG', dates: '2006 - 2010', location: 'Spain' },
    ],
  };
  const testInput = '/tmp/build-cv-altacv-test-input.json';
  const testOutput = '/tmp/build-cv-altacv-test.tex';
  await writeFile(testInput, JSON.stringify(sample, null, 2), 'utf-8');
  try {
    const report = await render(sample, resolve(testOutput));
    console.log(JSON.stringify({ status: 'self-test-passed', ...report }, null, 2));
    const fs = await import('fs/promises');
    await Promise.all([fs.rm(testInput).catch(() => {}), fs.rm(testOutput).catch(() => {})]);
    process.exit(0);
  } catch (err) {
    console.error(`Self-test failed: ${err.message}`);
    process.exit(1);
  }
}

main();
