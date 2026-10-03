import base from '@fydio/config-eslint/base'
import nextjs from '@fydio/config-eslint/nextjs'
import react from '@fydio/config-eslint/react'

export default [{ ignores: ['.next/**', 'node_modules/**'] }, ...base, ...react, ...nextjs]
