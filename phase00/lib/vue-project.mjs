import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createVueLanguagePlugin, getDefaultCompilerOptions } from '@vue/language-core';

const GENERATED_PREFIX = '__VLS_';
const MACROS = new Set([
  'defineProps',
  'defineEmits',
  'defineSlots',
  'defineExpose',
  'defineModel',
  'withDefaults',
]);

function walkFiles(dir, predicate) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'expected') continue;
      out.push(...walkFiles(full, predicate));
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function findEmbeddedCode(code, id) {
  if (code.id === id) return code;
  for (const child of code.embeddedCodes ?? []) {
    const found = findEmbeddedCode(child, id);
    if (found) return found;
  }
  return undefined;
}

function buildGeneratedToSource(code) {
  const segments = [];
  for (const mapping of code.mappings) {
    const count = mapping.generatedOffsets.length;
    for (let i = 0; i < count; i += 1) {
      const generated = mapping.generatedOffsets[i];
      const source = mapping.sourceOffsets[i] ?? mapping.sourceOffsets[0];
      const length = mapping.lengths[i] ?? 0;
      if (typeof generated === 'number' && typeof source === 'number' && length > 0) {
        segments.push({ generated, source, length });
      }
    }
  }
  segments.sort((a, b) => a.generated - b.generated);
  return (generatedOffset) => {
    for (const segment of segments) {
      if (
        generatedOffset >= segment.generated &&
        generatedOffset < segment.generated + segment.length
      ) {
        return segment.source + (generatedOffset - segment.generated);
      }
    }
    return undefined;
  };
}

export function createVueProject(root) {
  const compilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    allowArbitraryExtensions: true,
    jsx: ts.JsxEmit.Preserve,
    moduleDetection: ts.ModuleDetectionKind.Force,
    noEmit: true,
  };
  const vueCompilerOptions = getDefaultCompilerOptions();
  const plugin = createVueLanguagePlugin(ts, compilerOptions, vueCompilerOptions, (id) => id);

  const vueFiles = walkFiles(root, (f) => f.endsWith('.vue'));
  const virtuals = new Map();
  for (const vueFile of vueFiles) {
    const absolute = path.resolve(vueFile);
    const sourceText = fs.readFileSync(absolute, 'utf8');
    const snapshot = ts.ScriptSnapshot.fromString(sourceText);
    const virtualCode = plugin.createVirtualCode(absolute, 'vue', snapshot, {
      getAssociatedScript: () => undefined,
    });
    if (!virtualCode) throw new Error(`no virtual code for ${vueFile}`);
    const script = findEmbeddedCode(virtualCode, 'script_ts');
    if (!script) throw new Error(`no script_ts for ${vueFile}`);
    const text = script.snapshot.getText(0, script.snapshot.getLength());
    const virtualFileName = absolute + '.ts';
    virtuals.set(path.resolve(virtualFileName), {
      vueFile: absolute,
      rel: path.relative(root, absolute).split(path.sep).join('/'),
      virtualFileName,
      text,
      code: script,
      sourceText,
      toSource: buildGeneratedToSource(script),
    });
  }

  const host = ts.createCompilerHost(compilerOptions);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const virtual = virtuals.get(path.resolve(fileName));
    if (virtual) {
      return ts.createSourceFile(fileName, virtual.text, languageVersion, true, ts.ScriptKind.TS);
    }
    return baseGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => virtuals.has(path.resolve(fileName)) || baseFileExists(fileName);
  host.readFile = (fileName) =>
    virtuals.get(path.resolve(fileName))?.text ?? baseReadFile(fileName);
  host.writeFile = () => {};
  host.getCurrentDirectory = () => root;
  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((name) => {
      if (name.endsWith('.vue')) {
        const candidate = path.resolve(path.dirname(containingFile), name) + '.ts';
        if (virtuals.has(candidate)) {
          return {
            resolvedFileName: candidate,
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          };
        }
      }
      return ts.resolveModuleName(name, containingFile, compilerOptions, host).resolvedModule;
    });

  const tsFiles = walkFiles(root, (f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  const rootNames = [...virtuals.keys(), ...tsFiles.map((f) => path.resolve(f))];
  const program = ts.createProgram(rootNames, compilerOptions, host);
  const checker = program.getTypeChecker();

  return { root, program, checker, virtuals, compilerOptions };
}

export function lineColOf(sourceText, offset) {
  const before = sourceText.slice(0, offset);
  const lines = before.split('\n');
  return { line: lines.length, col: lines.at(-1)?.length ?? 0 };
}

export function collectVueUserSymbols(project) {
  const symbolsByFile = {};
  const unmapped = [];
  for (const virtual of project.virtuals.values()) {
    const sf = project.program.getSourceFile(virtual.virtualFileName);
    if (!sf) throw new Error(`virtual source missing: ${virtual.virtualFileName}`);
    const names = [];
    const record = (nameNode) => {
      const name = nameNode.getText(sf);
      if (name.startsWith(GENERATED_PREFIX) || MACROS.has(name)) return;
      const generatedOffset = nameNode.getStart(sf);
      const sourceOffset = virtual.toSource(generatedOffset);
      if (sourceOffset === undefined) {
        unmapped.push({ file: virtual.rel, name, reason: 'no-source-mapping' });
        return;
      }
      const pos = lineColOf(virtual.sourceText, sourceOffset);
      names.push({ name, line: pos.line, col: pos.col });
    };

    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text.endsWith('.vue')) {
        const clause = statement.importClause;
        if (clause?.name) record(clause.name);
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) record(element.name);
        }
      } else if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) record(decl.name);
        }
      } else if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name
      ) {
        record(statement.name);
      }
    }
    symbolsByFile[virtual.rel] = names;
  }
  return { symbolsByFile, unmapped };
}

