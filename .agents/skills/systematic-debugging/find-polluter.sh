#!/usr/bin/env bash
# Bisection script to find which test creates unwanted files/state
# Usage: ./find-polluter.sh <file_or_dir_to_check> <test_pattern> [test_command_template]
#   test_command_template defaults to 'npm test {file}'; '{file}' is replaced
#   with each candidate test file (quote the template to keep it one argument).
# Exit codes: 0 = no polluter found, 1 = polluter located (see output).
# Example: ./find-polluter.sh '.git' 'src/**/*.test.ts'
# Example: ./find-polluter.sh '.git' 'src/**/*.test.ts' 'pnpm vitest run {file}'

set -e

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  echo "Usage: $0 <file_or_dir_to_check> <test_pattern> [test_command_template]"
  echo "Example: $0 '.git' 'src/**/*.test.ts'"
  echo "Example: $0 '.git' 'src/**/*.test.ts' 'pnpm vitest run {file}'"
  exit 1
fi

POLLUTION_CHECK="$1"
TEST_PATTERN="$2"
TEST_COMMAND_TEMPLATE="${3:-npm test {file}}"

echo "🔍 Searching for test that creates: $POLLUTION_CHECK"
echo "Test pattern: $TEST_PATTERN"
echo ""

# Get list of test files
TEST_FILES=$(find . -path "$TEST_PATTERN" | sort)
TOTAL=$(echo "$TEST_FILES" | wc -l | tr -d ' ')

echo "Found $TOTAL test files"
echo ""

COUNT=0
for TEST_FILE in $TEST_FILES; do
  COUNT=$((COUNT + 1))

  # Skip if pollution already exists
  if [ -e "$POLLUTION_CHECK" ]; then
    echo "⚠️  Pollution already exists before test $COUNT/$TOTAL"
    echo "   Skipping: $TEST_FILE"
    continue
  fi

  echo "[$COUNT/$TOTAL] Testing: $TEST_FILE"

  # Run the test with the caller's command template ({file} -> this candidate)
  sh -c "${TEST_COMMAND_TEMPLATE//\{file\}/$TEST_FILE}" > /dev/null 2>&1 || true

  # Check if pollution appeared
  if [ -e "$POLLUTION_CHECK" ]; then
    RESOLVED_COMMAND="${TEST_COMMAND_TEMPLATE//\{file\}/$TEST_FILE}"
    echo ""
    echo "🎯 FOUND POLLUTER!"
    echo "   Test: $TEST_FILE"
    echo "   Created: $POLLUTION_CHECK"
    echo ""
    echo "Pollution details:"
    ls -la "$POLLUTION_CHECK"
    echo ""
    echo "To investigate:"
    echo "  $RESOLVED_COMMAND    # Run just this test"
    echo "  cat $TEST_FILE         # Review test code"
    exit 1
  fi
done

echo ""
echo "✅ No polluter found - all tests clean!"
exit 0
