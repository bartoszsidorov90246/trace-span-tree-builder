import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSpanTree,
  flattenTree,
  findSpan,
  getPathToSpan,
  SpanTreeError,
} from '../src/index.js';

// Helper: build a minimal span record. Keeping the shape in one place makes
// the tests readable and means a schema change is a one-line edit.
function span(id, parentId, extra = {}) {
  return { id, parentId, name: id, startTime: 0, duration: 1, ...extra };
}

test('builds a simple parent-child tree', () => {
  const tree = buildSpanTree([
    span('root', null),
    span('child-a', 'root'),
    span('child-b', 'root'),
    span('grandchild', 'child-a'),
  ]);

  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].id, 'root');
  assert.equal(tree.roots[0].children.length, 2);
  assert.equal(tree.roots[0].children[0].id, 'child-a');
  assert.equal(tree.roots[0].children[0].children[0].id, 'grandchild');
  assert.equal(tree.orphans.length, 0);
});

test('accepts children that appear before their parents', () => {
  const tree = buildSpanTree([
    span('grandchild', 'child'),
    span('child', 'root'),
    span('root', null),
  ]);

  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0].id, 'root');
  assert.equal(tree.roots[0].children[0].id, 'child');
  assert.equal(tree.roots[0].children[0].children[0].id, 'grandchild');
});

test('treats a missing parent as a root and records it as an orphan', () => {
  const tree = buildSpanTree([
    span('a', 'missing'),
    span('b', null),
  ]);

  assert.equal(tree.roots.length, 2);
  assert.equal(tree.orphans.length, 1);
  assert.equal(tree.orphans[0].id, 'a');
  assert.equal(tree.orphans[0].parentId, 'missing');
  assert.equal(tree.byId.get('a').parentId, 'missing');
});

test('throws on duplicate ids', () => {
  assert.throws(
    () => buildSpanTree([span('dup', null), span('dup', null)]),
    (err) => err instanceof SpanTreeError && /duplicate/.test(err.message),
  );
});

test('throws when a span is its own parent', () => {
  assert.throws(
    () => buildSpanTree([span('self', 'self')]),
    (err) => err instanceof SpanTreeError && /own parent/.test(err.message),
  );
});

test('throws on a cycle between two spans', () => {
  assert.throws(
    () => buildSpanTree([span('a', 'b'), span('b', 'a')]),
    (err) => err instanceof SpanTreeError && /cycle/.test(err.message),
  );
});

test('throws on invalid span shapes', () => {
  assert.throws(() => buildSpanTree([null]), SpanTreeError);
  assert.throws(() => buildSpanTree([{ id: '' }]), SpanTreeError);
  assert.throws(() => buildSpanTree([{ id: 1 }]), SpanTreeError);
  assert.throws(() => buildSpanTree([span('a', 42)]), SpanTreeError);
  assert.throws(() => buildSpanTree([span('a', null, { name: 7 })]), SpanTreeError);
  assert.throws(() => buildSpanTree([span('a', null, { startTime: 'x' })]), SpanTreeError);
  assert.throws(() => buildSpanTree('not an array'), SpanTreeError);
});

test('flattenTree returns nodes in pre-order', () => {
  const tree = buildSpanTree([
    span('root', null),
    span('a', 'root'),
    span('b', 'root'),
    span('a1', 'a'),
  ]);
  const flat = flattenTree(tree.roots);
  assert.deepEqual(
    flat.map((n) => n.id),
    ['root', 'a', 'a1', 'b'],
  );
});

test('flattenTree handles an empty forest', () => {
  assert.deepEqual(flattenTree([]), []);
});

test('findSpan returns the node or null', () => {
  const tree = buildSpanTree([span('root', null), span('child', 'root')]);
  assert.equal(findSpan(tree, 'child').id, 'child');
  assert.equal(findSpan(tree, 'nope'), null);
  assert.throws(() => findSpan(tree, 5), SpanTreeError);
  assert.throws(() => findSpan({}, 'child'), SpanTreeError);
});

test('getPathToSpan returns the root-to-span chain', () => {
  const tree = buildSpanTree([
    span('root', null),
    span('a', 'root'),
    span('a1', 'a'),
  ]);
  const path = getPathToSpan(tree, 'a1');
  assert.deepEqual(path.map((n) => n.id), ['root', 'a', 'a1']);
});

test('getPathToSpan returns null for an unknown id', () => {
  const tree = buildSpanTree([span('root', null)]);
  assert.equal(getPathToSpan(tree, 'missing'), null);
});

test('getPathToSpan works for orphans', () => {
  const tree = buildSpanTree([span('orphan', 'gone')]);
  const path = getPathToSpan(tree, 'orphan');
  assert.deepEqual(path.map((n) => n.id), ['orphan']);
});

test('extra fields are preserved under data without mutating the input', () => {
  const raw = span('root', null, { service: 'api', tags: ['x'] });
  const tree = buildSpanTree([raw]);
  const node = findSpan(tree, 'root');
  assert.equal(node.data.service, 'api');
  assert.deepEqual(node.data.tags, ['x']);
  // The original object must not have gained a children array.
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'children'), false);
});

test('multiple roots are all returned', () => {
  const tree = buildSpanTree([span('r1', null), span('r2', null), span('c', 'r1')]);
  assert.deepEqual(tree.roots.map((n) => n.id), ['r1', 'r2']);
});

test('an empty input yields an empty forest', () => {
  const tree = buildSpanTree([]);
  assert.deepEqual(tree.roots, []);
  assert.deepEqual(tree.orphans, []);
  assert.equal(tree.byId.size, 0);
});
