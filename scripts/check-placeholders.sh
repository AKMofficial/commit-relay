#!/usr/bin/env bash
# De-branding gate. Matches SHAPES, never brand strings: a tracked denylist of the
# owner's org and room names would publish exactly what it exists to suppress.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

status=0

fail() {
  status=1
  printf '%s\n' "FAIL: $1"
  shift
  printf '%s\n' "$@"
}

# Trees that are not source: vendored code, build output, the lockfile, the
# runtime types Cloudflare generates into worker-configuration.d.ts, and the
# design document, which quotes every shape this script looks for.
EXCLUDE_FILES='^\./(pnpm-lock\.yaml|SPEC\.md|worker-configuration\.d\.ts)$|^\./(node_modules|\.git|dist|\.wrangler|coverage)/'

# The file list comes from git, not from `find`: the gate must judge what the
# repository publishes, and a gitignored local artifact can never be committed.
tracked_files() {
  git ls-files --cached --others --exclude-standard -z |
    tr '\0' '\n' | sed 's|^|./|' | grep -Ev "$EXCLUDE_FILES"
}

runtime_sources() {
  find ./src -type f -name '*.ts' ! -name '*.test.ts' -print 2>/dev/null
}

# Rules 3 and 4 are about values that ship, not prose: strip comments first so an
# explanatory comment naming the forbidden shape is not itself a violation.
strip_comments() {
  sed -E -e 's,(^|[^:])//.*$,\1,' -e 's,/\*.*\*/,,' -e 's,^[[:space:]]*\*.*$,,' -e 's,/\*.*$,,'
}

# ── Rule 1: no identity-shaped literal outside the sanctioned placeholder set ──
# Sanctioned: this project's own identity (AKMofficial/commit-relay, the lowercased
# GHCR form akmofficial/commit-relay, @AKMofficial, organizations/AKMofficial) plus the
# fixture placeholders your-org/your-repo, 1234567, 2345678, 7654321, Jane Doe/jane-doe/
# jane@example.com, Sam Lee/sam-lee/sam@example.com, dependabot[bot], @your-handle.
# Anything else org- or handle-shaped is a leak and fails.

# 1a. An email address on a domain that is not reserved for documentation: an RFC
#     2606 domain is never a real mailbox, and fixtures carry GitHub's noreply one.
bad_emails=$(
  tracked_files | while read -r f; do
    grep -IEon '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$f" |
      sed "s|^|$f:|"
  done | grep -Ev '@(example\.(com|net|org)|[A-Za-z0-9.-]+\.(invalid|test|example)|localhost|(users\.noreply\.)?github\.com)$'
)
[ -n "$bad_emails" ] && fail "email address on a real domain (rule 1)" "$bad_emails"

# 1b. A github.com/<owner>/<repo> path naming anything but the placeholder repo.
#     LICENSE and CODE_OF_CONDUCT.md quote third-party documents verbatim, and the
#     exclusion anchors the whole pair: either half being real is the leak.
bad_repo_urls=$(
  tracked_files | grep -Ev '^\./(LICENSE|CODE_OF_CONDUCT\.md)$' | while read -r f; do
    grep -IEon '//github\.com/[A-Za-z0-9_.-]{3,}/[A-Za-z0-9_.-]{3,}' "$f" | sed "s|^|$f:|"
  done | grep -Ev '//github\.com/(your-org/your-repo(\.git)?|organizations/your-org|AKMofficial/commit-relay(\.git)?|organizations/AKMofficial)$'
)
[ -n "$bad_repo_urls" ] && fail "repository slug outside the placeholder set (rule 1)" "$bad_repo_urls"

# 1c. A CODEOWNERS owner that is not the placeholder handle, and never an email.
if [ -f .github/CODEOWNERS ]; then
  bad_owners=$(grep -Eon '(@[A-Za-z0-9/_-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)' .github/CODEOWNERS |
    grep -Ev ':@(your-handle|AKMofficial)$')
  [ -n "$bad_owners" ] && fail "CODEOWNERS entry outside the placeholder set (rule 1)" "$bad_owners"
fi

