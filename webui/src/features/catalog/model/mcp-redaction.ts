const SENSITIVE_KEY =
  '(?:access[-_]?token|api[-_]?key|client[-_]?secret|password|passwd|secret|token|auth(?:orization)?|credential|private[-_]?key)'
const QUERY_SECRET = new RegExp(`([?&]${SENSITIVE_KEY}=)[^&#\\s]+`, 'gi')
const AUTH_ASSIGNMENT_SECRET = /\b(authorization\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;&]+/gi
const ASSIGNMENT_SECRET = new RegExp(
  `((?:["']?\\b${SENSITIVE_KEY}\\b["']?)\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&]+)`,
  'gi',
)
const FLAG_SECRET = new RegExp(`(--${SENSITIVE_KEY}(?:=|\\s+))("[^"]*"|'[^']*'|[^\\s,;&]+)`, 'gi')
const SENSITIVE_FLAG_ONLY = new RegExp(`^--${SENSITIVE_KEY}$`, 'i')
const USERINFO_SECRET = /(https?:\/\/)([^/\s:@]+(?::[^/\s@]*)?@)/gi
const AUTH_HEADER_SECRET = /\b(Bearer|Basic)\s+[^\s"']+/gi
const UNIX_HOME_PATH = /\/(?:home|Users)\/[^/\s]+(?=\/)/g
const WINDOWS_HOME_PATH = /\b[A-Za-z]:\\Users\\[^\\\s]+(?=\\)/gi

export function redactMcpSecrets(raw: string) {
  const value = raw.trim()
  if (!value) return '—'

  return value
    .replace(UNIX_HOME_PATH, '~')
    .replace(WINDOWS_HOME_PATH, '~')
    .replace(USERINFO_SECRET, '$1[redacted]@')
    .replace(QUERY_SECRET, '$1[redacted]')
    .replace(AUTH_ASSIGNMENT_SECRET, '$1[redacted]')
    .replace(ASSIGNMENT_SECRET, '$1[redacted]')
    .replace(FLAG_SECRET, '$1[redacted]')
    .replace(AUTH_HEADER_SECRET, '$1 [redacted]')
}

export function redactMcpArgs(args: readonly string[]) {
  let redactNext = false
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false
      return '[redacted]'
    }

    const trimmed = arg.trim()
    if (SENSITIVE_FLAG_ONLY.test(trimmed)) redactNext = true
    return redactMcpSecrets(arg)
  })
}
