# trace-span-tree-builder

Reconstructs a hierarchical span tree from flat span records that reference
their parent by id, for trace analysis.

```js
import { buildSpanTree, flattenTree, getPathToSpan } from 'trace-span-tree-builder';

const spans = [
  { id: 'root', parentId: null, name: 'request' },
  { id: 'db', parentId: 'root', name: 'query', service: 'postgres' },
  { id: 'http', parentId: 'root', name: 'call', service: 'payments' },
];

const tree = buildSpanTree(spans);

tree.roots[0].id;                 // 'root'
tree.roots[0].children.length;    // 2
flattenTree(tree.roots).map(s => s.id); // ['root', 'db', 'http']
getPathToSpan(tree, 'db').map(s => s.id); // ['root', 'db']
```

## Why this exists

Trace exporters hand you a flat list of spans in whatever order the backend
returns them. Rebuilding the tree means indexing every span by id and then
linking children to parents, which is easy to get subtly wrong: children can
arrive before their parents, ids can repeat, and a parent can be missing
entirely. This library does that one job and reports the structural problems it
finds instead of guessing.

The trade-off: a span whose `parentId` is not present in the input is treated
as a root rather than rejected. Partial exports are common (you filtered by
service, or the root span was sampled away), and refusing the whole batch
would be less useful than returning a usable forest. Those spans are also
listed in the `orphans` array so you can tell a genuine root apart from a
dangling reference.

## API

### `buildSpanTree(spans)`

Returns `{ roots, orphans, byId }`. `roots` are top-level nodes with `children`
arrays attached, `orphans` is the subset of roots whose declared parent was
missing, and `byId` is a `Map` from id to node. Input objects are not mutated;
unknown fields are collected under `node.data`.

Throws `SpanTreeError` on duplicate ids, a span that is its own parent, a
cycle, or malformed records.

### `flattenTree(roots)`

Depth-first, pre-order flattening back to a flat array. Parents precede their
children and siblings keep insertion order.

### `findSpan(tree, id)`

Returns the node with that id, or `null`.

### `getPathToSpan(tree, id)`

Returns the ancestor chain from the root down to the span, inclusive, or `null`
for an unknown id. Orphans produce a one-element chain.

## The awkward edge

A cycle in the input (`a` parented by `b`, `b` parented by `a`) cannot be
attached into a tree at all. Rather than loop forever in a later traversal, the
builder detects it and throws. If you have already seen a hang in a trace
viewer, this is the failure mode it was hiding.
