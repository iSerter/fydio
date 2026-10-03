/**
 * `@fydio/env` — the single validated source of truth for environment variables.
 *
 * Import from `/server` or `/client` explicitly. The root entrypoint re-exports
 * only the schema (types and validators), never live parsed values, so pulling
 * in the root can never drag a secret into a client bundle by accident.
 */
export {
  clientEnvSchema,
  serverEnvSchema,
  platformKind,
  type ClientEnv,
  type PlatformKind,
  type ServerEnv,
} from './schema.js'

export { formatEnvError, envValidationError } from './errors.js'