# 1d. ACCOUNT_ID as the VALUE of a variable. BASECAMP_ACCOUNT_ID is validated as
#     ^\d{1,20}$, so the literal fails at boot; it is only ever a URL path segment.
account_id_values=$(
  grep -rEn '^[^#]*[A-Z_]*ACCOUNT_ID[A-Za-z_]*[[:space:]]*[:=][[:space:]]*"?'"'"'?ACCOUNT_ID' \
    .env.example .dev.vars.example wrangler.jsonc wrangler.toml docker-compose.yml docker-compose.yaml \
    2>/dev/null
  grep -rEn 'docker run.*ACCOUNT_ID=ACCOUNT_ID' --include='*.md' . 2>/dev/null
)
[ -n "$account_id_values" ] && fail "ACCOUNT_ID used as a value, not a path segment (rule 1)" "$account_id_values"

# ── Rule 2: no literal numeric id of 7 or more digits ─────────────────────────
# Allowed: the test and docs trees, the three sanctioned ids, digit runs inside a
# longer token, all-zero runs, and the three documented byte budgets, named one by one.
BYTE_BUDGETS=' 1048576 33554432 26214400 '
long_numbers=$(
  tracked_files | grep -Ev '^\./(tests|docs)/|\.test\.ts$' | while read -r f; do
    # The token, not the digit run: consuming the surrounding [0-9A-Za-z_] run keeps
    # hash digits out without swallowing the delimiter between two literals on a line.
    grep -IEon '[0-9A-Za-z_]*[0-9]{7,}[0-9A-Za-z_]*' "$f" | sed "s|^|$f:|"
  done | while IFS= read -r hit; do
    n=${hit##*:}
    # Part of a longer token: a hash, a pinned SHA, a placeholder key.
    case "$n" in (*[!0-9]*) continue ;; esac
    case "$n" in (*[!0]*) ;; (*) continue ;; esac
    if [ "$n" = 1234567 ] || [ "$n" = 2345678 ] || [ "$n" = 7654321 ]; then continue; fi
    # Timestamp-shaped: 10-digit seconds or 13-digit milliseconds since the epoch.
    if [ "${#n}" -eq 10 ] || [ "${#n}" -eq 13 ]; then continue; fi
    # SHA-shaped: a 40-character run.
    if [ "${#n}" -eq 40 ]; then continue; fi
    case "$BYTE_BUDGETS" in (*" $n "*) continue ;; esac
    printf '%s\n' "$hit"
  done
)
[ -n "$long_numbers" ] && fail "numeric literal of 7+ digits outside the sanctioned set (rule 2)" "$long_numbers"

# ── Rule 3: no unresolved placeholder ships in a runtime default ──────────────
# `<owner>`/`<handle>`/`<sha>` are matched after comment-stripping, since a doc comment
# may explain them; TODO/FIXME are matched raw, as they live in comments by definition.
unresolved=$(
  runtime_sources | while read -r f; do
    strip_comments <"$f" | grep -En '<owner>|<handle>|<sha>' | sed "s|^|$f:|"
    grep -En 'TODO|FIXME' "$f" | sed "s|^|$f:|"
  done
)
[ -n "$unresolved" ] && fail "unresolved placeholder or TODO in src/** (rule 3)" "$unresolved"

# ── Rule 4: every outbound host is on a short allowlist ───────────────────────
# api.github.com and 3.basecampapi.com are the two services; github.com is the default
# GITHUB_WEB_ORIGIN. Loopback is allowed so an example can point at the bundled mock.
bad_hosts=$(
  runtime_sources | while read -r f; do
    strip_comments <"$f" | grep -Eon 'https?://[A-Za-z0-9._-]+' | sed "s|^|$f:|"
  done | grep -Ev '//(api\.github\.com|3\.basecampapi\.com|github\.com|localhost|127\.0\.0\.1)$'
)
[ -n "$bad_hosts" ] && fail "outbound host off the allowlist in src/** (rule 4)" "$bad_hosts"

# ── Rule 4b: no BASECAMP_* key in a committed vars block ──────────────────────
# wrangler.jsonc is published by a public fork, so a Basecamp value in "vars" ships
# with it. Placeholders included: a stale fork must fail closed at boot rather than start.
vars_block=$(
  for f in wrangler.jsonc wrangler.toml docker-compose.yml docker-compose.yaml; do
    [ -f "$f" ] || continue
    awk -v file="$f" '
      /"vars"[[:space:]]*:|^[[:space:]]*\[vars\]|^[[:space:]]*environment[[:space:]]*:/ { inblock = 1; depth = 0 }
      inblock && /BASECAMP_/ { print file ":" NR ":" $0 }
      inblock && /^[[:space:]]*(\}|\]|[a-z_]+:)/ && NR > 1 && depth == 0 && !/vars|environment/ { inblock = 0 }
    ' "$f"
  done
)
[ -n "$vars_block" ] && fail "BASECAMP_ key inside a committed vars block (rule 4b)" "$vars_block"

