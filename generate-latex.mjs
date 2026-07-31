#!/usr/bin/env node

/**
 * generate-latex.mjs — Validate and compile a generated .tex CV file to PDF
 *
 * Usage:
 *   node generate-latex.mjs <input.tex> [output.pdf]
 *
 * Reads the .tex file, validates structure, compiles to PDF via tectonic or pdflatex.
 * If output.pdf is omitted, writes to the same directory as input with .pdf extension.
 *
 * Two templates feed this script, and they share no macros, so validation is
 * per-template (see TEMPLATE_PROFILES): the classic single-column
 * templates/cv-template.tex (built by build-cv-latex.mjs) and the two-column
 * AltaCV templates/cv-altacv.tex (built by build-cv-altacv.mjs). The profile is
 * detected from \documentclass — no flag to pass, no way to pick the wrong one.
 *
 * Requires: tectonic (brew install tectonic) or pdflatex (MiKTeX / TeX Live) on PATH.
 */

import { readFile, writeFile, stat, copyFile, rm } from 'fs/promises';
import { resolve, basename, dirname, join } from 'path';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));

// Both templates emit at least 4 top-level sections (Education, Experience,
// Projects/Achievements, Skills). We count section macros rather than match the
// English titles, so a localized CV (e.g. "Educación", "학력") still validates
// instead of failing with a spurious "Missing section".
const MIN_SECTIONS = 4;

const countOf = (content, re) => (content.match(re) || []).length;

/**
 * Per-template validation and compile rules. `detect` runs against the class
 * name from \documentclass; the first profile that claims it wins, and
 * `classic` is the fallback so a hand-written .tex keeps its old behaviour.
 */
