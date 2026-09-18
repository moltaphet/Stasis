# Stasis Protocol developer gates.
# Usage: make ascii | make lint | make test | make gate

CONTRACTS := contracts/stasis_guardian.py contracts/mock_vault.py

.PHONY: ascii lint test gate

ascii:
	bash scripts/ascii_scan.sh

lint:
	@for c in $(CONTRACTS); do echo "== genvm-lint check $$c =="; genvm-lint check $$c || exit 1; done

test:
	pytest tests/direct/ -v

# Full MVP gate: pure ASCII, GenVM lint, then direct-mode tests.
gate: ascii lint test
	@echo "All gates passed."