# ── Rule 10: the build context cannot carry a secret the repo already ignores ──
# The context is uploaded to the builder even for files the Dockerfile never COPYs,
# so .dockerignore must cover every secret entry .gitignore covers, matched as globs.
covered_by() {
    while IFS= read -r pattern; do
    pattern=${pattern%"${pattern##*[![:space:]]}"}
    case "$pattern" in ''|'#'*|'!'*) continue ;; esac
    # shellcheck disable=SC2254 # the ignore line is deliberately used as a glob.
    case "$2" in $pattern) return 0 ;; esac
  done <"$1"
  return 1
}

# Secret-ish patterns from .gitignore, each mapped to a concrete probe path.
gitignore_secret_probes() {
  awk '
    /^!/ { next }
    /^#/ { next }
    /^$/ { next }
    /^node_modules/ { next }
    /^coverage/ { next }
    /^\.wrangler/ { next }
    /^dist/ { next }
    /^tmp/ { next }
    { print }
  ' .gitignore
}

probe_for_pattern() {
  local pattern="$1"
  case "$pattern" in
    .env) printf '%s\n' .env; return 0 ;;
    .env.*) printf '%s\n' .env.local; return 0 ;;
    .dev.vars) printf '%s\n' .dev.vars; return 0 ;;
    .dev.vars.*) printf '%s\n' .dev.vars.local; return 0 ;;
    '*config*.json') printf '%s\n' config.json; return 0 ;;
  esac

  # No glob metacharacters: the pattern itself is the probe path.
  case "$pattern" in *'*'*|*'?'*|*'['*) ;; *)
    printf '%s\n' "${pattern%/}"
    return 0
  esac

  # prefix.* -> prefix.local (e.g. a future .secrets.* line).
  case "$pattern" in
    *'.*')
      local prefix="${pattern%.*}"
      case "$prefix" in *'*'*|*'?'*|*'['*) ;; *)
        printf '%s\n' "${prefix}.local"
        return 0
      esac
      ;;
  esac

  # *.suffix -> probe.suffix (e.g. *.pem).
  case "$pattern" in
    *.'*')
      local ext="${pattern#*.}"
      case "$ext" in *'*'*|*'?'*|*'['*|*'/'*) ;; *)
        printf '%s\n' "probe.${ext}"
        return 0
      esac
      ;;
  esac

  # *middle*.ext -> middle.ext (e.g. *config*.json without the hardcoded case above).
  case "$pattern" in
    *'*'*'*'*)
      local inner="${pattern#\*}"
      inner="${inner%%\*}"
      local tail="${pattern#*"$inner"*}"
      case "$inner" in *'*'*|*'?'*|*'['*|'') ;; *)
        case "$tail" in
          .*|*/*) printf '%s\n' "${inner}${tail}"; return 0 ;;
        esac
      esac
      ;;
  esac

  # *middle* with no extra stars in the middle.
  case "$pattern" in
    *'*'*)
      local middle="${pattern#\*}"
      middle="${middle%\*}"
      case "$middle" in *'*'*|*'?'*|*'['*|'') ;; *)
        printf '%s\n' "$middle"
        return 0
      esac
      ;;
  esac

  return 1
}

missing_ignores=""
unprobeable=""
while IFS= read -r pattern; do
  [ -z "$pattern" ] && continue
  probe="$(probe_for_pattern "$pattern")" || {
    unprobeable="${unprobeable}cannot derive a probe for gitignore pattern: ${pattern}"$'\n'
    continue
  }
  covered_by .gitignore "$probe" || missing_ignores="$missing_ignores.gitignore no longer ignores $probe (pattern ${pattern})"$'\n'
  covered_by .dockerignore "$probe" || missing_ignores="$missing_ignores.dockerignore does not ignore $probe (pattern ${pattern})"$'\n'
done < <(gitignore_secret_probes)
[ -n "$unprobeable" ] && fail "rule 10 gitignore pattern has no probe" "$unprobeable"
[ -n "$missing_ignores" ] && fail ".dockerignore is not a superset of .gitignore's secret entries (rule 10)" "$missing_ignores"

if [ "$status" -eq 0 ]; then
  echo "check-placeholders: ok"
fi
exit "$status"
