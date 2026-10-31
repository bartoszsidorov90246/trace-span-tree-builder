// Public entry point for trace-span-tree-builder.
//
// Everything consumers are expected to use is re-exported here so that the
// internal layout of src/ can change without breaking imports. The split
// between index.js and core.js is deliberate: core.js holds the algorithm and
// its data shapes, index.js is the stable facade.

export {
  buildSpanTree,
  flattenTree,
  findSpan,
  getPathToSpan,
  SpanTreeError,
} from './core.js';
