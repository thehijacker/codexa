// Frontend logger — gated by window.__DEBUG (injected by server from DEBUG env var).
// log() is a no-op in production; warn/error always emit.
const _dbg = typeof window !== 'undefined' && window.__DEBUG === true;
export const log   = _dbg ? console.log.bind(console)   : () => {};
export const warn  = console.warn.bind(console);
export const error = console.error.bind(console);
