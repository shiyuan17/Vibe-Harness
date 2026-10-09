# Fixture manifests

Fixture manifests describe disposable workspaces for Internal Harness scenarios. A materializer creates the listed files, initializes the declared Git/process state, applies deterministic fault triggers, and returns an evidence receipt before the Agent starts.

The Agent receives only `files` and the task prompt. `allowedWritePaths`, fault controls, and hidden verifier commands stay in controller-owned state.