export function collectTemplateRanges(sourceText, descriptor) {
  const ast = descriptor.template?.ast;
  if (!ast) return [];
  const ranges = [];

  const visit = (node, inSlotContent) => {
    if (!node) return;
    if (node.type === 1) {
      const isSlotTemplate =
        node.tagType === 3 && node.props?.some((p) => p.type === 7 && p.name === 'slot');
      const childInSlot = inSlotContent || Boolean(isSlotTemplate);
      if (node.tagType === 1) {
        const start = node.loc.start.offset + 1;
        ranges.push({
          kind: 'component-use',
          start,
          end: start + node.tag.length,
          tag: node.tag,
          inSlotContent,
        });
        const elementText = node.loc.source;
        const closeIndex = elementText.lastIndexOf('</');
        if (closeIndex >= 0) {
          const closeStart = node.loc.start.offset + closeIndex + 2;
          ranges.push({
            kind: 'component-use-close',
            start: closeStart,
            end: closeStart + node.tag.length,
            tag: node.tag,
            inSlotContent,
          });
        }
      }
      for (const prop of node.props ?? []) {
        if (prop.type !== 7 || !prop.exp?.loc) continue;
        const kind =
          prop.name === 'on'
            ? 'event-binding'
            : prop.name === 'bind'
              ? 'prop-binding'
              : prop.name === 'if'
                ? 'directive-binding'
                : 'directive-binding';
        ranges.push({
          kind,
          start: prop.exp.loc.start.offset,
          end: prop.exp.loc.end.offset,
          text: prop.exp.content,
          inSlotContent: childInSlot,
        });
      }
      for (const child of node.children ?? []) visit(child, childInSlot);
      return;
    }
    if (node.type === 5) {
      ranges.push({
        kind: 'interpolation',
        start: node.content.loc.start.offset,
        end: node.content.loc.end.offset,
        text: node.content.content,
        inSlotContent,
      });
      return;
    }
    for (const child of node.children ?? []) visit(child, inSlotContent);
  };

  visit(ast, false);
  return ranges;
}

export function findRangeAt(ranges, offset) {
  return ranges.find((r) => offset >= r.start && offset < r.end);
}
