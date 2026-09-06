// Zero-transitive-dependency gate.
//
//   pnpm ls --prod --depth Infinity --json | node scripts/check-deps.mjs
//
// The rule (5.2): the production tree is exactly `hono` and `zod`, with no transitive
// tree; `@hono/node-server` is allowed but may peer-depend on `hono` and nothing else.

const ALLOWED_DIRECT = new Set(['hono', 'zod']);
const OPTIONAL_ADAPTER = '@hono/node-server';
const ADAPTER_ALLOWED_CHILDREN = new Set(['hono']);

const read = (stream) =>
  new Promise((resolve, reject) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => (text += chunk));
    stream.on('end', () => resolve(text));
    stream.on('error', reject);
  });

const problems = [];

const raw = (await read(process.stdin)).trim();
if (raw === '') {
  console.error('check-deps: no JSON on stdin. Pipe `pnpm ls --prod --depth Infinity --json` into this script.');
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  console.error(`check-deps: stdin is not JSON: ${error.message}`);
  process.exit(1);
}

const projects = Array.isArray(parsed) ? parsed : [parsed];

// `pnpm ls --json` nests each entry's own resolved dependencies under the same
// keys, so the whole tree is reachable by walking them.
const childrenOf = (node) => ({
  ...(node.dependencies ?? {}),
  ...(node.optionalDependencies ?? {}),
});

const describeTree = (name, node, path) => {
  const children = Object.keys(childrenOf(node));
  for (const child of children) {
    problems.push(`${[...path, name, child].join(' > ')}, transitive dependency in the production tree`);
  }
};

for (const project of projects) {
  const direct = childrenOf(project);
  const names = Object.keys(direct).sort();

  for (const name of names) {
    const node = direct[name];

    if (name === OPTIONAL_ADAPTER) {
      const adapterChildren = childrenOf(node);
      for (const child of Object.keys(adapterChildren)) {
        if (!ADAPTER_ALLOWED_CHILDREN.has(child)) {
          problems.push(`${OPTIONAL_ADAPTER} > ${child}, the adapter may depend on hono and nothing else`);
          continue;
        }
        // An allowed child is still held to the same no-transitive-tree rule.
        describeTree(child, adapterChildren[child], [OPTIONAL_ADAPTER]);
      }
      continue;
    }

    if (!ALLOWED_DIRECT.has(name)) {
      problems.push(`${name}, production dependency outside the allowed set (hono, zod, ${OPTIONAL_ADAPTER})`);
      continue;
    }

    describeTree(name, node, []);
  }

  for (const required of ALLOWED_DIRECT) {
    if (!names.includes(required)) {
      problems.push(`${required}, expected production dependency is missing from the tree`);
    }
  }
}

if (problems.length > 0) {
  console.error('check-deps: the production dependency tree broke the zero-transitive-dependency rule.');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('check-deps: ok, production tree is hono + zod (plus the optional Node adapter), with no transitive tree.');
