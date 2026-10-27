#!/usr/bin/env bash
# Bisection script to find which test creates unwanted files/state.
#
# Usage: ./find-polluter.sh <file_or_dir_to_check> <test_pattern> [test_command_template]
#   Both are resolved from the current directory. The pattern may be written with or
#   without a leading './'; '**' matches zero or more directories.
#   test_command_template defaults to 'npm test {file}'. '{file}' must be a whole
#   argument and is replaced with the candidate path, which is passed as one argument
#   and never re-quoted or redirected. A template without '{file}' runs unchanged for
#   every candidate.
#
# Exit codes:
#   0 = every candidate ran and none of them created the pollution
#   1 = a polluter was located (its path and command are printed)
#   2 = no verdict was reached: bad arguments, an unsupported command template, zero
#       matching candidates, pollution present before the run, or a test command that
#       failed without producing the pollution
#
# Example: ./find-polluter.sh '.git' 'src/**/*.test.ts'
# Example: ./find-polluter.sh '.git' 'src/**/*.test.ts' 'pnpm vitest run {file}'

set -u

usage() {
  echo "Usage: $0 <file_or_dir_to_check> <test_pattern> [test_command_template]"
  echo "Example: $0 '.git' 'src/**/*.test.ts'"
  echo "Example: $0 '.git' 'src/**/*.test.ts' 'pnpm vitest run {file}'"
}

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  usage
  exit 2
fi

POLLUTION_CHECK="$1"
# 'find .' produced './src/a.test.ts' while the documented pattern was
# 'src/**/*.test.ts', so a bare -path comparison matched nothing and the run
# reported clean. The pattern is normalised once, here.
TEST_PATTERN="${2#./}"
DEFAULT_TEST_COMMAND_TEMPLATE='npm test {file}'
# The default has to be assigned first: `"${3:-npm test {file}}"` ends the parameter
# expansion at the brace inside '{file}' and appends a literal '}' to every custom
# command, so `touch pollution.txt` created `pollution.txt}`.
TEST_COMMAND_TEMPLATE="${3:-$DEFAULT_TEST_COMMAND_TEMPLATE}"

if [ -z "$TEST_PATTERN" ]; then
  echo "❌ Test pattern is empty; a run over no candidates proves nothing."
  usage
  exit 2
fi

if [ -e "$POLLUTION_CHECK" ]; then
  echo "❌ $POLLUTION_CHECK already exists before the run."
  echo "   Remove it first, or the script cannot tell its own candidates apart from the baseline."
  exit 2
fi

echo "🔍 Searching for test that creates: $POLLUTION_CHECK"
echo "Test pattern: $TEST_PATTERN"
echo "Test command: $TEST_COMMAND_TEMPLATE"
echo ""

# Converts the template into an argument vector. Only literal quoting is honoured:
# shell expansion, pipes, redirection and command chaining are rejected rather than
# handed to a shell, so a template cannot silently become a different command.
parse_test_command_template() {
  TEMPLATE_ARGS=()
  local text="$1"
  local quote=''
  local token=''
  local index character escaped
  for (( index=0; index<${#text}; index++ )); do
    character="${text:index:1}"
    if [ -n "$quote" ]; then
      if [ "$character" = '\\' ]; then
        index=$((index + 1))
        token+="${text:index:1}"
        continue
      fi
      if [ "$character" = "$quote" ]; then
        quote=''
        continue
      fi
      token+="$character"
      continue
    fi
    case "$character" in
      "'"|'"') quote="$character" ;;
      '\\') index=$((index + 1)); token+="${text:index:1}" ;;
      ' '|$'\t') if [ -n "$token" ]; then TEMPLATE_ARGS+=("$token"); token=''; fi ;;
      '$'|'`'|'|'|'&'|';'|'<'|'>'|'('|')'|'*'|'?'|'['|']'|'~'|'!'|$'\n'|$'\r')
        echo "❌ Unsupported character in test command template: $character"
        echo "   Quote arguments instead of relying on shell expansion, piping or redirection."
        exit 2
        ;;
      *) token+="$character" ;;
    esac
  done
  if [ -n "$quote" ]; then
    echo "❌ Unterminated quote in test command template: $TEST_COMMAND_TEMPLATE"
    exit 2
  fi
  if [ -n "$token" ]; then TEMPLATE_ARGS+=("$token"); fi
  if [ "${#TEMPLATE_ARGS[@]}" -eq 0 ]; then
    echo "❌ Test command template is empty."
    exit 2
  fi
}

