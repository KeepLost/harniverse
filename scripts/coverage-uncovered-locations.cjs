'use strict';

/**
 * Istanbul coverage reporter printing one clickable `path:line:col` record per
 * uncovered statement, branch path, and function. Vitest's per-file threshold
 * failures name only the file; this reporter supplies the exact locations,
 * printed just above those ERROR lines (reports run before threshold checks).
 * Files at 100% print nothing, so a green run stays silent.
 *
 * Counts below zero are reported separately as corrupt, never as uncovered:
 * `istanbul-lib-coverage` merges branch arrays by index, so two differently
 * shaped instrumentations of one file add counts into mismatched slots and can
 * drive an entry negative while zeroing a sibling. Reporting only exact zeros
 * hid that, presenting a merge defect as an ordinary coverage gap — see the
 * Agent Note on the invariant staging channel.
 *
 * CommonJS by requirement: istanbul-reports loads custom reporters with a bare
 * require() outside the tsx/ESM pipeline (istanbul-reports index.js create()),
 * so this file can be neither TypeScript nor ESM. Wired into vitest.config.ts
 * by absolute path — require() would resolve a relative specifier against
 * istanbul-reports' own directory.
 */

const path = require('node:path');
const { ReportBase } = require('istanbul-lib-report');

/**
 * Editor-convention `line:column` of an istanbul location start (istanbul
 * columns are 0-based; editors and terminal link handlers expect 1-based).
 */
function pos(loc) {
  return `${loc.start.line}:${loc.start.column + 1}`;
}

/** Whether a location carries a usable 1-based start line. */
function usable(loc) {
  return Boolean(loc && loc.start && Number.isFinite(loc.start.line) && loc.start.line >= 1);
}

/**
 * ` (to line:col)` suffix when the range end adds information beyond the
 * start. v8-remapped whole-line statements carry end.column = Infinity; those
 * degrade to a line-only suffix, or to nothing on a single line.
 */
function endSuffix(loc) {
  const end = loc.end;
  if (!end || !Number.isFinite(end.line) || end.line < 1) return '';
  if (!Number.isFinite(end.column)) {
    return end.line === loc.start.line ? '' : ` (to ${end.line})`;
  }
  if (end.line === loc.start.line && end.column === loc.start.column) return '';
  return ` (to ${end.line}:${end.column + 1})`;
}

class UncoveredLocationsReport extends ReportBase {
  constructor(opts = {}) {
    super(opts);
    // Vitest passes the resolved config root alongside reporter options.
    this.projectRoot = opts.projectRoot || process.cwd();
    this.records = [];
  }

  onStart() {
    this.records = [];
    this.corrupt = [];
  }

  onDetail(node) {
    const fc = node.getFileCoverage();
    const rel = path.relative(this.projectRoot, fc.path).split(path.sep).join('/');
    const items = [];
    const corrupt = [];
    const add = (loc, text) => items.push({ line: loc.start.line, column: loc.start.column, text });
    const addCorrupt = (loc, text) => corrupt.push({
      line: usable(loc) ? loc.start.line : 0,
      column: usable(loc) ? loc.start.column : 0,
      text,
    });

    for (const id of Object.keys(fc.statementMap)) {
      const count = fc.s[id];
      const loc = fc.statementMap[id];
      if (!usable(loc)) continue;
      if (count < 0) {
        addCorrupt(loc, `${rel}:${pos(loc)} corrupt statement count ${count}${endSuffix(loc)}`);
        continue;
      }
      if (count !== 0) continue;
      add(loc, `${rel}:${pos(loc)} uncovered statement${endSuffix(loc)}`);
    }

    for (const id of Object.keys(fc.fnMap)) {
      const count = fc.f[id];
      const fn = fc.fnMap[id];
      const loc = usable(fn.decl) ? fn.decl : fn.loc;
      if (!usable(loc)) continue;
      const name = fn.name ? ` ${fn.name}` : '';
      if (count < 0) {
        addCorrupt(loc, `${rel}:${pos(loc)} corrupt function count ${count}${name}`);
        continue;
      }
      if (count !== 0) continue;
      add(loc, `${rel}:${pos(loc)} uncovered function${name}`);
    }

    for (const id of Object.keys(fc.branchMap)) {
      const counts = fc.b[id];
      const branch = fc.branchMap[id];
      for (let i = 0; i < counts.length; i += 1) {
        const count = counts[i];
        if (count > 0) continue;
        // Implicit arms (e.g. a missing else) may carry an empty location;
        // fall back to the branch's own span so the record stays clickable.
        const loc = usable(branch.locations && branch.locations[i]) ? branch.locations[i] : branch.loc;
        if (!usable(loc)) continue;
        const where = `${rel}:${pos(loc)}`;
        const which = `${branch.type}, path ${i + 1}/${counts.length}`;
        if (count < 0) {
          addCorrupt(loc, `${where} corrupt branch count ${count} (${which})`);
          continue;
        }
        add(loc, `${where} uncovered branch (${which})`);
      }
    }

    const order = (a, b) => a.line - b.line || a.column - b.column;
    if (corrupt.length > 0) {
      corrupt.sort(order);
      for (const item of corrupt) this.corrupt.push(item.text);
    }
    if (items.length === 0) return;
    items.sort(order);
    for (const item of items) this.records.push(item.text);
  }

  onEnd() {
    if (this.corrupt.length > 0) {
      console.log(`\nCorrupt coverage counts (below zero, merge defect — NOT a coverage gap): ${this.corrupt.length}`);
      for (const record of this.corrupt) console.log(record);
      console.log(
        'A count below zero means merged coverage for one file came from differently shaped '
        + 'instrumentations; sibling entries zeroed the same way are reported as uncovered but are not. '
        + 'Re-read the file with a single suite before trusting any gap above.',
      );
      console.log('');
    }
    if (this.records.length === 0) return;
    console.log(`\nUncovered locations (per-file 100% gate): ${this.records.length}`);
    for (const record of this.records) console.log(record);
    console.log('');
  }
}

module.exports = UncoveredLocationsReport;
