# Ansteel Acceptance Package

The `Ansteel governance gate / deterministic governance checks` workflow is the required automated check for changes under the Ansteel paths. It uses only faux/local providers; it is not evidence of a live provider discussion.

Before merging a governance change, the named human release owner records these four items in the pull request:

1. The exact successful workflow run URL and commit SHA.
2. The affected governance rule and its deterministic regression test.
3. Any real-provider smoke result, including provider/model identity, timestamp, report path, and whether the result failed closed. Credentials and raw endpoints are excluded.
4. An explicit acceptance or rejection of residual risk, especially unavailable providers, single-backend configurations, and unperformed live smoke tests.

Repository administrators must configure `Ansteel governance gate / deterministic governance checks` as a required status check for `main`, require one human approval, and disallow self-approval. Those GitHub branch-protection settings are external repository policy and cannot be asserted by source code alone.