parse_test_command_template "$TEST_COMMAND_TEMPLATE"

PLACEHOLDER_COUNT=0
for word in "${TEMPLATE_ARGS[@]}"; do
  case "$word" in
    '{file}') PLACEHOLDER_COUNT=$((PLACEHOLDER_COUNT + 1)) ;;
    *'{file}'*)
      echo "❌ '{file}' must be a complete argument, but '$word' embeds it in a larger word."
      exit 2
      ;;
  esac
done

if [ "$PLACEHOLDER_COUNT" -gt 1 ]; then
  echo "❌ '{file}' may appear once at most."
  exit 2
fi

# Globstar gives '**' its zero-or-more-directory meaning; nullglob makes a pattern
# that matches nothing an empty list instead of a literal path that later trips over
# a missing file. The glob is expanded with a newline-only IFS so a pattern containing
# a space stays one word and matched paths stay whole.
shopt -s globstar nullglob 2>/dev/null || true
if [[ "$TEST_PATTERN" = /* ]]; then
  glob_pattern="$TEST_PATTERN"
else
  glob_pattern="./$TEST_PATTERN"
fi

previous_ifs="$IFS"
IFS=$'\n'
# shellcheck disable=SC2206 # unquoted on purpose: this is the glob expansion.
candidates=($glob_pattern)
IFS="$previous_ifs"

TEST_FILES=()
if [ "${#candidates[@]}" -gt 0 ]; then
  for candidate in "${candidates[@]}"; do
    [ -f "$candidate" ] || continue
    TEST_FILES+=("$candidate")
  done
fi

TOTAL="${#TEST_FILES[@]}"
if [ "$TOTAL" -eq 0 ]; then
  echo "❌ No test files matched '$TEST_PATTERN' from $(pwd)."
  echo "   A pattern that matches nothing cannot prove the workspace is clean; fix the pattern."
  exit 2
fi

echo "Found $TOTAL test files"
echo ""

COUNT=0
for TEST_FILE in "${TEST_FILES[@]}"; do
  COUNT=$((COUNT + 1))
  echo "[$COUNT/$TOTAL] Testing: $TEST_FILE"

  COMMAND_ARGS=()
  for word in "${TEMPLATE_ARGS[@]}"; do
    if [ "$word" = '{file}' ]; then
      COMMAND_ARGS+=("$TEST_FILE")
    else
      COMMAND_ARGS+=("$word")
    fi
  done

  TEST_EXIT=0
  "${COMMAND_ARGS[@]}" >/dev/null 2>&1 || TEST_EXIT=$?

  if [ -e "$POLLUTION_CHECK" ]; then
    RESOLVED_COMMAND="$TEST_COMMAND_TEMPLATE"
    if [ "$PLACEHOLDER_COUNT" -eq 1 ]; then
      RESOLVED_COMMAND="${TEST_COMMAND_TEMPLATE//\{file\}/$TEST_FILE}"
    fi
    echo ""
    echo "🎯 FOUND POLLUTER!"
    echo "   Test: $TEST_FILE"
    echo "   Created: $POLLUTION_CHECK"
    echo ""
    echo "Pollution details:"
    ls -la -- "$POLLUTION_CHECK"
    echo ""
    echo "To investigate:"
    echo "  $RESOLVED_COMMAND    # Run just this test"
    echo "  cat $TEST_FILE         # Review test code"
    exit 1
  fi

  if [ "$TEST_EXIT" -ne 0 ]; then
    echo "❌ Test command exited $TEST_EXIT for $TEST_FILE without creating $POLLUTION_CHECK."
    echo "   The run ended early, so the remaining candidates were not checked."
    exit 2
  fi
done

echo ""
echo "✅ No polluter found - all $TOTAL candidates ran without creating $POLLUTION_CHECK."
exit 0
