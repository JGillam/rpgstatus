// Barrel for the shared domain module. Import types + constants + helpers from here.
// Stays pure (frontend-safe): no auth/* re-exports — token crypto uses node:crypto.
export * from './types';
export * from './constants';
export * from './conditions';
export * from './logic';
export * from './authz';
