import path from 'node:path';
import ts from 'typescript';

import { isInside } from '../util/paths.js';

export interface ExportTag {
  name: string;
  text: string;
}

export interface ResolvedExport {
  exportName: string;
  /** Root-relative POSIX declaration path. */
  declarationPath: string;
  declarationName: string;
  nameLine: number;
  nameCol: number;
  derived: boolean;
  /** `export type { X }` / `export { type X }` makes the surface entry type-only. */
  exportTypeOnly: boolean;
  jsDocTags: ExportTag[];
}

export interface OpaqueExport {
  name: string;
  reason: string;
}

export interface EntryExports {
  exports: ResolvedExport[];
  opaque: OpaqueExport[];
  warning: string | null;
}

function tagText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part !== null && 'text' in part) {
          return typeof part.text === 'string' ? part.text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

function symbolTags(symbol: ts.Symbol): ExportTag[] {
  let tags: readonly ts.JSDocTagInfo[];
  try {
    tags = symbol.getJsDocTags();
  } catch {
    return [];
  }
  return tags.map((tag) => ({ name: tag.name, text: tagText(tag.text) }));
}

function nameNodeOf(declaration: ts.Declaration): ts.Node | null {
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isModuleDeclaration(declaration) ||
    ts.isVariableDeclaration(declaration) ||
    ts.isBindingElement(declaration)
  ) {
    return declaration.name ?? null;
  }
  if (ts.isImportSpecifier(declaration) || ts.isExportSpecifier(declaration)) {
    return declaration.name;
  }
  return null;
}

/**
 * Resolve the exports of one entry file with the TypeScript checker, which
 * already understands barrels, aliases, `export *`, `export type` and default
 * re-exports. The builder matches the resulting declaration positions to the
 * indexed `symbolId`; it never guesses by name alone.
 */
export class ExportResolver {
  private readonly checker: ts.TypeChecker;

  constructor(
    private readonly program: ts.Program,
    private readonly rootAbs: string,
  ) {
    this.checker = program.getTypeChecker();
  }

  resolveEntry(entryRelativePath: string): EntryExports {
    const absolute = path.resolve(this.rootAbs, entryRelativePath);
    const sourceFile = this.program.getSourceFile(absolute);
    if (sourceFile === undefined) {
      return {
        exports: [],
        opaque: [],
        warning: `entry file is not in the program: ${entryRelativePath}`,
      };
    }
    let moduleSymbol: ts.Symbol | undefined;
    try {
      moduleSymbol = this.checker.getSymbolAtLocation(sourceFile);
    } catch (error) {
      return {
        exports: [],
        opaque: [],
        warning: `cannot read module symbol for ${entryRelativePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (moduleSymbol === undefined) {
      return { exports: [], opaque: [], warning: null };
    }
    let exported: ts.Symbol[];
    try {
      exported = this.checker.getExportsOfModule(moduleSymbol);
    } catch (error) {
      return {
        exports: [],
        opaque: [],
        warning: `cannot enumerate exports for ${entryRelativePath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const output: ResolvedExport[] = [];
    const opaque: OpaqueExport[] = [];
    const seen = new Set<string>();
    for (const exportSymbol of exported) {
      const exportName = exportSymbol.getName();
      const exportTypeOnly = this.isTypeOnlyExport(exportSymbol);
      const target = this.aliased(exportSymbol);
      const tags = symbolTags(target);
      const declarations = (target.declarations ?? []).filter((declaration) =>
        isInside(this.rootAbs, declaration.getSourceFile().fileName),
      );
      if (declarations.length === 0) {
        const external =
          target.declarations !== undefined && target.declarations.length > 0
            ? 'external-export'
            : (target.flags & ts.SymbolFlags.ValueModule) !== 0
              ? 'namespace-export'
              : 'no-declaration';
        opaque.push({ name: exportName, reason: external });
        continue;
      }
      for (const declaration of declarations) {
        const sourceFileOfDeclaration = declaration.getSourceFile();
        const nameNode = nameNodeOf(declaration);
        if (nameNode === null) {
          opaque.push({ name: exportName, reason: 'anonymous-declaration' });
          continue;
        }
        const position = sourceFileOfDeclaration.getLineAndCharacterOfPosition(
          nameNode.getStart(sourceFileOfDeclaration),
        );
        const declarationPath = path
          .relative(this.rootAbs, sourceFileOfDeclaration.fileName)
          .replaceAll('\\', '/');
        const key = `${exportName}\u0000${declarationPath}\u0000${position.line}\u0000${position.character}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push({
          exportName,
          declarationPath,
          declarationName: target.getName(),
          nameLine: position.line + 1,
          nameCol: position.character,
          derived: declarationPath !== entryRelativePath,
          exportTypeOnly,
          jsDocTags: tags,
        });
      }
    }
    output.sort((left, right) => {
      if (left.exportName !== right.exportName) return left.exportName < right.exportName ? -1 : 1;
      if (left.declarationPath !== right.declarationPath) {
        return left.declarationPath < right.declarationPath ? -1 : 1;
      }
      if (left.nameLine !== right.nameLine) return left.nameLine - right.nameLine;
      return left.nameCol - right.nameCol;
    });
    opaque.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return { exports: output, opaque, warning: null };
  }

  private isTypeOnlyExport(symbol: ts.Symbol): boolean {
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isExportSpecifier(declaration)) {
        if (declaration.isTypeOnly) return true;
        const named = declaration.parent;
        const declarationNode = named.parent;
        if (ts.isExportDeclaration(declarationNode) && declarationNode.isTypeOnly) return true;
      }
    }
    return false;
  }

  private aliased(symbol: ts.Symbol): ts.Symbol {
    let current = symbol;
    const seen = new Set<ts.Symbol>();
    while ((current.flags & ts.SymbolFlags.Alias) !== 0) {
      if (seen.has(current)) break;
      seen.add(current);
      try {
        const next = this.checker.getAliasedSymbol(current);
        if (next === current) break;
        current = next;
      } catch {
        break;
      }
    }
    return current;
  }
}
