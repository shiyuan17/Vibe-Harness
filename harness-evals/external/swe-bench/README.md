# SWE-bench adapters

`sweBenchAdapter` plans the official `python -m swebench.harness.run_evaluation` command. Predictions remain in the official JSONL format. The plan pins one instance and sets `--max_workers 1`.

`sweBenchLiveAdapter` plans the official repository's `python -m evaluation.evaluation` command. Its prediction file uses the official JSON object keyed by instance ID. It sets `--workers 1` and `--overwrite 0` so existing evidence is not silently replaced.

Both adapters derive a unique run ID from the prediction patch hash and all verifier inputs. Reusing a run ID for a different patch is unsafe because SWE-bench caches by run ID and instance ID. The runner should clone or install the exact upstream revision from the manifest and verify gold/empty-patch controls before approving a sample.