const TEMPLATE_PROFILES = {
  classic: {
    label: 'classic (templates/cv-template.tex)',
    sectionRe: /\\section\{/g,
    sectionLabel: '\\section{}',
    requiredCommands: ['\\resumeSubheading', '\\resumeItem', '\\resumeProjectHeading'],
    // pdflatex-only ATS primitive; the classic template ships it (and the
    // tectonic path strips it below, since XeTeX has no such primitive).
    requiresGenToUnicode: true,
    // tectonic first: it auto-downloads missing packages, so it needs no local
    // TeX install to build this template.
    engineOrder: ['tectonic', 'pdflatex'],
    assets: [],
    counts: (c) => ({
      resumeItems: countOf(c, /\\resumeItem\{/g),
      subheadings: countOf(c, /\\resumeSubheading[^C]/g),
      projectHeadings: countOf(c, /\\resumeProjectHeading/g),
    }),
  },
  altacv: {
    label: 'altacv (templates/cv-altacv.tex)',
    sectionRe: /\\cvsection\{/g,
    sectionLabel: '\\cvsection{}',
    // \makecvheader and \cvevent are the two structural macros no real AltaCV CV
    // can omit — a header and at least one experience entry. Achievements, tags
    // and ratings are optional by design, so requiring them would flag valid CVs.
    requiredCommands: ['\\makecvheader', '\\cvevent'],
    // AltaCV has no \pdfgentounicode: the template compiles under XeLaTeX too,
    // where that pdfTeX primitive is undefined and would abort the run.
    requiresGenToUnicode: false,
    // pdflatex first, deliberately: the template's \iftutex branch calls
    // \setmainfont{Lato}, which needs Lato installed as a SYSTEM font. Under
    // tectonic (XeTeX) that fails on any machine without it, while the pdflatex
    // branch uses the bundled Type1 `lato` package and always works.
    engineOrder: ['pdflatex', 'tectonic'],
    // altacv.cls is not in every TeX distribution, and the .tex loads it by
    // name — it has to sit next to the file at compile time.
    assets: ['altacv.cls'],
    counts: (c) => ({
      cvsections: countOf(c, /\\cvsection\{/g),
      events: countOf(c, /\\cvevent\{/g),
      achievements: countOf(c, /\\cvachievement\{/g),
      skillTags: countOf(c, /\\cvtag\{/g),
    }),
  },
};

/** Pick the profile from \documentclass[...]{name}. Unknown class → classic. */
function detectProfile(content) {
  const match = content.match(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*([^}\s]+)\s*\}/);
  const cls = match ? match[1] : '';
  return TEMPLATE_PROFILES[cls] ? cls : 'classic';
}

// CJK (Japanese/Chinese/Korean) ranges: Hiragana, Katakana, CJK ideographs,
// compatibility ideographs, halfwidth katakana, and Hangul. The template is a
// pdfLaTeX/Computer-Modern setup with no CJK font, so these glyphs cannot
// render under pdflatex or tectonic — detect them and fail with guidance
// instead of emitting a broken PDF / cryptic compile log.
const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ가-힯ᄀ-ᇿ]/;

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3]; // optional
  if (!inputPath) {
    console.error('Usage: node generate-latex.mjs <input.tex> [output.pdf]');
    process.exit(1);
  }

  const absPath = resolve(inputPath);
  let content;
  try {
    content = await readFile(absPath, 'utf-8');
  } catch (err) {
    console.error(`Error reading ${absPath}: ${err.message}`);
    process.exit(1);
  }

  const issues = [];

  const profileId = detectProfile(content);
  const profile = TEMPLATE_PROFILES[profileId];

  // Check section count (language-agnostic — see MIN_SECTIONS).
  const sectionCount = (content.match(profile.sectionRe) || []).length;
  if (sectionCount < MIN_SECTIONS) {
    issues.push(`Expected at least ${MIN_SECTIONS} ${profile.sectionLabel} blocks (Education, Work Experience, Projects, Skills — or localized equivalents), found ${sectionCount}`);
  }

  // The template cannot render CJK; fail with guidance instead of a broken PDF.
  if (CJK_RE.test(content)) {
    issues.push('CJK characters detected. The LaTeX template does not support Japanese/Chinese/Korean yet (pdfLaTeX setup with no CJK font). Use `pdf` mode (HTML to PDF, which renders CJK) for these CVs.');
  }

  // Check required commands are used
  for (const cmd of profile.requiredCommands) {
    if (!new RegExp(cmd.replace(/\\/g, '\\\\')).test(content)) {
      issues.push(`Missing command: ${cmd}`);
    }
  }

  // Check document structure
  if (!content.includes('\\begin{document}')) {
    issues.push('Missing \\begin{document}');
  }
  if (!content.includes('\\end{document}')) {
    issues.push('Missing \\end{document}');
  }

  // Check for unresolved placeholders
  const unresolvedMatch = content.match(/\{\{[A-Z_]+\}\}/g);
  if (unresolvedMatch) {
    issues.push(`Unresolved placeholders: ${[...new Set(unresolvedMatch)].join(', ')}`);
  }

  // Check pdfgentounicode (classic only — see requiresGenToUnicode)
  if (profile.requiresGenToUnicode && !content.includes('\\pdfgentounicode=1')) {
    issues.push('Missing \\pdfgentounicode=1 (ATS compatibility)');
  }

  const fileInfo = await stat(absPath);
  const sizeKB = (fileInfo.size / 1024).toFixed(1);

  // Output report as JSON
  const report = {
    file: basename(absPath),
    path: absPath,
    template: profileId,
    sizeKB: parseFloat(sizeKB),
    counts: profile.counts(content),
    issues,
    valid: issues.length === 0,
  };

  // If validation fails, report and exit
  if (issues.length > 0) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // --- Compile .tex → .pdf ---
  const texDir = dirname(absPath);
  const texBase = basename(absPath, '.tex');
  const defaultPdf = join(texDir, `${texBase}.pdf`);
  const targetPdf = outputPath ? resolve(outputPath) : defaultPdf;

  // Ensure output directory exists
  const targetDir = dirname(targetPdf);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Stage template assets (altacv.cls) next to the .tex — the document loads
  // them by name and they are not in every TeX distribution. Left in place
  // afterwards on purpose: an Overleaf upload or a manual recompile needs the
  // .cls sitting beside the .tex, and it costs 18KB in a gitignored dir.
  const stagedAssets = [];
  for (const asset of profile.assets) {
    const dest = join(texDir, asset);
    if (existsSync(dest)) continue;
    const src = join(ROOT, 'templates', asset);
    if (!existsSync(src)) {
      // Not fatal: the class may be installed in the TeX distribution. If it
      // isn't, LaTeX fails below with its own "file not found" error.
      report.assetWarning = `${asset} not found at ${src} and not present next to the .tex — relying on the TeX distribution to provide it`;
      continue;
    }
    await copyFile(src, dest);
    stagedAssets.push(asset);
  }
  if (stagedAssets.length) report.stagedAssets = stagedAssets;

  // Detect available engine. Order is per-template (see engineOrder).
  let engine = null;
  for (const candidate of profile.engineOrder) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'pipe' });
      engine = candidate;
      break;
    } catch { /* not found */ }
  }

  if (!engine) {
    report.compiled = false;
    report.compileError = 'No LaTeX engine found. Install tectonic (brew install tectonic) or pdflatex.';
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  report.engine = engine;

  // For tectonic: strip pdflatex-only primitives that cause crashes
  let compilePath = absPath;
  if (engine === 'tectonic') {
    const patched = content
      .replace(/\\pdfgentounicode\s*=\s*\d+[^\n]*\n?/g, '')
      .replace(/\\input\{glyphtounicode\}[^\n]*\n?/g, '');
    compilePath = join(texDir, `${texBase}._tectonic.tex`);
    await writeFile(compilePath, patched, 'utf-8');
  }

  try {
    if (engine === 'tectonic') {
      // Tectonic handles multi-pass automatically; --outdir sets output location
      execFileSync('tectonic', ['--outdir', texDir, compilePath], {
        cwd: texDir,
        stdio: 'pipe',
        timeout: 120_000,
      });
    } else {
      const pdflatexArgs = [
        '-no-shell-escape',
        '-interaction=nonstopmode',
        '-halt-on-error',
        `-output-directory=${texDir}`,
        absPath,
      ];
      // First pass
      execFileSync('pdflatex', pdflatexArgs, { cwd: texDir, stdio: 'pipe', timeout: 120_000 });
      // Second pass (resolves referenceS))
      execFileSync('pdflatex', pdflatexArgs, { cwd: texDir, stdio: 'pipe', timeout: 120_000 });
    }

    report.compiled = true;
  } catch (err) {
    const logPath = join(texDir, `${texBase}.log`);
    let latexError = err.message;
    try {
      const log = await readFile(logPath, 'utf-8');
      const errorLines = log.split('\n').filter(l => l.startsWith('!'));
      if (errorLines.length > 0) {
        latexError = errorLines.join('\n');
      }
    } catch { /* no log file */ }

    report.compiled = false;
    report.compileError = latexError;
  }

  // Post-compile: move PDF and clean up (separate from compile errors)
  if (report.compiled) {
    // Tectonic outputs PDF named after the patched temp file
    const compileBase = basename(compilePath, '.tex');
    const compiledPdf = join(texDir, `${compileBase}.pdf`);

    try {
      await copyFile(compiledPdf, targetPdf);
      if (resolve(compiledPdf) !== resolve(targetPdf)) {
        await rm(compiledPdf).catch(() => {});
      }

      const pdfStat = await stat(targetPdf);
      report.pdf = {
        path: targetPdf,
        sizeKB: parseFloat((pdfStat.size / 1024).toFixed(1)),
      };
    } catch (err) {
      report.postCompileError = `Failed to finalize PDF: ${err.message}`;
    }

    // Clean up auxiliary files and tectonic temp .tex (best-effort)
    const auxExts = ['.aux', '.log', '.out', '.fls', '.fdb_latexmk', '.synctex.gz'];
    for (const ext of auxExts) {
      await rm(join(texDir, `${compileBase}${ext}`)).catch(() => {});
    }
    if (engine === 'tectonic') {
      await rm(compilePath).catch(() => {});
    }
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.compiled ? 0 : 1);
}

main();
