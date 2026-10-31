// Core span-tree reconstruction logic.
//
// A "span" is a flat record describing one unit of work in a trace. Spans
// reference their parent by id. The input order is arbitrary and the parent
// may appear before or after its children, so we cannot build the tree in a
// single streaming pass without buffering. We therefore do two passes: index
// every span by id, then attach each span to its parent.
//
// Design decision: a span whose `parentId` is missing from the input set is
// treated as a root. Real trace exports frequently drop the root span (for
// example when filtering by service), and rejecting the whole batch because
// one parent is absent would make the library useless for partial exports.
// We record such spans in the returned `orphans` list so callers can tell the
// difference between a genuine root and a dangling reference.

/**
 * Thrown for structurally invalid input: duplicate ids, missing ids, cycles.
 * We use a dedicated class so callers can distinguish input problems from
 * programming errors with `instanceof`.
 */
export class SpanTreeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpanTreeError';
  }
}

/**
 * Validate a single raw span record and return a normalised copy.
 *
 * We copy rather than mutate because callers frequently keep the original
 * flat array around for other analyses, and silently adding `children` to
 * their objects would be a surprising side effect.
 *
 * @param {object} raw
 * @returns {{id: string, parentId: string|null, name: string, startTime: number, duration: number, children: object[], data: object}}
 */
function normaliseSpan(raw) {
  if (raw === null || typeof raw !== 'object') {
    throw new SpanTreeError('span must be an object');
  }
  const { id, parentId, name, startTime, duration, ...rest } = raw;
  if (typeof id !== 'string' || id.length === 0) {
    throw new SpanTreeError('span id must be a non-empty string');
  }
  if (parentId !== undefined && parentId !== null && typeof parentId !== 'string') {
    throw new SpanTreeError(`span ${id} has a non-string parentId`);
  }
  if (name !== undefined && typeof name !== 'string') {
    throw new SpanTreeError(`span ${id} has a non-string name`);
  }
  if (startTime !== undefined && typeof startTime !== 'number') {
    throw new SpanTreeError(`span ${id} has a non-number startTime`);
  }
  if (duration !== undefined && typeof duration !== 'number') {
    throw new SpanTreeError(`span ${id} has a non-number duration`);
  }
  return {
    id,
    parentId: parentId === undefined ? null : parentId,
    name: name === undefined ? id : name,
    startTime: startTime === undefined ? 0 : startTime,
    duration: duration === undefined ? 0 : duration,
    children: [],
    data: rest,
  };
}

/**
 * Reconstruct a forest of span trees from flat span records.
 *
 * @param {Array<object>} spans flat span records
 * @returns {{roots: object[], orphans: object[], byId: Map<string, object>}}
 *   `roots` are spans with no parent (or a parent missing from the input),
 *   `orphans` is the subset of roots whose declared parent was not present,
 *   `byId` maps every input id to its normalised node.
 */
export function buildSpanTree(spans) {
  if (!Array.isArray(spans)) {
    throw new SpanTreeError('spans must be an array');
  }
  const byId = new Map();
  const normalised = [];
  for (const raw of spans) {
    const node = normaliseSpan(raw);
    if (byId.has(node.id)) {
      throw new SpanTreeError(`duplicate span id: ${node.id}`);
    }
    byId.set(node.id, node);
    normalised.push(node);
  }

  const roots = [];
  const orphans = [];
  for (const node of normalised) {
    if (node.parentId === null) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(node.parentId);
    if (parent === undefined) {
      // Dangling parent reference: keep the node reachable as a root, but
      // flag it so callers can surface data-quality warnings.
      roots.push(node);
      orphans.push(node);
      continue;
    }
    if (parent === node) {
      throw new SpanTreeError(`span ${node.id} is its own parent`);
    }
    parent.children.push(node);
  }

  const cycle = findCycle(byId);
  if (cycle !== null) {
    throw new SpanTreeError(`cycle detected involving span ${cycle}`);
  }

  return { roots, orphans, byId };
}

/**
 * Depth-first cycle detection over the parent links.
 *
 * A cycle in the input cannot be attached into a tree at all, and would make
 * every downstream traversal hang, so we fail loudly at construction time
 * instead of leaving a landmine. We walk parent links (rather than the
 * assembled `children` arrays) because a cycle never produces a root, so it
 * would otherwise be invisible to a traversal that starts from the roots.
 *
 * @param {Map<string, object>} byId
 * @returns {string|null} the id of a span on a cycle, or null if none
 */
function findCycle(byId) {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map();
  for (const id of byId.keys()) {
    colour.set(id, WHITE);
  }
  for (const startId of byId.keys()) {
    if (colour.get(startId) !== WHITE) {
      continue;
    }
    // Walk the parent chain from `startId`, colouring nodes GREY as we go.
    // Reaching a GREY node means we have closed a loop; reaching a node that
    // is already BLACK means this chain merges into an acyclic region.
    const chain = [];
    let currentId = startId;
    while (currentId !== null && currentId !== undefined) {
      const state = colour.get(currentId);
      if (state === GREY) {
        return currentId;
      }
      if (state === BLACK) {
        break;
      }
      colour.set(currentId, GREY);
      chain.push(currentId);
      const node = byId.get(currentId);
      currentId = node === undefined ? null : node.parentId;
    }
    for (const id of chain) {
      colour.set(id, BLACK);
    }
  }
  return null;
}

/**
 * Depth-first flattening of a forest back into a flat array of nodes.
 *
 * Useful for round-tripping and for tests. The order is pre-order: a parent
 * appears before its children, and siblings keep insertion order.
 *
 * @param {Array<object>} roots
 * @returns {object[]}
 */
export function flattenTree(roots) {
  if (!Array.isArray(roots)) {
    throw new SpanTreeError('roots must be an array');
  }
  const out = [];
  const stack = [];
  // Push in reverse so the first sibling is visited first; this mirrors the
  // recursive definition without risking a stack overflow on deep traces.
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    stack.push(roots[i]);
  }
  while (stack.length > 0) {
    const node = stack.pop();
    out.push(node);
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      stack.push(node.children[i]);
    }
  }
  return out;
}

/**
 * Look up a node by id in a tree result.
 *
 * @param {{byId: Map<string, object>}} tree result of buildSpanTree
 * @param {string} id
 * @returns {object|null}
 */
export function findSpan(tree, id) {
  if (tree === null || typeof tree !== 'object' || !(tree.byId instanceof Map)) {
    throw new SpanTreeError('findSpan expects a tree result from buildSpanTree');
  }
  if (typeof id !== 'string') {
    throw new SpanTreeError('id must be a string');
  }
  const node = tree.byId.get(id);
  return node === undefined ? null : node;
}

/**
 * Return the ancestor chain from a root down to the given span, inclusive.
 *
 * The chain is built by walking parentId links upward and then reversing, so
 * it works even for orphans (the chain simply starts at the orphan).
 *
 * @param {{byId: Map<string, object>}} tree
 * @param {string} id
 * @returns {object[]|null} null when the id is unknown
 */
export function getPathToSpan(tree, id) {
  if (tree === null || typeof tree !== 'object' || !(tree.byId instanceof Map)) {
    throw new SpanTreeError('getPathToSpan expects a tree result from buildSpanTree');
  }
  const node = tree.byId.get(id);
  if (node === undefined) {
    return null;
  }
  const path = [];
  let current = node;
  while (current !== null && current !== undefined) {
    path.push(current);
    if (current.parentId === null) {
      break;
    }
    current = tree.byId.get(current.parentId);
  }
  path.reverse();
  return path;
}
