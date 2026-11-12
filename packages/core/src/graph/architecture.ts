import type { ArchitectureConfig } from '../config/schema.js';
import type {
  ArchitectureModuleRecord,
  ArchitectureViolationRecord,
  DependencyRecord,
} from '../model.js';
import { globToRegExp } from '../discovery/ignore.js';

interface CompiledModule {
  name: string;
  include: string[];
  allow: string[] | null;
  regexes: Array<{ raw: string; regex: RegExp }>;
}

export interface ModuleAssignment {
  moduleByPath: Map<string, string>;
  modules: ArchitectureModuleRecord[];
  warnings: string[];
}

/**
 * Explicit architecture modules (docs/phase-04/00-entry-and-decisions.md 3.2).
 * Longest matching include pattern wins; ties break by module name. Overlaps
 * are reported, never silently resolved by directory name.
 */
export class ArchitectureIndex {
  private readonly compiled: CompiledModule[];
  private readonly warnings = new Set<string>();

  constructor(config: ArchitectureConfig) {
    const names = new Set<string>();
    this.compiled = [];
    for (const module of config.modules) {
      if (names.has(module.name)) {
        this.warnings.add(`architecture module name is duplicated: ${module.name}`);
        continue;
      }
      names.add(module.name);
      this.compiled.push({
        name: module.name,
        include: [...module.include],
        allow: module.allow === undefined ? null : [...module.allow],
        regexes: module.include.map((raw) => ({
          raw,
          regex: globToRegExp(raw.replaceAll('\\', '/')),
        })),
      });
    }
    this.compiled.sort((left, right) => (left.name < right.name ? -1 : 1));
  }

  get hasModules(): boolean {
    return this.compiled.length > 0;
  }

  moduleFor(relativePath: string): string | null {
    const normalized = relativePath.replaceAll('\\', '/');
    let best: { name: string; length: number } | null = null;
    let matches = 0;
    for (const module of this.compiled) {
      let matched = false;
      let matchedLength = 0;
      for (const entry of module.regexes) {
        if (!entry.regex.test(normalized)) continue;
        matched = true;
        if (entry.raw.length > matchedLength) matchedLength = entry.raw.length;
      }
      if (!matched) continue;
      matches += 1;
      if (
        best === null ||
        matchedLength > best.length ||
        (matchedLength === best.length && module.name < best.name)
      ) {
        best = { name: module.name, length: matchedLength };
      }
    }
    if (matches > 1) {
      this.warnings.add(
        `architecture module overlap for ${normalized}: ${matches} modules match; longest pattern wins`,
      );
    }
    return best?.name ?? null;
  }

  allowOf(moduleName: string): string[] | null {
    return this.compiled.find((module) => module.name === moduleName)?.allow ?? null;
  }

  assign(
    files: ReadonlyArray<{ path: string }>,
    symbolCountByPath: ReadonlyMap<string, number>,
  ): ModuleAssignment {
    const moduleByPath = new Map<string, string>();
    const counts = new Map<string, { files: number; symbols: number }>();
    for (const module of this.compiled) counts.set(module.name, { files: 0, symbols: 0 });
    for (const file of files) {
      const moduleName = this.moduleFor(file.path);
      if (moduleName === null) continue;
      moduleByPath.set(file.path, moduleName);
      const count = counts.get(moduleName);
      if (count === undefined) continue;
      count.files += 1;
      count.symbols += symbolCountByPath.get(file.path) ?? 0;
    }
    const modules: ArchitectureModuleRecord[] = this.compiled.map((module) => {
      const count = counts.get(module.name) ?? { files: 0, symbols: 0 };
      return {
        name: module.name,
        include: [...module.include],
        allow: module.allow === null ? null : [...module.allow],
        fileCount: count.files,
        symbolCount: count.symbols,
      };
    });
    return {
      moduleByPath,
      modules,
      warnings: [...this.warnings].sort(),
    };
  }

  evaluateViolations(
    dependencies: readonly DependencyRecord[],
    moduleByPath: ReadonlyMap<string, string>,
  ): ArchitectureViolationRecord[] {
    const violations: ArchitectureViolationRecord[] = [];
    for (const dependency of dependencies) {
      if (dependency.targetFile === null) continue;
      const fromModule =
        moduleByPath.get(dependency.sourceFile) ?? this.moduleFor(dependency.sourceFile);
      const toModule =
        moduleByPath.get(dependency.targetFile) ?? this.moduleFor(dependency.targetFile);
      if (
        fromModule === null ||
        toModule === null ||
        fromModule === undefined ||
        toModule === undefined
      )
        continue;
      if (fromModule === toModule) continue;
      const allow = this.allowOf(fromModule);
      if (allow === null) continue;
      if (allow.includes(toModule)) continue;
      violations.push({
        ruleId: `arch/${fromModule}->${toModule}`,
        fromModule,
        toModule,
        sourceFile: dependency.sourceFile,
        targetFile: dependency.targetFile,
        line: dependency.line,
        col: dependency.col,
        depType: dependency.depType,
        relationClass: dependency.relationClass,
        confidence: dependency.confidence,
        analysisEngine: dependency.analysisEngine,
        evidence: {
          ...dependency.evidence,
          sourceOfTruth: 'architecture-allow',
          constraints: [...dependency.evidence.constraints, `allow=${JSON.stringify(allow)}`],
        },
      });
    }
    violations.sort((left, right) => {
      if (left.ruleId !== right.ruleId) return left.ruleId < right.ruleId ? -1 : 1;
      if (left.sourceFile !== right.sourceFile) return left.sourceFile < right.sourceFile ? -1 : 1;
      return left.line - right.line || left.col - right.col;
    });
    return violations;
  }
}
