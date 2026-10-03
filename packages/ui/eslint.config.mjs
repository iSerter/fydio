import base from '@fydio/config-eslint/base'
import react from '@fydio/config-eslint/react'

export default [{ ignores: ['dist/**', 'coverage/**'] }, ...base, ...react]
