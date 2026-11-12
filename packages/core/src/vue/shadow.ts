import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { toPosix } from '../util/paths.js';
import type { VueProjection } from './project.js';

export interface ShadowProject {
  /** Absolute shadow root (`.nexus/tmp/vue/<token>`). */
  shadowRoot: string;
  /** Shadow prefix as a document path relative to the root being indexed. */
  documentPrefix: string;
  tsconfigPath: string;
  /** Project-relative `.vue` path -> absolute shadow `.vue.ts`. */
  shadowAbsoluteByProjectPath: Map<string, string>;
  /** Project-relative `.vue` path -> SCIP document path (relative to root cwd). */
  shadowDocPathByProjectPath: Map<string, string>;
  shadowFiles: string[];
  cleanup: () => void;
}

export interface WriteShadowOptions {
  projectRoot: string;
  rootAbsolutePath: string;
  tmpToken: string;
  projections: readonly VueProjection[];
  tsconfigFileNames: readonly string[];
  compilerOptions: ts.CompilerOptions;
}

const INHERITED_OPTIONS = [
  'target',
  'module',
  'moduleResolution',
  'jsx',
  'lib',
  'strict',
  'noImplicitAny',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'noImplicitThis',
  'alwaysStrict',
  'baseUrl',
  'paths',
  'types',
  'typeRoots',
  'esModuleInterop',
  'allowSyntheticDefaultImports',
  'resolveJsonModule',
  'isolatedModules',
  'verbatimModuleSyntax',
  'moduleDetection',
  'skipLibCheck',
  'useDefineForClassFields',
  'experimentalDecorators',
  'emitDecoratorMetadata',
  'downlevelIteration',
  'importHelpers',
  'allowJs',
  'checkJs',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'noImplicitOverride',
  'preserveConstEnums',
  'allowImportingTsExtensions',
  'customConditions',
] as const;

/** Serializes the semantically relevant part of the real tsconfig for SCIP. */
export function shadowCompilerOptions(
  options: ts.CompilerOptions,
  rootAbsolutePath: string,
  shadowRoot: string,
): Record<string, unknown> {
  const source = options as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of INHERITED_OPTIONS) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    output[key] = value;
  }
  // ts.parseJsonConfigFileContent returns numeric enum values; a tsconfig file
  // requires names (e.g. "ES2022" instead of 9).
  for (const [key, enumObject] of [
    ['target', ts.ScriptTarget],
    ['module', ts.ModuleKind],
    ['moduleResolution', ts.ModuleResolutionKind],
    ['jsx', ts.JsxEmit],
    ['moduleDetection', ts.ModuleDetectionKind],
  ] as const) {
    const value = output[key];
    if (typeof value === 'number') {
      const name = (enumObject as Record<number, string>)[value];
      if (name !== undefined) output[key] = name;
    }
  }
  if (output.baseUrl === undefined && output.paths !== undefined) {
    output.baseUrl = rootAbsolutePath;
  }
  output.allowArbitraryExtensions = true;
  output.noEmit = true;
  output.skipLibCheck = true;
  const rootDirs = [
    shadowRoot,
    rootAbsolutePath,
    ...(Array.isArray(options.rootDirs) ? options.rootDirs : []),
  ];
  output.rootDirs = [...new Set(rootDirs.map((entry) => path.resolve(entry)))];
  delete output.declaration;
  delete output.declarationMap;
  delete output.composite;
  delete output.incremental;
  delete output.tsBuildInfoFile;
  return output;
}

/**
 * Materializes the shadow tree for one root (docs/04-architecture.md 4.1.1).
 * The directory lives under `.nexus/tmp/vue/<token>` and is deleted by the
 * caller on every path.
 */
export function writeShadowProject(options: WriteShadowOptions): ShadowProject {
  const shadowRoot = path.join(options.projectRoot, '.nexus', 'tmp', 'vue', options.tmpToken);
  fs.rmSync(shadowRoot, { recursive: true, force: true });
  fs.mkdirSync(shadowRoot, { recursive: true });
  const shadowAbsoluteByProjectPath = new Map<string, string>();
  const shadowDocPathByProjectPath = new Map<string, string>();
  const shadowFiles: string[] = [];

  for (const projection of options.projections) {
    const implementation = path.join(shadowRoot, `${projection.rootRelativePath}.ts`);
    const shim = path.join(shadowRoot, projection.rootRelativePath.replace(/\.vue$/, '.d.vue.ts'));
    fs.mkdirSync(path.dirname(implementation), { recursive: true });
    fs.writeFileSync(implementation, projection.generated, 'utf8');
    const implementationName = path.basename(implementation);
    fs.writeFileSync(
      shim,
      `export * from './${implementationName}';\nexport { default } from './${implementationName}';\n`,
      'utf8',
    );
    shadowFiles.push(implementation, shim);
    shadowAbsoluteByProjectPath.set(projection.path, implementation);
    shadowDocPathByProjectPath.set(
      projection.path,
      toPosix(path.relative(options.rootAbsolutePath, implementation)),
    );
  }

  const files = [
    ...options.tsconfigFileNames
      .filter((fileName) => !fileName.toLowerCase().endsWith('.vue'))
      .map((fileName) => path.resolve(fileName)),
    ...shadowFiles,
  ];
  const tsconfigPath = path.join(shadowRoot, 'tsconfig.json');
  const compilerOptions = shadowCompilerOptions(
    options.compilerOptions,
    options.rootAbsolutePath,
    shadowRoot,
  );
  fs.writeFileSync(
    tsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions,
        files: [...new Set(files)].map((fileName) => toPosix(fileName)),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return {
    shadowRoot,
    documentPrefix: toPosix(path.relative(options.rootAbsolutePath, shadowRoot)),
    tsconfigPath,
    shadowAbsoluteByProjectPath,
    shadowDocPathByProjectPath,
    shadowFiles,
    cleanup: () => {
      try {
        fs.rmSync(shadowRoot, { recursive: true, force: true });
      } catch {
        // tmp is disposable; doctor reports leftovers
      }
    },
  };
}
