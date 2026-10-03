/**
 * Shared ESLint flat config for Fydio.
 *
 * Re-exported through the package root so every workspace can write
 * `import base from '@fydio/config-eslint'`.
 */
export { default as base } from './base.js'
export { default as nextjs } from './nextjs.js'
export { default as react } from './react.js'
