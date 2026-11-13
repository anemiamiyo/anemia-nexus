import fs from 'node:fs';
import path from 'node:path';

import { IgnoreMatcher } from '../discovery/ignore.js';
import type { IgnoreConfig } from '../config/schema.js';

/**
 * Bounded, read-only documentation lookup for impact/preflight
 * (docs/10-impact-analysis.md "相关文档"). v1 does not index markdown; this is
 * a best-effort text match whose search range is always reported.
 */
export interface DocMatch {
  path: string;
  line: number;
  match: string;
  term: string;
}

export interface DocSearchResult {
  matches: DocMatch[];
  searchedFiles: number;
  truncated: boolean;
  note: string;
}

const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_MATCHES = 50;

function listMarkdown(projectRoot: string, ignore: IgnoreMatcher): string[] {
  const output: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0 && output.length < MAX_FILES) {
    const relativeDir = stack.pop() as string;
    const absoluteDir = path.join(projectRoot, relativeDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!ignore.isDirectoryIgnored(relativePath)) stack.push(relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      if (ignore.isFileIgnored(relativePath)) continue;
      output.push(relativePath);
      if (output.length >= MAX_FILES) break;
    }
  }
  return output.sort();
}

export function findRelatedDocs(input: {
  projectRoot: string;
  ignore: IgnoreConfig;
  terms: readonly string[];
}): DocSearchResult {
  const terms = [
    ...new Set(input.terms.map((term) => term.trim()).filter((term) => term.length >= 3)),
  ]
    .map((term) => term.toLowerCase())
    .sort();
  if (terms.length === 0) {
    return {
      matches: [],
      searchedFiles: 0,
      truncated: false,
      note: 'no searchable term (target name/path is too short)',
    };
  }
  const ignore = new IgnoreMatcher(input.ignore);
  const files = listMarkdown(input.projectRoot, ignore);
  const matches: DocMatch[] = [];
  let truncated = false;
  for (const relativePath of files) {
    const absolute = path.join(input.projectRoot, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;
    let text: string;
    try {
      text = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const lower = line.toLowerCase();
      const term = terms.find((candidate) => lower.includes(candidate));
      if (term === undefined) continue;
      matches.push({ path: relativePath, line: index + 1, match: line.trim(), term });
      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  return {
    matches,
    searchedFiles: files.length,
    truncated,
    note: `searched ${files.length} markdown files under the project root (bounded to ${MAX_FILES} files / ${MAX_FILE_BYTES} bytes each); documentation is not indexed`,
  };
}
