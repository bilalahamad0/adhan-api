#!/usr/bin/env bash
# Vercel "Ignored Build Step" — decides whether a commit needs a deployment.
#
# POLARITY (inverted from shell intuition, do not "fix" this):
#   exit 0 -> build is IGNORED / canceled
#   exit 1 -> build PROCEEDS
#
# Vercel only builds the two @vercel/node entrypoints listed in vercel.json, so
# commits that touch nothing deployable (docs, the Pi service, the GitHub Pages
# HTML) do not need a deployment and would otherwise burn the account's daily
# deploy quota.
#
# FAILS OPEN BY DESIGN: every indeterminate case builds. A wasted build costs a
# quota slot that resets daily; a silently skipped API deploy does not announce
# itself. Only one branch can reach `exit 0`.
#
# Base commit is VERCEL_GIT_PREVIOUS_SHA (last successful deploy of this
# project+branch), never HEAD^. Vercel's published `git diff HEAD^ HEAD` idiom
# is unsafe here: push an api/ fix and a README commit together and Vercel
# deploys once at the tip, where HEAD^ sees only the README and cancels the API
# fix with a green "canceled" badge and no alert.

B=
H=$(git rev-parse HEAD 2>/dev/null)

# Only trust the previous SHA if the object is actually present (shallow clone).
if [ -n "$VERCEL_GIT_PREVIOUS_SHA" ] && git cat-file -e "$VERCEL_GIT_PREVIOUS_SHA^{commit}" 2>/dev/null; then
  B=$(git rev-parse "$VERCEL_GIT_PREVIOUS_SHA")
fi

# No usable base, no HEAD, or a manual redeploy (B == H) -> build.
if [ -z "$B" ] || [ -z "$H" ] || [ "$B" = "$H" ]; then
  echo "BUILD: no usable base (prev=$VERCEL_GIT_PREVIOUS_SHA head=$H)"
  exit 1
fi

# Tripwire: the deny-list below assumes no api/ entrypoint imports code from
# outside api/. If that ever stops being true, stop trusting the deny-list.
if git grep -qE "(from|import\(|require\()[[:space:]]*['\"]\.\./" "$H" -- api/; then
  echo "BUILD: api/ imports outside api/ - deny-list no longer trustworthy"
  exit 1
fi

# Deny-list, not an allow-list: anything NOT named here forces a build, so a new
# top-level module (lib/, src/) is safe by default. Pathspecs are root-anchored
# (':/' + ':(top,exclude)') so the answer does not depend on the Root Directory.
git diff --quiet "$B" "$H" -- ':/' \
  ':(top,exclude)media-caster' \
  ':(top,exclude)docs' \
  ':(top,exclude)scripts' \
  ':(top,exclude)images' \
  ':(top,exclude)icons' \
  ':(top,exclude)archive' \
  ':(top,exclude)scriptable' \
  ':(top,exclude).github' \
  ':(top,exclude)*.md' \
  ':(top,exclude)*.html' \
  ':(top,exclude)ai-metrics.json'
d=$?

if [ "$d" -eq 0 ]; then
  echo "SKIP: only inert paths changed $B..$H"
  exit 0
fi

# 1 = real changes, 128 = bad object / outside shallow window -> both build.
echo "BUILD: deploy-relevant change or git failure (diff exit $d) $B..$H"
exit 1
