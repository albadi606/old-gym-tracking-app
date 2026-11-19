import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const workspace = process.cwd();
const sourceRoot = path.join(workspace, 'src');
const TS_EXTENSIONS = ['.ts', '.tsx'];
const RESOLUTION_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.css',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.svg',
  '/index.ts',
  '/index.tsx',
];

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

function isProductionTypeScript(file) {
  const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
  return (
    TS_EXTENSIONS.includes(path.extname(file)) &&
    !relative.startsWith('test/') &&
    !relative.includes('/test/') &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative)
  );
}

function extractRelativeImports(sourceText, fileName = 'fixture.ts') {
  const file = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const imports = [];
  const record = (node, kind) => {
    if (node && ts.isStringLiteralLike(node) && node.text.startsWith('.')) {
      imports.push({ specifier: node.text, kind });
    }
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      record(node.moduleSpecifier, 'static');
    } else if (ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier, 're-export');
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      record(node.arguments[0], 'dynamic');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

function resolveSpecifier(source, rawSpecifier) {
  const specifier = rawSpecifier.split(/[?#]/u, 1)[0];
  const base = path.resolve(path.dirname(source), specifier);
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

function cyclePaths(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node, []]));
  for (const { source, target } of edges) {
    adjacency.get(source)?.push(target);
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = [];

  const visit = (node) => {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      cycles.push([...stack.slice(start), node]);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const target of adjacency.get(node) ?? []) visit(target);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of nodes) visit(node);
  return cycles;
}

function location(file) {
  const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
  const parts = relative.split('/');
  return {
    layer: parts.length > 1 ? parts[0] : 'root',
    feature: parts[0] === 'features' ? parts[1] : undefined,
  };
}

/** Mirrors the durable ESLint dependency direction, including dynamic edges it cannot see. */
function boundaryViolation(source, target) {
  const from = location(source);
  const to = location(target);
  if (from.layer === 'domain') return to.layer !== 'domain';
  if (from.layer === 'db' || from.layer === 'media') {
    return ['app', 'features', 'components', 'i18n', 'shared'].includes(to.layer);
  }
  if (from.layer === 'shared') return ['app', 'features', 'components'].includes(to.layer);
  if (from.layer === 'components') return ['app', 'features'].includes(to.layer);
  if (from.layer === 'features') {
    return to.layer === 'app' || (to.layer === 'features' && from.feature !== to.feature);
  }
  return false;
}

function assertSelfTests() {
  const extracted = extractRelativeImports(
    "import './static.ts'; export { x } from './exported.ts'; void import('./lazy.ts');",
  );
  if (extracted.map((item) => item.kind).join(',') !== 'static,re-export,dynamic') {
    throw new Error('Architecture extractor self-test failed: an import form was omitted');
  }
  const dynamic = extracted.find((item) => item.kind === 'dynamic');
  const nodes = ['a', 'b'];
  const cycleContainingDynamicEdge = dynamic
    ? cyclePaths(nodes, [
        { source: 'a', target: 'b', kind: dynamic.kind },
        { source: 'b', target: 'a', kind: 'static' },
      ])
    : [];
  if (cycleContainingDynamicEdge.length !== 1) {
    throw new Error('Architecture cycle self-test failed');
  }
  const source = path.join(sourceRoot, 'features', 'history', 'fixture.ts');
  const target = path.join(sourceRoot, 'features', 'progress', 'fixture.ts');
  if (!dynamic || !boundaryViolation(source, target)) {
    throw new Error('Architecture boundary self-test failed for a dynamic sibling-feature edge');
  }
}

assertSelfTests();

const files = walk(sourceRoot).filter(isProductionTypeScript).sort();
const fileSet = new Set(files);
const edgesByPair = new Map();
const unresolved = [];

for (const source of files) {
  const text = fs.readFileSync(source, 'utf8');
  for (const imported of extractRelativeImports(text, source)) {
    const target = resolveSpecifier(source, imported.specifier);
    if (!target) {
      unresolved.push(`${path.relative(workspace, source)} -> ${imported.specifier}`);
      continue;
    }
    const key = `${source}\0${target}`;
    const prior = edgesByPair.get(key);
    edgesByPair.set(key, {
      source,
      target,
      kinds: new Set([...(prior?.kinds ?? []), imported.kind]),
    });
  }
}

if (unresolved.length > 0) {
  throw new Error(`Unresolved relative imports:\n${unresolved.join('\n')}`);
}

const edges = [...edgesByPair.values()];
const tsEdges = edges.filter((edge) => fileSet.has(edge.target));
const assetEdges = edges.filter((edge) => !fileSet.has(edge.target));
const dynamicEdges = edges.filter((edge) => edge.kinds.has('dynamic'));
const violations = tsEdges.filter((edge) => boundaryViolation(edge.source, edge.target));
const cycles = cyclePaths(files, tsEdges);

const display = (file) => path.relative(workspace, file).replaceAll('\\', '/');
if (violations.length > 0) {
  throw new Error(
    `Layer violations:\n${violations.map((edge) => `${display(edge.source)} -> ${display(edge.target)}`).join('\n')}`,
  );
}
if (cycles.length > 0) {
  throw new Error(
    `Circular imports:\n${cycles.map((cycle) => cycle.map(display).join(' -> ')).join('\n')}`,
  );
}

const ambient = files.filter((file) => file.endsWith('.d.ts')).length;
process.stdout.write(
  [
    `Architecture check passed: ${String(files.length)} production TypeScript files (${String(files.length - ambient)} excluding ambient declarations).`,
    `${String(tsEdges.length)} TypeScript edges (${String(dynamicEdges.length)} dynamic) + ${String(assetEdges.length)} asset edges = ${String(edges.length)} total.`,
    '0 circular imports; 0 layer-direction violations; 0 sibling-feature violations.',
    'Extractor self-tests cover static imports, re-exports, dynamic imports, cycles, and sibling-feature boundaries.',
  ].join('\n') + '\n',
);
