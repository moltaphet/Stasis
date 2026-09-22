# Stasis Protocol developer gates.
# Usage: make ascii | make lint | make test | make profile | make integration | make gate

CONTRACTS := contracts/stasis_guardian.py contracts/reference_vault.py

# The Consensus v0.6 preview. "studionet" is stable Studio and is deliberately
# not the default here: a v0.6 build must be validated against the v0.6 network.
NETWORK := studio_devnet

.PHONY: ascii lint test profile integration deploy gate

ascii:
	bash scripts/ascii_scan.sh

lint:
	@for c in $(CONTRACTS); do \
		echo "== genvm-lint lint $$c =="; genvm-lint lint $$c || exit 1; \
		echo "== genvm-lint validate $$c =="; genvm-lint validate $$c || exit 1; \
	done

test:
	pytest tests/direct/ -v

# Re-measure the transaction fee profile from real finalized transactions and
# rewrite fee-profile.json. Run this whenever contract code, GenVM, Studio, or the
# fee policy changes: the frontend submits an estimate derived from this file, so a
# stale profile under-allocates and the network rejects the write before the
# contract runs.
profile:
	NO_PROXY="*" gltest tests/integration/ --network $(NETWORK) --fee-profile fee-profile.json

integration:
	NO_PROXY="*" gltest tests/integration/ -v -s --network $(NETWORK)

# Deploys guardian + reference vault (bound to the guardian) and registers the vault. Writes
# deployments/studio-dev.json and prints the addresses for apps/web/.env.local.
deploy:
	STASIS_DEPLOY=1 NO_PROXY="*" gltest tests/integration/test_deploy_studio_dev.py -v -s --network $(NETWORK)

# Full MVP gate: pure ASCII, GenVM lint, then direct-mode tests.
gate: ascii lint test
	@echo "All gates passed."
