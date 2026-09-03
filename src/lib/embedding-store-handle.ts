/**
 * Stable handle-oriented entrypoint for the embedding store.
 *
 * The implementation lives in `embedding-store.ts`; semantic production code
 * imports through this module so the handle boundary is explicit and test
 * compatibility shims cannot accidentally become a production dependency.
 */
export * from "./embedding-store.js";
